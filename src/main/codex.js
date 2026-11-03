// "ChatGPT subscription" provider: drives the official OpenAI Codex CLI that the
// user installed and signed into with their ChatGPT account (`codex login`).
// Scholareader never sees the ChatGPT credentials; Codex keeps them in ~/.codex.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PAPER_SCHEMA, ANALYZE_SYSTEM, EXPLAIN_SYSTEM, explainUser } = require('./prompts');
const { extractText } = require('./pdftext');

const HOME = os.homedir();
const CANDIDATES = [
  '/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(HOME, '.local/bin/codex'),
  path.join(HOME, '.npm-global/bin/codex'), path.join(HOME, '.volta/bin/codex'), path.join(HOME, '.bun/bin/codex'),
  '/usr/bin/codex',
];

// Apps started from Finder get a minimal PATH; borrow the login shell's PATH once
// so `codex` (and the `node` it may need) can be found.
let shellPath = null;
function loginShellPath() {
  if (shellPath !== null) return Promise.resolve(shellPath);
  return new Promise((resolve) => {
    if (process.platform === 'win32') { shellPath = ''; return resolve(''); }
    const sh = process.env.SHELL || '/bin/zsh';
    execFile(sh, ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { timeout: 5000 }, (err, out) => {
      const m = !err && /__P__(.*)__P__/.exec(String(out));
      shellPath = m ? m[1] : '';
      resolve(shellPath);
    });
  });
}
async function env() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local/bin')];
  const p = [await loginShellPath(), process.env.PATH || '', ...extra].filter(Boolean).join(':');
  return { ...process.env, PATH: p };
}

async function findCodex(custom) {
  if (custom && fs.existsSync(custom)) return custom;
  const e = await env();
  for (const dir of e.PATH.split(':')) {
    const f = path.join(dir, 'codex');
    if (dir && fs.existsSync(f)) return f;
  }
  return CANDIDATES.find((f) => fs.existsSync(f)) || null;
}

function run(bin, args, { input, timeoutMs = 0, onStdout } = {}) {
  return new Promise(async (resolve, reject) => {
    const child = spawn(bin, args, { env: await env(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', errOut = '', timer;
    if (timeoutMs) timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Codex 运行超时。')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (onStdout) onStdout(String(d)); });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err: errOut }); });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

class CodexError extends Error {}

async function status(custom) {
  const bin = await findCodex(custom);
  if (!bin) return { installed: false, loggedIn: false, text: '没有找到 Codex。' };
  const r = await run(bin, ['login', 'status'], { timeoutMs: 15000 }).catch((e) => ({ code: 1, out: '', err: e.message }));
  const text = (r.out + r.err).trim();
  return { installed: true, bin, loggedIn: r.code === 0 && !/not logged in/i.test(text), chatgpt: /chatgpt/i.test(text), text };
}

// Opens the browser for the official ChatGPT sign-in; resolves when Codex exits.
async function login(custom) {
  const bin = await findCodex(custom);
  if (!bin) throw new CodexError('没有找到 Codex，请先安装。');
  const r = await run(bin, ['login'], { timeoutMs: 10 * 60 * 1000 });
  if (r.code !== 0) throw new CodexError('登录没有完成：' + (r.err || r.out).trim().slice(-300));
  return status(custom);
}

async function execCodex(cfg, prompt, { schema, timeoutMs, onProgress } = {}) {
  const bin = await findCodex(cfg.codexPath);
  if (!bin) throw new CodexError('没有找到 Codex。请先安装并登录，见设置里的说明。');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scholareader-'));
  try {
    const outFile = path.join(dir, 'out.txt');
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-s', 'read-only', '-C', dir, '-o', outFile];
    if (schema) { fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(schema)); args.push('--output-schema', path.join(dir, 'schema.json')); }
    if (cfg.model) args.push('-m', cfg.model);
    args.push('--json', '-');
    let events = 0;
    const r = await run(bin, args, { input: prompt, timeoutMs, onStdout: (d) => { events += d.length; if (onProgress) onProgress(events); } });
    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    if (r.code !== 0 || !text.trim()) {
      const log = (r.err + '\n' + r.out).trim();
      if (/not logged in|login|unauthor|401/i.test(log)) throw new CodexError('Codex 还没有登录，请在设置里点“用 ChatGPT 登录”。');
      if (/usage limit|rate limit|429/i.test(log)) throw new CodexError('ChatGPT 订阅的用量已达上限，请稍后再试。');
      throw new CodexError('Codex 运行失败：' + log.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300));
    }
    return text;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function analyze(cfg, pdfBuffer, onProgress) {
  const text = await extractText(pdfBuffer);
  if (text.replace(/--- page \d+ ---/g, '').trim().length < 200) {
    throw new CodexError('没能从 PDF 里读出文字。如果是扫描版 PDF，请先做文字识别（OCR）。');
  }
  const prompt = `${ANALYZE_SYSTEM}

The paper's text was extracted from the PDF page by page and is given below between <paper> tags. Lines may be broken mid-sentence and columns may be interleaved; repair this.
Do not run any commands or read any files. Answer only with the JSON object.

<paper>
${text}
</paper>`;
  return execCodex(cfg, prompt, { schema: PAPER_SCHEMA, timeoutMs: 30 * 60 * 1000, onProgress });
}

async function explain(cfg, req) {
  const prompt = `${EXPLAIN_SYSTEM}\nDo not run any commands or read any files.\n\n${explainUser(req)}`;
  return (await execCodex(cfg, prompt, { timeoutMs: 3 * 60 * 1000 })).trim();
}

module.exports = { status, login, analyze, explain, findCodex, CodexError };
