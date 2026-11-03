// Find a link to the original for each reference that has none.
// Order: DOI or arXiv id printed in the reference -> Crossref title search ->
// DBLP title search (computer science) -> OpenAlex title search -> Semantic Scholar title match. A search hit is only used when its title
// matches the reference's title, so a wrong paper is never linked.

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/i;
const ARXIV_RE = /(?:arxiv(?:\.org\/(?:abs|pdf)\/|:\s*|\s+preprint\s+arxiv:?\s*))(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i;
const BASES = { crossref: 'https://api.crossref.org', dblp: 'https://dblp.org', openalex: 'https://api.openalex.org', s2: 'https://api.semanticscholar.org' };
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
    // DBLP answers 202 with an HTML bot check from some VPN addresses: treat it as unreachable.
    if (!r.ok || r.status === 202) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      err.retryAfter = Number(r.headers && r.headers.get && r.headers.get('retry-after')) || 0;
      throw err;
    }
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

// DBLP covers computer science venues (NeurIPS, ICML, ACL...) that Crossref often lacks.
async function dblp(fetchFn, ref, timeoutMs, bases, queues) {
  const q = encodeURIComponent(ref.title.slice(0, 300));
  const j = await queues.dblp(() => getJSON(fetchFn, `${bases.dblp}/search/publ/api?q=${q}&format=json&h=5`, timeoutMs));
  let hits = j && j.result && j.result.hits && j.result.hits.hit;
  if (!hits) return null;
  if (!Array.isArray(hits)) hits = [hits];
  for (const h of hits) {
    const it = h.info || {};
    if (titleMatch(it.title, ref.title) < GOOD) continue;
    if (it.doi) return { url: `https://doi.org/${it.doi}`, source: 'dblp' };
    const ee = (Array.isArray(it.ee) ? it.ee : [it.ee]).map((e) => (e && e.text) || e).find((e) => typeof e === 'string' && /^https?:\/\//.test(e));
    if (ee) return { url: ee, source: 'dblp' };
  }
  return null;
}

async function openAlex(fetchFn, ref, timeoutMs, bases, _queues, _gap, keys) {
  const q = encodeURIComponent(ref.title.slice(0, 300).replace(/[,:|]/g, ' '));
  const key = keys.openalex ? `&api_key=${encodeURIComponent(keys.openalex)}` : '';
  const j = await getJSON(fetchFn, `${bases.openalex}/works?search=${q}&per-page=3&select=display_name,doi,ids,primary_location${key}`, timeoutMs);
  for (const it of (j && j.results) || []) {
    if (titleMatch(it.display_name, ref.title) < GOOD) continue;
    if (it.doi) return { url: it.doi.startsWith('http') ? it.doi : `https://doi.org/${it.doi}`, source: 'openalex' };
    const page = it.primary_location && it.primary_location.landing_page_url;
    if (page && /^https?:\/\//.test(page)) return { url: page, source: 'openalex' };
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs calls one at a time, at least gapMs apart. Semantic Scholar allows about
// one request per second without an API key; DBLP asks clients to go slowly too.
function s2Queue(gapMs) {
  let tail = Promise.resolve(), last = 0;
  return (fn) => {
    const run = tail.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { last = Date.now(); }
    });
    tail = run.catch(() => {});
    return run;
  };
}

async function semanticScholar(fetchFn, ref, timeoutMs, bases, queues, gapMs) {
  const queue = queues.s2;
  const q = encodeURIComponent(ref.title.slice(0, 300));
  const url = `${bases.s2}/graph/v1/paper/search/match?query=${q}&fields=title,externalIds,url`;
  let j;
  for (let attempt = 0; ; attempt++) {
    try { j = await queue(() => getJSON(fetchFn, url, timeoutMs)); break; } catch (err) {
      if (err.status !== 429 || attempt >= 2) throw err;
      await sleep(Math.min(10000, (err.retryAfter * 1000) || gapMs * 2 * (attempt + 1)));
    }
  }
  const it = j && Array.isArray(j.data) ? j.data[0] : null;
  if (!it || titleMatch(it.title, ref.title) < GOOD) return null;
  const ids = it.externalIds || {};
  if (ids.DOI) return { url: `https://doi.org/${ids.DOI}`, source: 'semanticscholar' };
  if (ids.ArXiv) return { url: `https://arxiv.org/abs/${ids.ArXiv}`, source: 'semanticscholar' };
  if (it.url) return { url: it.url, source: 'semanticscholar' };
  return null;
}

// Mutates refs in place; returns { refs, unreachable }. Each ref gets `lookup`: 'found' | 'none' and, when found, `url` + `url_source`.
async function resolveReferences(refs, { fetchFn = fetch, concurrency = 4, timeoutMs = 10000, onProgress = () => {}, bases = BASES, s2GapMs = 1100, keys = {} } = {}) {
  bases = { ...BASES, ...bases };
  const queues = { s2: s2Queue(s2GapMs), dblp: s2Queue(Math.min(s2GapMs, 500)) };
  const todo = refs.filter((r) => !r.url && !r.lookup);
  let i = 0, done = 0, unreachable = 0;
  async function worker() {
    while (i < todo.length) {
      const r = todo[i++];
      let hit = fromText(r.text || ''), failed = false;
      if (!hit && r.title && r.title.length >= 8) {
        for (const svc of [crossref, dblp, openAlex, semanticScholar]) {
          try { hit = await svc(fetchFn, r, timeoutMs, bases, queues, s2GapMs, keys); } catch { failed = true; }
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
