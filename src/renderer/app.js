/* Scholareader renderer: library grid, bilingual reader, AI side panel. */
const API = window.api;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const MODELS = {
  codex: [''],
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-5', 'gpt-5-mini'],
};
const PROV_NAME = { codex: 'ChatGPT 订阅', claude: 'Claude', openai: 'OpenAI' };
let codexState = null; // last Codex status
const aiReady = () => (settings.prov === 'codex' ? !!(codexState && codexState.loggedIn) : settings.hasKey);
const SAMPLE = window.SAMPLE_PAPER;
const GLOSSARY = (window.SAMPLE_GLOSSARY || []).map(([re, term, text]) => [new RegExp(re, 'i'), term, text]);

let library = [];
let view = 'lib';        // lib | recent | read
let current = null;      // { id, entry, data }
let tab = 'sum';
let explains = {};       // paper id -> [{q, a, ctx, state}]
let occ = {};            // ref number -> anchor ids
let progressChars = {};
let settings = { prov: 'codex', model: '', hasKey: false, keyHint: '' };
let folders = [];          // [{ id, name }]
let folderId = null;       // folder being viewed (view === 'folder'), kept while reading a paper opened from it
let listView = 'lib';      // list view the reader goes back to
let renaming = false;      // a folder name is being edited in the sidebar

/* ---------- toast ---------- */
function toast(m) {
  const t = $('#toast'); t.textContent = m; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 2600);
}

/* ---------- library ---------- */
function sampleEntry() {
  return { id: 'sample', title: SAMPLE.title, authors: SAMPLE.authors, status: 'ready', sample: true, addedAt: 0, openedAt: store.get('sr-sample-opened', 0) };
}
function allEntries() {
  const list = [...library];
  if (!store.get('sr-hide-sample', false)) list.push(sampleEntry());
  return list;
}
function readFraction(id) { return store.get('sr-pos-' + id, 0); }
const folderIdsOf = (x) => {
  const ids = x.sample ? store.get('sr-sample-folders', []) : x.folders || [];
  return ids.filter((id) => folders.some((f) => f.id === id));
};
async function setFoldersOf(x, ids) {
  if (x.sample) { store.set('sr-sample-folders', ids); renderFolders(); renderLib(); return true; }
  const r = await API.setPaperFolders(x.id, ids);
  if (!r.ok) toast(r.error);
  return r.ok;
}

function renderLib() {
  const q = $('#libQ').value.trim().toLowerCase();
  let list = allEntries().filter((x) => !q || (x.title + ' ' + (x.authors || '')).toLowerCase().includes(q));
  const folder = view === 'folder' && folders.find((f) => f.id === folderId);
  if (view === 'recent') list = list.filter((x) => x.openedAt).sort((a, b) => b.openedAt - a.openedAt);
  if (folder) list = list.filter((x) => folderIdsOf(x).includes(folder.id));
  $('#libTitle').textContent = folder ? folder.name : view === 'recent' ? '最近阅读' : '文献库';
  $('#libSub').textContent = `共 ${list.length} 篇文章。`;
  $('#nAll').textContent = allEntries().length || '';
  const grid = $('#grid');
  if (!list.length) {
    grid.innerHTML = folder && !q
      ? '<div class="emptylib">这个文件夹还是空的。<br>把文献卡片拖到左边的文件夹上，或者点卡片上的“文件夹”按钮。<br>在这里点“添加文章”导入的 PDF 会直接放进这个文件夹。</div>'
      : view === 'recent' && !q
      ? '<div class="emptylib">还没有读过的文章。</div>'
      : '<div class="emptylib">没有找到文章。<br>点右上角“添加文章”，或者直接把 PDF 拖进窗口。</div>';
    return;
  }
  grid.innerHTML = list.map((x) => {
    let status = '';
    if (x.status === 'processing') {
      const n = progressChars[x.id];
      status = `<div class="status"><div class="spin"></div><div>AI 正在排版和翻译…</div><div class="small">${n ? `已生成 ${Math.round(n / 1000)}k 字符` : '正在上传 PDF，长论文可能需要几分钟'}</div></div>`;
    } else if (x.status === 'error') {
      status = `<div class="status err"><div>处理失败</div><div class="small">${esc(x.error)}</div><span class="mini" data-retry="${esc(x.id)}" role="button" tabindex="0">重试</span></div>`;
    }
    const pct = Math.round(readFraction(x.id) * 100);
    const tags = folderIdsOf(x).map((id) => folders.find((f) => f.id === id)).filter(Boolean)
      .map((f) => `<span class="ftag" title="${esc(f.name)}">${esc(f.name)}</span>`).join('');
    return `<div class="card" data-id="${esc(x.id)}" role="button" tabindex="0" draggable="true">
      <div class="thumb"><div class="sheet"><b>${esc(x.title)}</b><i></i><i></i><i class="s"></i><i></i><i></i><i></i></div><span class="prog" style="width:${pct}%"></span>${status}</div>
      <div class="card-b"><div class="t">${esc(x.title)}</div><div class="a">${x.authors ? '作者：' + esc(x.authors) : esc(x.fileName || '')}</div>
      <span class="tag ${x.sample ? 'new' : ''}">${x.sample ? '示例' : pct ? `已读 ${pct}%` : '未读'}</span>${tags ? `<div class="ftags">${tags}</div>` : ''}</div>
      <button class="fold" data-fold="${esc(x.id)}" aria-label="放进文件夹">文件夹</button>
      ${folder ? `<button class="del" data-unfile="${esc(x.id)}" aria-label="移出这个文件夹" title="移出这个文件夹（不会删除论文）">×</button>`
        : `<button class="del" data-del="${esc(x.id)}" aria-label="删除" title="从文献库删除">×</button>`}</div>`;
  }).join('');
}

async function refreshLibrary(list) {
  library = list || (await API.listLibrary());
  if (view !== 'read') renderLib();
  if (current && !current.entry.sample) {
    const e = library.find((p) => p.id === current.id);
    if (!e) show(listView);
  }
}

$('#grid').addEventListener('click', async (e) => {
  const fold = e.target.closest('[data-fold]');
  if (fold) { e.stopPropagation(); openFolderPop(fold.dataset.fold, fold); return; }
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!del.classList.contains('confirm')) {
      del.classList.add('confirm'); del.textContent = '删除？'; del.style.width = 'auto'; del.style.padding = '0 8px';
      setTimeout(() => renderLib(), 3000);
      return;
    }
    const id = del.dataset.del;
    if (id === 'sample') { store.set('sr-hide-sample', true); renderLib(); renderFolders(); }
    else if (!(await API.remove(id))) { toast('这篇还在处理中，处理完才能删除'); renderLib(); return; }
    toast('已删除');
    return;
  }
  // Inside a folder, × only takes the paper out of that folder.
  const unfile = e.target.closest('[data-unfile]');
  if (unfile) {
    e.stopPropagation();
    if (!unfile.classList.contains('confirm')) {
      unfile.classList.add('confirm'); unfile.textContent = '移出？'; unfile.style.width = 'auto'; unfile.style.padding = '0 8px';
      setTimeout(() => renderLib(), 3000);
      return;
    }
    const x = allEntries().find((p) => p.id === unfile.dataset.unfile), f = folders.find((y) => y.id === folderId);
    if (x && f && (await setFoldersOf(x, folderIdsOf(x).filter((id) => id !== f.id)))) toast(`已移出“${f.name}”，论文仍在文献库里`);
    return;
  }
  const retry = e.target.closest('[data-retry]');
  if (retry) { e.stopPropagation(); await API.retry(retry.dataset.retry); return; }
  const card = e.target.closest('.card');
  if (card) openPaper(card.dataset.id);
});
$('#grid').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('card')) openPaper(e.target.dataset.id); });

function show(v) {
  if (v === 'folder' && !folders.some((f) => f.id === folderId)) v = 'lib';
  view = v;
  if (v !== 'read') listView = v;
  const reading = v === 'read';
  $('#app').classList.toggle('lib', !reading);
  $('#libView').hidden = reading; $('#scroll').hidden = !reading; $('#topbar').hidden = !reading;
  $('#pop').hidden = true;
  $('#fpop').hidden = true;
  $$('.nav[data-go]').forEach((n) => n.classList.toggle('on', !reading && n.dataset.go === v));
  if (v !== 'folder' && v !== 'read') folderId = null;
  const back = listView === 'folder' ? folders.find((f) => f.id === folderId) : null;
  $('#backBtn').textContent = '← ' + (back ? back.name : listView === 'recent' ? '最近阅读' : '文献库');
  renderFolders();
  if (!reading) { current = null; renderLib(); }
}

/* ---------- folders ---------- */
function renderFolders() {
  const counts = {};
  for (const x of allEntries()) for (const id of folderIdsOf(x)) counts[id] = (counts[id] || 0) + 1;
  const nav = $('#folderNav');
  if (renaming) return; // re-rendering would throw away what the user is typing
  if (!folders.length) { nav.innerHTML = '<div class="fempty">按项目建文件夹来整理论文。点上面的 ＋ 新建。</div>'; return; }
  nav.innerHTML = folders.map((f) => `<div class="fitem" data-fid="${esc(f.id)}">
    <button class="nav ${view === 'folder' && folderId === f.id ? 'on' : ''}" data-open-folder="${esc(f.id)}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z"/></svg><span class="fname">${esc(f.name)}</span><span class="n">${counts[f.id] || ''}</span></button>
    <span class="facts"><button data-rename="${esc(f.id)}" aria-label="重命名" title="重命名">✎</button><button data-fdel="${esc(f.id)}" aria-label="删除文件夹" title="删除文件夹">×</button></span></div>`).join('');
}
async function loadFolders(list) {
  folders = list || (await API.listFolders());
  if (!folders.some((f) => f.id === folderId)) {
    if (view === 'folder') { show('lib'); return; }
    if (listView === 'folder') listView = 'lib';
  }
  renderFolders();
  if (view !== 'read') renderLib();
  if (!$('#fpop').hidden && fpopFor) renderFolderPop();
}
$('#addFolder').onclick = () => {
  const form = $('#newFolderForm');
  form.hidden = !form.hidden;
  if (!form.hidden) { $('#newFolderName').value = ''; $('#newFolderName').focus(); }
};
$('#newFolderForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#newFolderName').value.trim();
  if (!name) { $('#newFolderForm').hidden = true; return; }
  const r = await API.createFolder(name);
  if (!r.ok) { toast(r.error); return; }
  $('#newFolderForm').hidden = true;
  toast(`已新建文件夹“${r.value.name}”`);
};
$('#newFolderName').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); $('#newFolderForm').hidden = true; } });
$('#newFolderName').addEventListener('blur', () => setTimeout(() => { if (!$('#newFolderName').value.trim()) $('#newFolderForm').hidden = true; }, 150));

$('#folderNav').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open-folder]');
  const ren = e.target.closest('[data-rename]');
  const del = e.target.closest('[data-fdel]');
  if (ren) {
    const f = folders.find((x) => x.id === ren.dataset.rename);
    const item = ren.closest('.fitem');
    item.innerHTML = `<input class="frename" maxlength="60" aria-label="新名称">`;
    const input = item.querySelector('input');
    input.value = f.name; input.focus(); input.select();
    renaming = true;
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      renaming = false;
      const name = input.value.trim();
      if (save && name && name !== f.name) { const r = await API.renameFolder(f.id, name); if (!r.ok) toast(r.error); }
      renderFolders(); renderLib();
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); } });
    input.addEventListener('blur', () => finish(true));
    return;
  }
  if (del) {
    if (!del.classList.contains('confirm')) {
      del.classList.add('confirm'); del.textContent = '删除？';
      setTimeout(() => renderFolders(), 3000);
      return;
    }
    const id = del.dataset.fdel;
    const sampleIds = store.get('sr-sample-folders', []);
    if (sampleIds.includes(id)) store.set('sr-sample-folders', sampleIds.filter((x) => x !== id));
    const r = await API.deleteFolder(id);
    if (!r.ok) toast(r.error); else toast('已删除文件夹，里面的论文还在文献库里');
    return;
  }
  if (open) { folderId = open.dataset.openFolder; show('folder'); }
});

// Drag a card onto a folder in the sidebar to add it there.
$('#grid').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  e.dataTransfer.setData('text/x-paper', card.dataset.id);
  e.dataTransfer.effectAllowed = 'copy';
  card.classList.add('dragging');
});
$('#grid').addEventListener('dragend', (e) => { const c = e.target.closest('.card'); if (c) c.classList.remove('dragging'); });
$('#folderNav').addEventListener('dragover', (e) => {
  const item = e.target.closest('.fitem');
  if (!item || ![...e.dataTransfer.types].includes('text/x-paper')) return;
  e.preventDefault(); e.stopPropagation();
  $$('.fitem.droptarget').forEach((x) => x !== item && x.classList.remove('droptarget'));
  item.classList.add('droptarget');
});
$('#folderNav').addEventListener('dragleave', (e) => { const item = e.target.closest('.fitem'); if (item && !item.contains(e.relatedTarget)) item.classList.remove('droptarget'); });
$('#folderNav').addEventListener('drop', async (e) => {
  const item = e.target.closest('.fitem');
  const pid = e.dataTransfer.getData('text/x-paper');
  $$('.fitem.droptarget').forEach((x) => x.classList.remove('droptarget'));
  if (!item || !pid) return;
  e.preventDefault(); e.stopPropagation();
  const x = allEntries().find((p) => p.id === pid);
  const fid = item.dataset.fid, f = folders.find((y) => y.id === fid);
  if (!x || !f) return;
  const ids = folderIdsOf(x);
  if (ids.includes(fid)) { toast(`已经在“${f.name}”里了`); return; }
  if (await setFoldersOf(x, [...ids, fid])) toast(`已放进“${f.name}”`);
});

// Checkbox popover: put one paper into any number of folders.
let fpopFor = null;
function openFolderPop(paperId, anchor) {
  const pop = $('#fpop');
  if (!pop.hidden && fpopFor === paperId) { pop.hidden = true; return; }
  fpopFor = paperId;
  renderFolderPop();
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
  pop.style.top = (r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
}
function renderFolderPop() {
  const x = allEntries().find((p) => p.id === fpopFor);
  if (!x) { $('#fpop').hidden = true; return; }
  const ids = folderIdsOf(x);
  $('#fpop').innerHTML = `<h4>放进文件夹（可多选）</h4><div class="flist">${folders.length ? folders.map((f) => `<label><input type="checkbox" data-fcheck="${esc(f.id)}" ${ids.includes(f.id) ? 'checked' : ''}><span>${esc(f.name)}</span></label>`).join('') : '<div class="none">还没有文件夹。</div>'}</div>
    <form id="fpopNew"><input type="text" id="fpopNewName" maxlength="60" placeholder="＋ 新建文件夹并放进去" aria-label="新建文件夹" autocomplete="off"></form>`;
}
$('#fpop').addEventListener('change', async (e) => {
  const cb = e.target.closest('[data-fcheck]');
  if (!cb) return;
  const x = allEntries().find((p) => p.id === fpopFor);
  if (!x) return;
  const ids = new Set(folderIdsOf(x));
  if (cb.checked) ids.add(cb.dataset.fcheck); else ids.delete(cb.dataset.fcheck);
  if (!(await setFoldersOf(x, [...ids]))) cb.checked = !cb.checked;
});
$('#fpop').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#fpopNewName').value.trim();
  if (!name) return;
  const r = await API.createFolder(name);
  if (!r.ok) { toast(r.error); return; }
  folders = await API.listFolders();
  const x = allEntries().find((p) => p.id === fpopFor);
  if (x) await setFoldersOf(x, [...folderIdsOf(x), r.value.id]);
  renderFolderPop();
  $('#fpopNewName').focus();
});
document.addEventListener('mousedown', (e) => {
  const pop = $('#fpop');
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-fold],#readerFolderBtn')) pop.hidden = true;
});
$('#readerFolderBtn').onclick = (e) => { if (current) openFolderPop(current.id, e.currentTarget); };

/* ---------- reader ---------- */
async function openPaper(id) {
  const entry = allEntries().find((x) => x.id === id);
  if (!entry) return;
  if (entry.status === 'processing') { toast('这篇还在处理中，完成后就能打开'); return; }
  if (entry.status === 'error') { toast('这篇处理失败了，可以点“重试”'); return; }
  const data = entry.sample ? SAMPLE : await API.getPaper(id);
  if (!data) { toast('找不到这篇文章的数据，请重试'); return; }
  current = { id, entry, data };
  const now = Date.now();
  if (entry.sample) store.set('sr-sample-opened', now); else API.touch(id, { openedAt: now });
  entry.openedAt = now;
  tab = 'sum';
  $('#crumb').textContent = data.title;
  $('#pdfBtn').hidden = !!entry.sample;
  renderPaper();
  renderPanel();
  show('read');
  const sc = $('#scroll');
  requestAnimationFrame(() => { sc.scrollTop = readFraction(id) * (sc.scrollHeight - sc.clientHeight); });
}

function refMap() {
  const m = {};
  for (const r of current.data.references || []) m[r.n] = r;
  return m;
}
function citeHTML(text, where, refs) {
  return esc(text).replace(/\[(\d+(?:\s*[,，]\s*\d+)*)\]/g, (m, g) => {
    const nums = g.split(/\s*[,，]\s*/);
    if (!nums.every((n) => refs[n])) return m;
    return '[' + nums.map((n) => {
      const id = `c-${where}-${(occ[n] = occ[n] || []).length}-${n}`;
      occ[n].push(id);
      return `<button class="cite" id="${id}" data-ref="${n}" title="${esc(refs[n].title || refs[n].text)}">${n}</button>`;
    }).join(', ') + ']';
  });
}
function refUrl(r) {
  return r.url || `https://scholar.google.com/scholar?q=${encodeURIComponent(r.title || r.text)}`;
}

function renderPaper() {
  const d = current.data, refs = refMap();
  occ = {};
  const meta = [d.authors, d.venue, d.model ? `由 ${d.model} 翻译` : '英文 → 简体中文'].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('');
  let h = `<header class="head">${d.sample ? '<span class="badge">示例论文 · 内容为虚构，仅用于演示界面</span>' : ''}
    <h1 class="ptitle">${esc(d.title)}</h1>${d.title_zh && d.title_zh !== d.title ? `<p class="ptitle-zh">${esc(d.title_zh)}</p>` : ''}
    <div class="meta">${meta}</div></header>`;
  d.sections.forEach((s, si) => {
    if (s.heading) h += `<h2 class="sec" id="s${si}">${esc(s.heading)}${s.heading_zh && s.heading_zh !== s.heading ? `<small>${esc(s.heading_zh)}</small>` : ''}</h2>`;
    s.paragraphs.forEach((p) => {
      h += `<div class="pair"><p class="en">${citeHTML(p.en, 'en', refs)}</p>${p.zh ? `<p class="zh">${citeHTML(p.zh, 'zh', refs)}</p>` : ''}</div>`;
    });
  });
  if ((d.references || []).length) {
    h += '<h2 class="sec" id="refs">References<small>参考文献</small></h2><ol class="refs-in">';
    for (const r of d.references) {
      h += `<li id="r${r.n}"><span class="n">[${r.n}]</span><span>${esc(r.text)} <a href="${esc(refUrl(r))}" target="_blank" rel="noopener">${r.url ? '打开原文' : '搜索'}</a></span></li>`;
    }
    h += '</ol>';
  }
  h += '<p class="hint">提示：选中任意文字可以让 AI 解释；点击蓝色的引用编号会跳到对应的参考文献。</p>';
  $('#page').innerHTML = h;
  $('#refCount').textContent = (d.references || []).length || '';
  applyMode(store.get('sr-mode', 'both'));
}

function applyMode(m) {
  $$('.seg button').forEach((x) => x.classList.toggle('on', x.dataset.mode === m));
  $('#page').className = 'page' + (m === 'both' ? '' : ' mode-' + m);
}
$$('.seg button').forEach((b) => (b.onclick = () => { applyMode(b.dataset.mode); store.set('sr-mode', b.dataset.mode); }));

let posTimer;
$('#scroll').addEventListener('scroll', () => {
  $('#pop').hidden = true;
  if (!current) return;
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    const sc = $('#scroll'), max = sc.scrollHeight - sc.clientHeight;
    if (current && max > 0) store.set('sr-pos-' + current.id, Math.min(1, sc.scrollTop / max));
  }, 300);
});

/* ---------- side panel ---------- */
function li(items) { return `<ul>${items.map((x) => `<li>${citeSummary(x)}</li>`).join('')}</ul>`; }
function citeSummary(t) { return esc(t).replace(/\[(\d+)\]/g, '<button class="cite" data-ref="$1">[$1]</button>'); }

function renderPanel() {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const list = explains[current.id] || [];
  $('#expCount').textContent = list.length || '';
  const pb = $('#pbody');
  if (tab === 'sum') {
    const s = current.data.summary || {};
    pb.innerHTML = `<h3>一句话总结</h3><div class="callout"><span class="ic">💡</span><div>${citeSummary(s.one_line)}</div></div>
      ${s.problem ? `<h3>研究问题</h3><p>${citeSummary(s.problem)}</p>` : ''}
      ${(s.method || []).length ? `<h3>方法</h3>${li(s.method)}` : ''}
      ${(s.results || []).length ? `<h3>主要结果</h3>${li(s.results)}` : ''}
      ${(s.limitations || []).length ? `<h3>局限</h3>${li(s.limitations)}` : ''}
      <div class="gen">${current.data.sample ? '示例内容。导入 PDF 后由所选模型自动生成。' : `由 ${esc(current.data.model || 'AI')} 生成，可能有误，请以原文为准。`}</div>`;
    return;
  }
  if (tab === 'exp') {
    pb.innerHTML = list.length ? list.map((e) => `<div class="qcard"><q>${esc(e.q)}</q><p class="body ${e.state || ''}" style="margin-top:10px">${esc(e.a)}</p><div class="ctx">${esc(e.ctx)}</div></div>`).join('')
      : '<div class="empty">在左侧正文里选中一个词或一句话，<br>点 <kbd>解释</kbd>，结果会出现在这里。</div>';
    return;
  }
  const refs = current.data.references || [];
  if (!refs.length) { pb.innerHTML = '<div class="empty">这篇文章没有识别到参考文献。</div>'; return; }
  let h = '<input class="search" id="refSearch" placeholder="搜索参考文献" aria-label="搜索参考文献">';
  for (const r of refs) {
    const o = (occ[r.n] || []).filter((x) => x.includes('-en-')).length;
    h += `<div class="ref" id="pr${r.n}" data-q="${esc((r.title + ' ' + r.text).toLowerCase())}"><div class="t">[${r.n}] ${esc(r.title || r.text)}</div>${r.title ? `<div class="m">${esc(r.text)}</div>` : ''}
      <div class="acts"><a class="chip open" href="${esc(refUrl(r))}" target="_blank" rel="noopener">${r.url ? '打开原文 ↗' : '在 Google Scholar 搜索 ↗'}</a>${o ? `<button class="chip" data-jump="${r.n}">在文中出现 ${o} 次 · 定位</button>` : ''}<button class="chip" data-inlist="${r.n}">参考文献表</button></div></div>`;
  }
  pb.innerHTML = h;
  $('#refSearch').addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); $$('.ref').forEach((r) => (r.hidden = !r.dataset.q.includes(q))); });
}
$$('.tabs button').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; renderPanel(); }));

function flash(el) { if (!el) return; el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400); }
function goRef(n) {
  const item = document.getElementById('r' + n);
  if (item) { item.scrollIntoView({ behavior: 'smooth', block: 'center' }); flash(item); }
  tab = 'ref'; renderPanel();
  const pr = document.getElementById('pr' + n);
  if (pr) { pr.scrollIntoView({ block: 'nearest' }); flash(pr); }
}
const jumpIdx = {};
document.addEventListener('click', (e) => {
  const c = e.target.closest('.cite'); if (c) { goRef(c.dataset.ref); return; }
  const j = e.target.closest('[data-jump]');
  if (j) {
    const n = j.dataset.jump;
    const zhOnly = $('#page').classList.contains('mode-zh');
    const ids = (occ[n] || []).filter((x) => x.includes(zhOnly ? '-zh-' : '-en-'));
    if (!ids.length) return;
    const k = (jumpIdx[n] = ((jumpIdx[n] ?? -1) + 1) % ids.length);
    const el = document.getElementById(ids[k]);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' }); flash(el.closest('.pair'));
    return;
  }
  const l = e.target.closest('[data-inlist]');
  if (l) { const item = document.getElementById('r' + l.dataset.inlist); item.scrollIntoView({ behavior: 'smooth', block: 'center' }); flash(item); }
});

/* ---------- select to explain ---------- */
const pop = $('#pop');
let sel = null;
document.addEventListener('mouseup', (e) => {
  if (pop.contains(e.target) || view !== 'read') return;
  setTimeout(() => {
    const s = window.getSelection(), t = s ? s.toString().trim() : '';
    if (!t || t.length > 600 || !$('#page').contains(s.anchorNode)) { pop.hidden = true; return; }
    const r = s.getRangeAt(0).getBoundingClientRect();
    const pair = s.anchorNode.parentElement && s.anchorNode.parentElement.closest('.pair');
    sel = { t, ctx: pair ? pair.querySelector('.en').textContent : '' };
    pop.hidden = false;
    pop.style.left = Math.max(8, Math.min(innerWidth - 140, r.left + r.width / 2 - 55)) + 'px';
    pop.style.top = Math.max(8, r.top - 42) + 'px';
  }, 0);
});
$('#popExplain').onclick = async () => {
  if (!sel || !current) return;
  pop.hidden = true;
  window.getSelection().removeAllRanges();
  const list = (explains[current.id] = explains[current.id] || []);
  const item = { q: sel.t, a: '正在解释…', ctx: sel.ctx ? '所在段落：' + sel.ctx.slice(0, 90) + '…' : '', state: 'loading' };
  list.unshift(item);
  tab = 'exp'; renderPanel();
  const g = current.data.sample && !aiReady() && GLOSSARY.find((x) => x[0].test(sel.t));
  if (g) { item.q = g[1]; item.a = g[2]; item.state = ''; renderPanel(); return; }
  if (!aiReady()) { item.a = '还没有设置好 AI。请先点“设置”。'; item.state = 'err'; renderPanel(); return; }
  const r = await API.explain({ text: sel.t, context: sel.ctx, title: current.data.title });
  item.a = r.ok ? r.text : r.error; item.state = r.ok ? '' : 'err';
  if (tab === 'exp') renderPanel();
};
$('#popCopy').onclick = async () => {
  pop.hidden = true;
  try { await navigator.clipboard.writeText(sel.t); toast('已复制'); } catch { toast('复制失败，请用 ⌘C'); }
};

/* ---------- import ---------- */
$('#importBtn').onclick = async () => {
  if (!aiReady()) { toast('请先在设置里连接 AI'); openSettings(); return; }
  const n = await API.importPdf(view === 'folder' && folderId ? [folderId] : []);
  if (n) toast(`已添加 ${n} 篇，AI 正在处理`);
};
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#droppad').hidden = false; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#droppad').hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#droppad').hidden = true;
  if (![...e.dataTransfer.types].includes('Files')) return; // a card dropped outside a folder
  const files = [...(e.dataTransfer.files || [])].filter((f) => /\.pdf$/i.test(f.name));
  if (!files.length) { toast('只支持 PDF 文件'); return; }
  if (!aiReady()) { toast('请先在设置里连接 AI'); openSettings(); return; }
  const n = await API.importFiles(files, view === 'folder' && folderId ? [folderId] : []);
  if (n) { if (view === 'read') show(listView); toast(`已添加 ${n} 篇，AI 正在处理`); }
});

/* ---------- settings ---------- */
function fillModels(p) {
  const isCodex = p === 'codex';
  $('#codexBox').hidden = !isCodex; $('#keyField').hidden = isCodex;
  $('#model').placeholder = isCodex ? '留空则使用 Codex 的默认模型' : '';
  if (isCodex) renderCodex();
  $('#modelList').innerHTML = MODELS[p].filter(Boolean).map((m) => `<option value="${m}"></option>`).join('');
  $('#apikey').placeholder = settings.hasKey && p === settings.prov ? `已保存（${settings.keyHint}），留空表示不修改` : p === 'claude' ? 'sk-ant-…' : 'sk-…';
  $('#keyNote').textContent = p === 'claude' ? '在 console.anthropic.com 创建 Key。Key 只保存在这台电脑上，用系统钥匙串加密。' : '在 platform.openai.com 创建 Key。Key 只保存在这台电脑上，用系统钥匙串加密。';
}
function showProv() {
  const p = settings.prov;
  const state = p === 'codex' ? (codexState ? (codexState.loggedIn ? (settings.model || '已登录') : codexState.installed ? '未登录' : '未安装 Codex') : '检测中…') : settings.hasKey ? settings.model : '未填写 API Key';
  $('#provText').textContent = PROV_NAME[p] + ' · ' + state;
  $('#provDot').style.background = aiReady() ? '#4dab9a' : '#d9a441';
}
function renderCodex() {
  const st = $('#codexStat');
  if (!codexState) { st.className = 'cstat'; st.textContent = '正在检测 Codex…'; return; }
  if (!codexState.installed) { st.className = 'cstat bad'; st.textContent = '这台电脑上还没有安装 Codex。'; }
  else if (!codexState.loggedIn) { st.className = 'cstat bad'; st.textContent = 'Codex 已安装，但还没有登录。'; }
  else { st.className = 'cstat ok'; st.textContent = codexState.chatgpt ? '已用 ChatGPT 账号登录，可以直接使用。' : '已登录（' + codexState.text + '）'; }
  $('#codexLogin').hidden = !codexState.installed || codexState.loggedIn;
  $('#codexHelp').hidden = codexState.installed;
}
async function checkCodex() {
  codexState = await API.codexStatus();
  renderCodex(); showProv();
}
$('#codexRecheck').onclick = () => { codexState = null; renderCodex(); checkCodex(); };
$('#codexLogin').onclick = async () => {
  const st = $('#codexStat'); st.className = 'cstat'; st.textContent = '已在浏览器里打开 ChatGPT 登录页，完成后回到这里…';
  const r = await API.codexLogin();
  if (r.ok) { codexState = r.status; renderCodex(); showProv(); } else { st.className = 'cstat bad'; st.textContent = r.error; }
};
function formValues() {
  const prov = $('#provOpenai').checked ? 'openai' : $('#provClaude').checked ? 'claude' : 'codex';
  const key = $('#apikey').value.trim();
  if (prov === 'codex') return { prov, model: $('#model').value.trim(), key: undefined };
  return { prov, model: $('#model').value.trim() || MODELS[prov][0], key: key || (settings.hasKey && prov === settings.prov ? undefined : '') };
}
function openSettings() {
  $('#provCodex').checked = settings.prov === 'codex';
  $('#provClaude').checked = settings.prov === 'claude';
  $('#provOpenai').checked = settings.prov === 'openai';
  $('#model').value = settings.model;
  $('#apikey').value = '';
  $('#testRes').textContent = '';
  fillModels(settings.prov);
  $('#veil').hidden = false;
}
$$('input[name="prov"]').forEach((r) => (r.onchange = () => { $('#model').value = r.value === settings.prov ? settings.model : MODELS[r.value][0]; fillModels(r.value); }));
$('#settingsBtn').onclick = openSettings; $('#settingsBtn2').onclick = openSettings; $('#provBtn').onclick = openSettings;
$('#cancelBtn').onclick = () => ($('#veil').hidden = true);
$('#veil').addEventListener('mousedown', (e) => { if (e.target.id === 'veil') $('#veil').hidden = true; });
$('#testBtn').onclick = async () => {
  const res = $('#testRes'); res.className = 'testres'; res.textContent = '正在测试…';
  const r = await API.testSettings(formValues());
  res.className = 'testres ' + (r.ok ? 'ok' : 'bad');
  res.textContent = r.ok ? '连接成功' : r.error;
};
$('#settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  await API.setSettings(formValues());
  settings = await API.getSettings();
  $('#veil').hidden = true; showProv(); toast('已保存');
  if (settings.prov === 'codex' && !codexState) checkCodex();
};

/* ---------- nav ---------- */
$$('.nav[data-go]').forEach((n) => (n.onclick = () => show(n.dataset.go)));
$('#searchNav').onclick = () => { show('lib'); $('#libQ').focus(); };
$('#libQ').addEventListener('input', renderLib);
$('#backBtn').onclick = () => show(listView);
$('#pdfBtn').onclick = () => current && API.showPdf(current.id);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#veil').hidden) $('#veil').hidden = true;
    else if (!$('#fpop').hidden) $('#fpop').hidden = true;
    else if (view === 'read') show(listView);
  }
});

API.onLibrary((list) => { refreshLibrary(list); renderFolders(); if (!$('#fpop').hidden) renderFolderPop(); });
API.onFolders((list) => loadFolders(list));
API.onProgress(({ id, chars }) => { progressChars[id] = chars; if (view !== 'read') renderLib(); });

(async () => {
  settings = await API.getSettings();
  showProv();
  folders = await API.listFolders();
  await refreshLibrary();
  show('lib');
  checkCodex();
})();
