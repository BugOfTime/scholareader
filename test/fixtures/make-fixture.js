// Regenerates test/fixtures/mini-paper.pdf (needs Playwright + Chromium).
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent(`<style>body{font-family:Times,serif;font-size:11pt;margin:40px;columns:2;column-gap:24px}h1{column-span:all;text-align:center;font-size:18pt}.au{column-span:all;text-align:center}</style>
  <h1>Fixture Paper: Testing Bilingual Reading Pipelines</h1><p class="au">Ada Example, Ben Sample</p>
  <h3>Abstract</h3><p>We describe a tiny fixture used to test text extraction. Transformers [1] and retrieval [2] are mentioned so citations can be linked.</p>
  <h3>1 Introduction</h3><p>Reading papers in a second language is slow. Prior tools place translations in separate windows [2]. This fixture has two columns so the extractor sees interleaved lines.</p>
  <h3>References</h3><p>[1] Vaswani, A., et al. Attention Is All You Need. NeurIPS 2017.</p><p>[2] Lewis, P., et al. Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks. NeurIPS 2020.</p>`);
  await p.pdf({ path: path.join(__dirname, 'mini-paper.pdf'), format: 'A4' });
  await b.close();
})();
