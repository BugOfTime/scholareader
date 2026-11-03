// Find a link to the original for each reference that has none.
// Order: DOI or arXiv id printed in the reference -> Crossref title search ->
// Semantic Scholar title match. A search hit is only used when its title
// matches the reference's title, so a wrong paper is never linked.

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;
const ARXIV_RE = /(?:arxiv(?:\.org\/(?:abs|pdf)\/|:\s*|\s+preprint\s+arxiv:?\s*))(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i;
const BASES = { crossref: 'https://api.crossref.org', s2: 'https://api.semanticscholar.org' };
const UA = 'Scholareader/0.1 (https://github.com/BugOfTime/scholareader)';

function cleanDoi(d) { return d.replace(/[.,;)\]}]+$/, ''); }

function fromText(text) {
  const d = DOI_RE.exec(text);
  if (d) return { url: `https://doi.org/${cleanDoi(d[1])}`, source: 'doi' };
  const a = ARXIV_RE.exec(text);
  if (a) return { url: `https://arxiv.org/abs/${a[1]}`, source: 'arxiv' };
  return null;
}

function norm(t) {
  return String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
}
// Share of words two titles have in common (0..1).
function titleMatch(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const wa = new Set(A.split(' ')), wb = new Set(B.split(' '));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size);
}
const GOOD = 0.85;

// Returns parsed JSON, null for "nothing found" (404), or throws when the
// service could not be reached, so the reference is tried again next time.
async function getJSON(fetchFn, url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function crossref(fetchFn, ref, timeoutMs, bases) {
  const q = encodeURIComponent((ref.text || ref.title).slice(0, 400));
  const j = await getJSON(fetchFn, `${bases.crossref}/works?query.bibliographic=${q}&rows=3&select=DOI,title`, timeoutMs);
  const items = (j && j.message && j.message.items) || [];
  for (const it of items) {
    const title = Array.isArray(it.title) ? it.title[0] : it.title;
    if (it.DOI && titleMatch(title, ref.title) >= GOOD) return { url: `https://doi.org/${it.DOI}`, source: 'crossref' };
  }
  return null;
}

async function semanticScholar(fetchFn, ref, timeoutMs, bases) {
  const q = encodeURIComponent(ref.title.slice(0, 300));
  const j = await getJSON(fetchFn, `${bases.s2}/graph/v1/paper/search/match?query=${q}&fields=title,externalIds,url`, timeoutMs);
  const it = j && Array.isArray(j.data) ? j.data[0] : null;
  if (!it || titleMatch(it.title, ref.title) < GOOD) return null;
  const ids = it.externalIds || {};
  if (ids.DOI) return { url: `https://doi.org/${ids.DOI}`, source: 'semanticscholar' };
  if (ids.ArXiv) return { url: `https://arxiv.org/abs/${ids.ArXiv}`, source: 'semanticscholar' };
  if (it.url) return { url: it.url, source: 'semanticscholar' };
  return null;
}

// Mutates refs in place; returns { refs, unreachable }. Each ref gets `lookup`: 'found' | 'none' and, when found, `url` + `url_source`.
async function resolveReferences(refs, { fetchFn = fetch, concurrency = 4, timeoutMs = 10000, onProgress = () => {}, bases = BASES } = {}) {
  const todo = refs.filter((r) => !r.url && !r.lookup);
  let i = 0, done = 0, unreachable = 0;
  async function worker() {
    while (i < todo.length) {
      const r = todo[i++];
      let hit = fromText(r.text || ''), failed = false;
      if (!hit && r.title && r.title.length >= 8) {
        for (const svc of [crossref, semanticScholar]) {
          try { hit = await svc(fetchFn, r, timeoutMs, bases); } catch { failed = true; }
          if (hit) break;
        }
      }
      if (hit) { r.url = hit.url; r.url_source = hit.source; r.lookup = 'found'; }
      else if (!failed) r.lookup = 'none'; // offline or rate limited: leave it for next time
      else unreachable++;
      onProgress(++done, todo.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return { refs, unreachable };
}

// True when some references still have no link and were never looked up.
function needsLookup(refs) { return (refs || []).some((r) => !r.url && !r.lookup); }

module.exports = { resolveReferences, needsLookup, fromText, titleMatch };
