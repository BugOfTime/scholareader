const test = require('node:test');
const assert = require('node:assert');
const { resolveReferences, needsLookup, fromText, titleMatch } = require('../src/main/refs');

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('finds DOI and arXiv ids printed in the reference', () => {
  assert.deepStrictEqual(fromText('A. Smith. Foo. Nature, 2020. doi:10.1038/s41586-020-2649-2.'), { url: 'https://doi.org/10.1038/s41586-020-2649-2', source: 'doi' });
  assert.deepStrictEqual(fromText('Vaswani et al. Attention is all you need. arXiv preprint arXiv:1706.03762, 2017.'), { url: 'https://arxiv.org/abs/1706.03762', source: 'arxiv' });
  assert.deepStrictEqual(fromText('see https://arxiv.org/abs/2005.14165v4'), { url: 'https://arxiv.org/abs/2005.14165', source: 'arxiv' });
  assert.strictEqual(fromText('K. He. Deep residual learning. CVPR 2016.'), null);
});

test('title match tolerates case and punctuation but not a different paper', () => {
  assert.strictEqual(titleMatch('Deep Residual Learning for Image Recognition', 'Deep residual learning for image recognition.'), 1);
  assert.ok(titleMatch('Deep Residual Learning for Image Recognition', 'Identity Mappings in Deep Residual Networks') < 0.85);
});

test('Crossref hit is used only when the title matches; Semantic Scholar is the fallback', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('crossref')) {
      if (url.includes('Residual')) return json({ message: { items: [{ DOI: '10.1109/CVPR.2016.90', title: ['Deep Residual Learning for Image Recognition'] }] } });
      return json({ message: { items: [{ DOI: '10.1/wrong', title: ['Something Else Entirely'] }] } });
    }
    if (url.includes('BERT')) return json({ data: [{ title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', externalIds: { ArXiv: '1810.04805' } }] });
    return json({ error: 'not found' }, 404);
  };
  const refs = [
    { n: 1, text: 'K. He et al. Deep Residual Learning for Image Recognition. CVPR 2016.', title: 'Deep Residual Learning for Image Recognition', url: '' },
    { n: 2, text: 'J. Devlin et al. BERT. NAACL 2019.', title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', url: '' },
    { n: 3, text: 'Unknown, An Obscure Workshop Note, 1999.', title: 'An Obscure Workshop Note', url: '' },
    { n: 4, text: 'Has a link already', title: 'Linked', url: 'https://example.org/x' },
    { n: 5, text: 'Vaswani et al. arXiv:1706.03762', title: 'Attention Is All You Need', url: '' },
  ];
  const progress = [];
  const { unreachable } = await resolveReferences(refs, { fetchFn, s2GapMs: 5, onProgress: (d, t) => progress.push([d, t]) });
  assert.strictEqual(unreachable, 0);
  assert.deepStrictEqual([refs[0].url, refs[0].url_source], ['https://doi.org/10.1109/CVPR.2016.90', 'crossref']);
  assert.deepStrictEqual([refs[1].url, refs[1].url_source], ['https://arxiv.org/abs/1810.04805', 'semanticscholar']);
  assert.deepStrictEqual([refs[2].url, refs[2].lookup], ['', 'none']);
  assert.strictEqual(refs[3].lookup, undefined); // untouched
  assert.deepStrictEqual([refs[4].url, refs[4].url_source], ['https://arxiv.org/abs/1706.03762', 'arxiv']);
  assert.ok(!calls.some((u) => u.includes('1706.03762') || u.includes('Attention')), 'printed arXiv id needs no network');
  assert.deepStrictEqual(progress.at(-1), [4, 4]);
  assert.strictEqual(needsLookup(refs), false);
  // Running again does nothing.
  calls.length = 0;
  await resolveReferences(refs, { fetchFn, s2GapMs: 5 });
  assert.strictEqual(calls.length, 0);
});

test('when the services cannot be reached the reference is left for next time', async () => {
  const refs = [{ n: 1, text: 'K. He. Deep Residual Learning for Image Recognition.', title: 'Deep Residual Learning for Image Recognition', url: '' }];
  const { unreachable } = await resolveReferences(refs, { fetchFn: async () => { throw new Error('offline'); }, s2GapMs: 5 });
  assert.strictEqual(unreachable, 1);
  assert.strictEqual(refs[0].lookup, undefined);
  assert.strictEqual(needsLookup(refs), true);
  const r2 = await resolveReferences(refs, { fetchFn: async () => json({}, 429), s2GapMs: 5 });
  assert.strictEqual(r2.unreachable, 1);
});

test('OpenAlex finds what Crossref misses', async () => {
  const fetchFn = async (url) => {
    if (url.includes('openalex')) return json({ results: [{ display_name: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks', doi: null, primary_location: { landing_page_url: 'https://arxiv.org/abs/2005.11401' } }] });
    if (url.includes('crossref')) return json({ message: { items: [] } });
    throw new Error('Semantic Scholar should not be needed');
  };
  const refs = [{ n: 2, text: 'P. Lewis et al. NeurIPS 2020.', title: 'Retrieval-augmented generation for knowledge-intensive NLP tasks', url: '' }];
  await resolveReferences(refs, { fetchFn, s2GapMs: 5 });
  assert.deepStrictEqual([refs[0].url, refs[0].url_source], ['https://arxiv.org/abs/2005.11401', 'openalex']);
});

test('Semantic Scholar calls are spaced out and a 429 is retried', async () => {
  const times = [];
  let n = 0;
  const fetchFn = async (url) => {
    if (!url.includes('semanticscholar')) return json({}, 404);
    times.push(Date.now());
    if (++n === 1) return json({}, 429);
    const title = decodeURIComponent(url.match(/query=([^&]+)/)[1]);
    return json({ data: [{ title, externalIds: { DOI: '10.1/' + title.length } }] });
  };
  const refs = ['First paper title here', 'Second paper title here', 'Third paper title here'].map((t, i) => ({ n: i + 1, text: t, title: t, url: '' }));
  const { unreachable } = await resolveReferences(refs, { fetchFn, s2GapMs: 60 });
  assert.strictEqual(unreachable, 0);
  assert.ok(refs.every((r) => r.url_source === 'semanticscholar'));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 55, `gap ${times[i] - times[i - 1]}ms`);
});
