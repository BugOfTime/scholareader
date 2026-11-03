// Offline tests for the AI pipeline. No real API calls: a local mock server stands
// in for the Claude API, and a fake `codex` script stands in for the Codex CLI.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { extractText } = require('../src/main/pdftext');
const ai = require('../src/main/ai');
const codex = require('../src/main/codex');

const PDF = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini-paper.pdf'));
const RESULT = {
  title: 'Fixture Paper: Testing Bilingual Reading Pipelines', title_zh: '测试论文', authors: 'Ada Example, Ben Sample', venue: '',
  sections: [{ heading: 'Abstract', heading_zh: '摘要', paragraphs: [{ en: 'Transformers [1] and retrieval [2].', zh: 'Transformer [1] 和检索 [2]。' }] }],
  references: [{ n: 1, text: 'Vaswani, A., et al. Attention Is All You Need.', title: 'Attention Is All You Need', url: '' }, { n: 2, text: 'Lewis', title: 'RAG', url: 'javascript:alert(1)' }],
  summary: { one_line: '一句话', problem: '问题', method: ['方法'], results: ['结果'], limitations: [] },
};

test('extracts text from a two-column PDF', async () => {
  const text = await extractText(PDF);
  assert.match(text, /Fixture Paper: Testing Bilingual Reading Pipelines/);
  assert.match(text, /Attention Is All You Need/);
  assert.match(text, /--- page 1 ---/);
});

test('normalize drops unsafe URLs and fills defaults', () => {
  const p = ai.normalize({ ...RESULT, summary: undefined });
  assert.equal(p.references[1].url, '');
  assert.deepEqual(p.summary.method, []);
  assert.equal(p.sections[0].paragraphs.length, 1);
});

test('parseJSON tolerates code fences', () => {
  assert.deepEqual(ai.parseJSON('```json\n{"a":1}\n```'), { a: 1 });
});

function sse(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < text.length; i += 50) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 50) } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 100 } });
  ev('message_stop', {});
  res.end();
}

test('Claude path sends the PDF + schema in one streamed request and parses the result', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const body = JSON.parse(b);
      bodies.push({ url: req.url, body, headers: req.headers });
      // First attempt (with fallbacks) is rejected, to exercise the retry-without-fallback path.
      if (body.fallbacks) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks not enabled' } })); return; }
      sse(res, JSON.stringify(RESULT));
    });
  });
  await new Promise((r) => server.listen(0, r));
  try {
    let progress = 0;
    const cfg = { prov: 'claude', model: 'claude-opus-5-5', key: 'test-key', baseURL: `http://127.0.0.1:${server.address().port}` };
    const paper = await ai.analyzePaper(cfg, PDF, 'mini.pdf', (n) => (progress = n));
    assert.equal(paper.title, RESULT.title);
    assert.equal(paper.references.length, 2);
    assert.ok(progress > 0);
    assert.equal(bodies.length, 2);
    const first = bodies[0], second = bodies[1];
    assert.equal(first.body.fallbacks, 'default');
    assert.match(String(first.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(second.body.fallbacks, undefined);
    assert.equal(second.body.stream, true);
    assert.equal(second.body.output_config.format.type, 'json_schema');
    const doc = second.body.messages[0].content[0];
    assert.equal(doc.type, 'document');
    assert.equal(doc.source.media_type, 'application/pdf');
    assert.equal(Buffer.from(doc.source.data, 'base64').length, PDF.length);
  } finally {
    server.close();
  }
});

test('Claude path turns a 401 into a readable message', async () => {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }); });
  await new Promise((r) => server.listen(0, r));
  try {
    const cfg = { prov: 'claude', model: 'claude-haiku-5-5', key: 'bad', baseURL: `http://127.0.0.1:${server.address().port}` };
    await assert.rejects(ai.analyzePaper(cfg, PDF, 'mini.pdf'), /API Key 无效/);
  } finally {
    server.close();
  }
});

function fakeCodex({ loggedIn = true, configModelBroken = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecodex-'));
  const log = path.join(dir, 'calls.jsonl');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let stdin = ''; process.stdin.on('data', d => stdin += d); process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdinLen: stdin.length, hasPaper: stdin.includes('Fixture Paper') }) + '\\n');
  if (args[0] === 'login' && args[1] === 'status') { if (${loggedIn}) { console.log('Logged in using ChatGPT'); process.exit(0); } console.error('Not logged in'); process.exit(1); }
  if (args[0] === 'exec') {
    if (!${loggedIn}) { console.error('Error: not logged in. Run codex login'); process.exit(1); }
    if (${configModelBroken} && !args.includes('--ignore-user-config')) {
      console.log(JSON.stringify({ type: 'turn.started' }));
      console.log(JSON.stringify({ type: 'error', message: JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.", code: 'model_not_found' } }) }));
      process.exit(1);
    }
    const o = args[args.indexOf('-o') + 1];
    const schema = args.includes('--output-schema');
    console.log(JSON.stringify({ type: 'thread.started' }));
    fs.writeFileSync(o, schema ? ${JSON.stringify(JSON.stringify(RESULT))} : '这是一个解释。');
    process.exit(0);
  }
  process.exit(2);
});
`, { mode: 0o755 });
  return { bin, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

test('Codex path: status, analyze with extracted text + schema, explain', async () => {
  const f = fakeCodex();
  const st = await codex.status(f.bin);
  assert.equal(st.loggedIn, true);
  assert.equal(st.chatgpt, true);
  const cfg = { prov: 'codex', model: '', codexPath: f.bin };
  const paper = await ai.analyzePaper(cfg, PDF, 'mini.pdf');
  assert.equal(paper.title, RESULT.title);
  const text = await ai.explain(cfg, { text: 'retrieval', context: 'ctx', title: 't' });
  assert.equal(text, '这是一个解释。');
  const calls = f.calls();
  const exec = calls.find((c) => c.args[0] === 'exec' && c.args.includes('--output-schema'));
  assert.ok(exec.hasPaper, 'paper text is piped to codex on stdin');
  for (const flag of ['--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--json', '-']) assert.ok(exec.args.includes(flag), flag);
  assert.ok(!exec.args.includes('-m'), 'no -m when model is empty');
});

test('Codex path reports when not logged in', async () => {
  const f = fakeCodex({ loggedIn: false });
  const st = await codex.status(f.bin);
  assert.equal(st.loggedIn, false);
  await assert.rejects(ai.analyzePaper({ prov: 'codex', model: '', codexPath: f.bin }, PDF, 'mini.pdf'), /还没有登录/);
});

test('Codex path retries with built-in default when the config model is not allowed for ChatGPT accounts', async () => {
  const f = fakeCodex({ configModelBroken: true });
  const paper = await ai.analyzePaper({ prov: 'codex', model: '', codexPath: f.bin }, PDF, 'mini.pdf');
  assert.equal(paper.title, RESULT.title);
  const execs = f.calls().filter((c) => c.args[0] === 'exec');
  assert.equal(execs.length, 2);
  assert.ok(execs[1].args.includes('--ignore-user-config'));
});

test('Codex path explains an unsupported model the user picked', async () => {
  const f = fakeCodex({ configModelBroken: true });
  await assert.rejects(ai.analyzePaper({ prov: 'codex', model: 'gpt-x', codexPath: f.bin }, PDF, 'mini.pdf'), /不能用 ChatGPT 账号调用：The 'gpt-x' model is not supported/);
});
