// One provider (Claude or OpenAI) handles everything: layout + translation +
// summary in a single request per paper, and short select-to-explain calls.
const Anthropic = require('@anthropic-ai/sdk').default;
const OpenAI = require('openai').default;
const codex = require('./codex');
const { PAPER_SCHEMA, ANALYZE_SYSTEM, ANALYZE_USER, EXPLAIN_SYSTEM, explainUser } = require('./prompts');

const MAX_PDF_BYTES = 30 * 1024 * 1024; // request limit is 32 MB incl. base64 overhead
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

class UserFacingError extends Error {}

function anthropicClient(cfg) {
  // baseURL is explicit so a stray ANTHROPIC_BASE_URL in the environment is never used.
  return new Anthropic({ apiKey: cfg.key, baseURL: cfg.baseURL || 'https://api.anthropic.com', maxRetries: 2 });
}
function openaiClient(cfg) {
  return new OpenAI({ apiKey: cfg.key, baseURL: cfg.baseURL || 'https://api.openai.com/v1', maxRetries: 2 });
}

function friendly(err, cfg) {
  if (err instanceof UserFacingError) return err;
  if (err instanceof codex.CodexError) return new UserFacingError(err.message);
  const name = cfg.prov === 'openai' ? 'OpenAI' : 'Claude';
  const status = err && err.status;
  if (status === 401 || status === 403) return new UserFacingError(`${name} API Key 无效或没有权限，请在设置里检查。`);
  if (status === 404) return new UserFacingError(`找不到模型 ${cfg.model}，请在设置里换一个模型。`);
  if (status === 429) return new UserFacingError(`${name} 请求太频繁或额度不足，请稍后重试。`);
  if (status === 413) return new UserFacingError('PDF 太大，超过了接口的大小限制。');
  if (status && status >= 500) return new UserFacingError(`${name} 服务暂时不可用（${status}），请稍后重试。`);
  if (status === 400) return new UserFacingError(`请求被拒绝：${err.message}`);
  if (err && /fetch|network|ECONN|ENOTFOUND|ETIMEDOUT/i.test(String(err.message))) return new UserFacingError('网络连接失败，请检查网络后重试。');
  return new UserFacingError(err && err.message ? err.message : String(err));
}

function parseJSON(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new UserFacingError('AI 返回的内容无法解析，请重试。');
  }
}

// Make the result safe to render even if a field is missing.
function normalize(p) {
  const s = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const list = (v) => (Array.isArray(v) ? v.map(s).filter(Boolean) : []);
  const sections = (Array.isArray(p.sections) ? p.sections : []).map((sec) => ({
    heading: s(sec.heading), heading_zh: s(sec.heading_zh),
    paragraphs: (Array.isArray(sec.paragraphs) ? sec.paragraphs : []).map((x) => ({ en: s(x.en), zh: s(x.zh) })).filter((x) => x.en || x.zh),
  })).filter((sec) => sec.paragraphs.length || sec.heading);
  const references = (Array.isArray(p.references) ? p.references : []).map((r, i) => ({
    n: Number.isInteger(r.n) ? r.n : i + 1, text: s(r.text), title: s(r.title), url: /^https?:\/\//.test(s(r.url)) ? s(r.url) : '',
  }));
  const sm = p.summary || {};
  return {
    title: s(p.title), title_zh: s(p.title_zh), authors: s(p.authors), venue: s(p.venue), sections, references,
    summary: { one_line: s(sm.one_line), problem: s(sm.problem), method: list(sm.method), results: list(sm.results), limitations: list(sm.limitations) },
  };
}

async function analyzeClaude(cfg, pdfBase64, onProgress) {
  const client = anthropicClient(cfg);
  const params = {
    model: cfg.model,
    max_tokens: 128000,
    system: ANALYZE_SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: PAPER_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: ANALYZE_USER },
      ],
    }],
  };
  const run = async (withFallback) => {
    const stream = withFallback
      ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : client.messages.stream(params);
    let chars = 0;
    stream.on('text', (d) => { chars += d.length; onProgress(chars); });
    return stream.finalMessage();
  };
  let msg;
  const useFallback = FALLBACK_MODELS.has(cfg.model);
  try {
    msg = await run(useFallback);
  } catch (err) {
    // If the fallback option is not accepted for this account/model, retry once without it.
    if (useFallback && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) msg = await run(false);
    else throw err;
  }
  if (msg.stop_reason === 'refusal') throw new UserFacingError('模型拒绝处理这篇论文。');
  if (msg.stop_reason === 'max_tokens') throw new UserFacingError('论文太长，AI 的输出被截断了。可以换一个输出上限更高的模型再试。');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseJSON(text);
}

async function analyzeOpenAI(cfg, pdfBase64, fileName, onProgress) {
  const client = openaiClient(cfg);
  const stream = await client.chat.completions.create({
    model: cfg.model,
    stream: true,
    response_format: { type: 'json_schema', json_schema: { name: 'paper', strict: true, schema: PAPER_SCHEMA } },
    messages: [
      { role: 'system', content: ANALYZE_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'file', file: { filename: fileName || 'paper.pdf', file_data: `data:application/pdf;base64,${pdfBase64}` } },
          { type: 'text', text: ANALYZE_USER },
        ],
      },
    ],
  });
  let buf = '', finish = null;
  for await (const chunk of stream) {
    const c = chunk.choices && chunk.choices[0];
    if (!c) continue;
    if (c.delta && c.delta.content) { buf += c.delta.content; onProgress(buf.length); }
    if (c.delta && c.delta.refusal) throw new UserFacingError('模型拒绝处理这篇论文。');
    if (c.finish_reason) finish = c.finish_reason;
  }
  if (finish === 'length') throw new UserFacingError('论文太长，AI 的输出被截断了。可以换一个输出上限更高的模型再试。');
  return parseJSON(buf);
}

async function analyzePaper(cfg, pdfBuffer, fileName, onProgress = () => {}) {
  if (cfg.prov === 'codex') {
    try {
      const paper = normalize(parseJSON(await codex.analyze(cfg, pdfBuffer, onProgress)));
      if (!paper.sections.length) throw new UserFacingError('没能从 PDF 里识别出正文。');
      return paper;
    } catch (err) { throw friendly(err, cfg); }
  }
  if (!cfg.key) throw new UserFacingError('还没有填写 API Key，请先在设置里填写。');
  if (pdfBuffer.length > MAX_PDF_BYTES) throw new UserFacingError('PDF 超过 30 MB，接口无法处理。');
  const b64 = pdfBuffer.toString('base64');
  try {
    const raw = cfg.prov === 'openai' ? await analyzeOpenAI(cfg, b64, fileName, onProgress) : await analyzeClaude(cfg, b64, onProgress);
    const paper = normalize(raw);
    if (!paper.sections.length) throw new UserFacingError('没能从 PDF 里识别出正文。如果是扫描版 PDF，请先做文字识别（OCR）。');
    return paper;
  } catch (err) {
    throw friendly(err, cfg);
  }
}

async function explain(cfg, { text, context, title }) {
  if (cfg.prov === 'codex') {
    try { return await codex.explain(cfg, { text, context, title }); } catch (err) { throw friendly(err, cfg); }
  }
  if (!cfg.key) throw new UserFacingError('还没有填写 API Key，请先在设置里填写。');
  const user = explainUser({ text, context, title });
  try {
    if (cfg.prov === 'openai') {
      const r = await openaiClient(cfg).chat.completions.create({
        model: cfg.model,
        messages: [{ role: 'system', content: EXPLAIN_SYSTEM }, { role: 'user', content: user }],
      });
      return (r.choices[0] && r.choices[0].message.content) || '';
    }
    const msg = await anthropicClient(cfg).messages.create({
      model: cfg.model,
      max_tokens: 4000,
      system: EXPLAIN_SYSTEM,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: user }],
    });
    if (msg.stop_reason === 'refusal') throw new UserFacingError('模型拒绝解释这段文字。');
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  } catch (err) {
    throw friendly(err, cfg);
  }
}

// Validates the key without spending tokens.
async function testConnection(cfg) {
  if (cfg.prov === 'codex') {
    const st = await codex.status(cfg.codexPath);
    if (!st.installed) throw new UserFacingError('没有找到 Codex，请先安装。');
    if (!st.loggedIn) throw new UserFacingError('Codex 还没有登录，请点“用 ChatGPT 登录”。');
    return true;
  }
  if (!cfg.key) throw new UserFacingError('请先填写 API Key。');
  try {
    if (cfg.prov === 'openai') await openaiClient(cfg).models.list();
    else await anthropicClient(cfg).models.list({ limit: 1 });
    return true;
  } catch (err) {
    throw friendly(err, cfg);
  }
}

module.exports = { analyzePaper, explain, testConnection, normalize, parseJSON, UserFacingError };
