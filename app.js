'use strict';

/* ================================================================
 * クソミーム・メーカー
 * えらぶ → つくる → できた の3ステップでミーム画像を作るローカルツール。
 * データはブラウザの IndexedDB に保存される（サーバー不要）。
 * スマホ・PCで共通の単一UI。
 * ================================================================ */

// ---------------- IndexedDB ----------------

const DB_NAME = 'meme-maker';
const STORE = 'templates';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let db = null;

function dbAll() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(tpl) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(tpl);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------- 状態 ----------------

const state = {
  templates: [],   // {id, name, imageBlob, boxes, updatedAt}
  templateId: null,
  name: '',
  img: null,       // HTMLImageElement
  imgBlob: null,
  boxes: [],
  selectedId: null,
};

let mode = 'pick'; // 'pick' | 'edit' | 'done'
let presets = [];  // templates/manifest.json の内容

const FONTS = {
  gothic: '"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif',
  mincho: '"Hiragino Mincho ProN", "Yu Mincho", "MS PMincho", serif',
  maru:   '"Hiragino Maru Gothic ProN", "Yu Gothic", Meiryo, sans-serif',
};
const FONT_LABELS = { gothic: 'ゴシック', mincho: '明朝', maru: '丸ゴシック' };

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now());
}

function newBox(x, y, w, h) {
  return {
    id: uid(),
    x, y, w, h,
    text: 'テキストを入力',
    fontSize: Math.max(16, Math.round(h * 0.28)),
    color: '#000000',
    font: 'gothic',
    bold: true,
    vertical: false,
    bg: true,
    bgColor: '#ffffff',
    outline: false,
    outlineColor: '#ffffff',
    align: 'center',
    lineHeight: 1.2,
    pad: 6,
  };
}

function getSelected() {
  return state.boxes.find(b => b.id === state.selectedId) || null;
}

// ---------------- DOM ----------------

const $ = id => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const canvasWrap = $('canvasWrap');
const btnResetView = $('btnResetView');
const editHint = $('editHint');
const editorEl = $('editor');
const pickScreen = $('pickScreen');
const editScreen = $('editScreen');
const doneScreen = $('doneScreen');
const stepPick = $('stepPick');
const stepEdit = $('stepEdit');
const stepDone = $('stepDone');
const templateGrid = $('templateGrid');
const presetGrid = $('presetGrid');
const mineHead = $('mineHead');
const presetHead = $('presetHead');
const fileInput = $('fileInput');
const resultImg = $('resultImg');
const btnShare = $('btnShare');
const btnSave = $('btnSave');
const btnCopy = $('btnCopy');
const btnBack = $('btnBack');
const dropOverlay = $('dropOverlay');
const toastEl = $('toast');

const thumbURLs = new Map(); // templateId -> objectURL

// ---------------- モード切替（ステップフロー） ----------------

function setMode(m) {
  mode = m;
  document.body.dataset.mode = m;
  pickScreen.hidden = m !== 'pick';
  editScreen.hidden = m !== 'edit';
  doneScreen.hidden = m !== 'done';
  syncSteps();
  if (m === 'pick') renderPickScreen();
  if (m === 'edit') { renderEditor(); scheduleRender(); }
}

function syncSteps() {
  const has = !!state.img;
  stepEdit.disabled = !has;
  stepDone.disabled = !has;
  stepPick.classList.toggle('active', mode === 'pick');
  stepEdit.classList.toggle('active', mode === 'edit');
  stepDone.classList.toggle('active', mode === 'done');
}

stepPick.addEventListener('click', () => setMode('pick'));
stepEdit.addEventListener('click', () => { if (state.img) setMode('edit'); });
stepDone.addEventListener('click', () => enterDone());

// ---------------- 描画 ----------------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render(forExport = false) {
  if (!state.img) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.img, 0, 0);
  for (const box of state.boxes) drawBox(box);
  if (!forExport) {
    const sel = getSelected();
    if (sel) drawSelectionUI(sel);
  }
}

function drawBox(b) {
  if (b.bg) {
    ctx.fillStyle = b.bgColor;
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }
  if (!b.text) return;
  ctx.font = `${b.bold ? 'bold ' : ''}${b.fontSize}px ${FONTS[b.font] || FONTS.gothic}`;
  if (b.vertical) drawVerticalText(b);
  else drawHorizontalText(b);
}

function strokeFillText(b, text, x, y) {
  if (b.outline) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(2, b.fontSize / 6);
    ctx.strokeStyle = b.outlineColor;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = b.color;
  ctx.fillText(text, x, y);
}

// --- 横書き ---

function wrapHorizontal(text, maxW) {
  const lines = [];
  for (const raw of text.split('\n')) {
    let line = '';
    for (const ch of raw) {
      if (line && ctx.measureText(line + ch).width > maxW) {
        lines.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawHorizontalText(b) {
  const maxW = Math.max(10, b.w - b.pad * 2);
  const lines = wrapHorizontal(b.text, maxW);
  const lh = b.fontSize * b.lineHeight;
  const totalH = lines.length * lh;
  let y = b.y + (b.h - totalH) / 2 + lh / 2;
  ctx.textBaseline = 'middle';
  ctx.textAlign = b.align;
  const x = b.align === 'left' ? b.x + b.pad
          : b.align === 'right' ? b.x + b.w - b.pad
          : b.x + b.w / 2;
  for (const line of lines) {
    strokeFillText(b, line, x, y);
    y += lh;
  }
}

// --- 縦書き ---

const V_ROTATE = new Set([...'ー－—―‐〜～…‥（）()「」『』［］[]｛｝{}〈〉《》【】＜＞<>＝=→←']);
const V_PUNCT = new Set([...'、。，．']);
const V_SMALL = new Set([...'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ']);

function drawVerticalText(b) {
  const fs = b.fontSize;
  const colW = fs * b.lineHeight;
  const maxChars = Math.max(1, Math.floor((b.h - b.pad * 2) / fs));

  // 改行で段落を分け、枠の高さを超える分は次の列へ折り返す
  const cols = [];
  for (const raw of b.text.split('\n')) {
    const chars = [...raw];
    if (chars.length === 0) { cols.push([]); continue; }
    for (let i = 0; i < chars.length; i += maxChars) {
      cols.push(chars.slice(i, i + maxChars));
    }
  }

  const maxColLen = Math.max(1, ...cols.map(c => c.length));
  const totalW = cols.length * colW;
  const topY = b.y + (b.h - maxColLen * fs) / 2 + fs / 2;
  let cx = b.x + b.w / 2 + totalW / 2 - colW / 2; // 右端の列から左へ

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const col of cols) {
    let cy = topY;
    for (const ch of col) {
      ctx.save();
      ctx.translate(cx, cy);
      if (V_ROTATE.has(ch)) {
        ctx.rotate(Math.PI / 2);
      } else if (V_PUNCT.has(ch)) {
        ctx.translate(fs * 0.55, -fs * 0.55);
      } else if (V_SMALL.has(ch)) {
        ctx.translate(fs * 0.1, -fs * 0.1);
      }
      strokeFillText(b, ch, 0, 0);
      ctx.restore();
      cy += fs;
    }
    cx -= colW;
  }
}

// --- 選択UI ---

// タッチ端末（粗いポインタ）ではハンドルの当たり判定・見た目を大きめに
const COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;

function displayScale() {
  const rect = canvas.getBoundingClientRect();
  return rect.width > 0 ? canvas.width / rect.width : 1;
}

function handlePositions(b) {
  return [
    { x: b.x, y: b.y, pos: 'nw' },
    { x: b.x + b.w, y: b.y, pos: 'ne' },
    { x: b.x, y: b.y + b.h, pos: 'sw' },
    { x: b.x + b.w, y: b.y + b.h, pos: 'se' },
  ];
}

function drawSelectionUI(b) {
  const s = displayScale();
  ctx.save();
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 1.5 * s;
  ctx.setLineDash([5 * s, 4 * s]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  const r = (COARSE_POINTER ? 7 : 5) * s;
  for (const h of handlePositions(b)) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------- テンプレート管理 ----------------

async function addTemplateFromBlob(blob, name) {
  const tpl = {
    id: uid(),
    name: name || `テンプレート ${state.templates.length + 1}`,
    imageBlob: blob,
    boxes: [],
    updatedAt: Date.now(),
  };
  try {
    await dbPut(tpl);
  } catch (err) {
    toast('保存に失敗しました: ' + err.message, true);
    return;
  }
  state.templates.unshift(tpl);
  await loadTemplate(tpl.id);
  toast(`「${tpl.name}」を追加しました`);
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}

async function loadTemplate(id) {
  const tpl = state.templates.find(t => t.id === id);
  if (!tpl) return;
  let img;
  try {
    img = await loadImageFromBlob(tpl.imageBlob);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  state.templateId = tpl.id;
  state.name = tpl.name;
  state.img = img;
  state.imgBlob = tpl.imageBlob;
  state.boxes = structuredClone(tpl.boxes || []);
  state.selectedId = null;

  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  resetView();

  setMode('edit');
  render();
}

async function deleteTemplate(id) {
  const tpl = state.templates.find(t => t.id === id);
  if (!tpl) return;
  if (!confirm(`テンプレート「${tpl.name}」を削除しますか？`)) return;
  try {
    await dbDelete(id);
  } catch (err) {
    toast('削除に失敗しました: ' + err.message, true);
    return;
  }
  state.templates = state.templates.filter(t => t.id !== id);
  const url = thumbURLs.get(id);
  if (url) { URL.revokeObjectURL(url); thumbURLs.delete(id); }

  if (state.templateId === id) {
    state.templateId = null;
    state.name = '';
    state.img = null;
    state.imgBlob = null;
    state.boxes = [];
    state.selectedId = null;
  }
  renderPickScreen();
  syncSteps();
}

function renameTemplate(tpl) {
  const name = prompt('テンプレート名', tpl.name);
  if (name == null || !name.trim()) return;
  tpl.name = name.trim();
  tpl.updatedAt = Date.now();
  dbPut(tpl).catch(err => toast('保存に失敗しました: ' + err.message, true));
  if (state.templateId === tpl.id) state.name = tpl.name;
  renderTemplateGrid();
}

// 変更をデバウンスして自動保存
let saveTimer = null;
function autoSave() {
  if (!state.templateId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const tpl = state.templates.find(t => t.id === state.templateId);
    if (!tpl) return;
    tpl.name = state.name;
    tpl.boxes = structuredClone(state.boxes);
    tpl.updatedAt = Date.now();
    try {
      await dbPut(tpl);
    } catch (err) {
      toast('自動保存に失敗しました: ' + err.message, true);
    }
  }, 400);
}

// ---------------- ① えらぶ画面 ----------------

function renderPickScreen() {
  renderTemplateGrid();
  renderPresetGrid();
}

function makeCard({ thumbSrc, name, badge, active, onOpen, onDelete, onRename }) {
  const card = document.createElement('div');
  card.className = 'card' + (active ? ' active' : '');
  card.setAttribute('role', 'button');
  card.tabIndex = 0;

  const img = document.createElement('img');
  img.className = 'thumb';
  img.src = thumbSrc;
  img.alt = '';
  img.loading = 'lazy';
  img.draggable = false;
  card.appendChild(img);

  const nameEl = document.createElement('div');
  nameEl.className = 'card-name';
  nameEl.textContent = name;
  if (onRename) {
    nameEl.title = '名前を変更';
    nameEl.addEventListener('click', e => { e.stopPropagation(); onRename(); });
  }
  card.appendChild(nameEl);

  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = 'card-badge';
    badgeEl.textContent = badge;
    card.appendChild(badgeEl);
  }
  if (onDelete) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'card-del';
    del.textContent = '✕';
    del.setAttribute('aria-label', '削除');
    del.addEventListener('click', e => { e.stopPropagation(); onDelete(); });
    card.appendChild(del);
  }

  card.addEventListener('click', onOpen);
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
  });
  return card;
}

function renderTemplateGrid() {
  templateGrid.innerHTML = '';
  mineHead.hidden = state.templates.length === 0;
  for (const tpl of state.templates) {
    if (!thumbURLs.has(tpl.id)) thumbURLs.set(tpl.id, URL.createObjectURL(tpl.imageBlob));
    templateGrid.appendChild(makeCard({
      thumbSrc: thumbURLs.get(tpl.id),
      name: tpl.name,
      active: tpl.id === state.templateId,
      onOpen: () => loadTemplate(tpl.id),
      onDelete: () => deleteTemplate(tpl.id),
      onRename: () => renameTemplate(tpl),
    }));
  }
}

function renderPresetGrid() {
  presetGrid.innerHTML = '';
  presetHead.hidden = presets.length === 0;
  for (const preset of presets) {
    presetGrid.appendChild(makeCard({
      thumbSrc: 'templates/' + encodeURIComponent(preset.file),
      name: preset.name || preset.file.replace(/\.[^.]+$/, ''),
      badge: 'preset',
      onOpen: () => importPreset(preset),
    }));
  }
}

async function loadPresets() {
  // file:// 直開きなど fetch できない環境では黙ってスキップ
  let manifest;
  try {
    const res = await fetch('templates/manifest.json', { cache: 'no-cache' });
    if (!res.ok) return;
    manifest = await res.json();
  } catch {
    return;
  }
  presets = (manifest.templates || []).filter(p => p && p.file);
  renderPresetGrid();
}

async function importPreset(preset) {
  const id = 'preset:' + preset.file;
  // 取り込み済みならそれを開く（枠レイアウトを保持）
  if (state.templates.some(t => t.id === id)) {
    await loadTemplate(id);
    return;
  }
  let blob;
  try {
    const res = await fetch('templates/' + encodeURIComponent(preset.file));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch (err) {
    toast('プリセットの取得に失敗しました: ' + err.message, true);
    return;
  }
  const tpl = {
    id,
    name: preset.name || preset.file.replace(/\.[^.]+$/, ''),
    imageBlob: blob,
    boxes: [],
    updatedAt: Date.now(),
  };
  try {
    await dbPut(tpl);
  } catch (err) {
    toast('保存に失敗しました: ' + err.message, true);
    return;
  }
  state.templates.unshift(tpl);
  await loadTemplate(id);
  toast(`プリセット「${tpl.name}」を取り込みました`);
}

// ---------------- ② つくる画面: ボトムエディタ ----------------

let openTool = null;  // 開いているツールポップオーバー
let shownId = null;   // エディタが表示している枠（テキスト入力中の作り直し防止）

const TOOL_ICONS = {
  size: '<svg viewBox="0 0 24 24"><path d="M4 19 9 5l5 14M6 14h6"/><path d="M18 8v9M15.5 10.5 18 8l2.5 2.5M15.5 14.5 18 17l2.5-2.5"/></svg>',
  font: '<svg viewBox="0 0 24 24"><path d="M5 6h14M12 6v13M9 19h6"/></svg>',
  color: '<svg viewBox="0 0 24 24"><path d="M12 3C8 9 6 12 6 15a6 6 0 0 0 12 0c0-3-2-6-6-12z"/></svg>',
  align: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h16"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  done: '<svg viewBox="0 0 24 24"><path d="M4 12.5 10 18.5 20 6"/></svg>',
};

function chipLabel(b, i) {
  const label = (b.text || '').trim().split('\n')[0].slice(0, 6);
  return label ? `${i + 1}. ${label}` : `枠${i + 1}`;
}

function renderEditor() {
  editorEl.innerHTML = '';
  shownId = state.selectedId;
  openTool = null;
  if (!state.img) return;
  editHint.hidden = state.boxes.length > 0;

  // 枠切替バー（横スクロールのチップ + 追加）
  const bar = document.createElement('div');
  bar.className = 'me-boxbar';
  state.boxes.forEach((b, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'me-chip' + (b.id === state.selectedId ? ' active' : '');
    chip.dataset.boxId = b.id;
    chip.textContent = chipLabel(b, i);
    chip.addEventListener('click', () => {
      state.selectedId = b.id;
      updateBoxSelection();
      scheduleRender();
    });
    bar.appendChild(chip);
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'me-add';
  add.textContent = '＋ 枠を追加';
  add.addEventListener('click', addBoxCentered);
  bar.appendChild(add);
  editorEl.appendChild(bar);

  const sel = getSelected();

  // テキスト入力（枠選択中のみ）
  if (sel) {
    const ta = document.createElement('textarea');
    ta.className = 'me-text';
    ta.placeholder = 'テキストを入力';
    ta.value = sel.text;
    ta.addEventListener('input', () => {
      sel.text = ta.value;
      scheduleRender();
      autoSave();
      const chip = bar.querySelector('.me-chip.active');
      if (chip) chip.textContent = chipLabel(sel, state.boxes.indexOf(sel));
    });
    ta.addEventListener('focus', () => setTool(null));
    editorEl.appendChild(ta);
  } else {
    const empty = document.createElement('div');
    empty.className = 'me-empty';
    empty.innerHTML = state.boxes.length
      ? '枠をタップして選ぶと文字を編集できます。'
      : '画像の上をドラッグするか「＋ 枠を追加」で<br>テキスト枠をつくりましょう。';
    editorEl.appendChild(empty);
  }

  // ポップオーバー（ツールの詳細設定。開いた時だけ中身を作る）
  const pop = document.createElement('div');
  pop.className = 'me-popover';
  pop.hidden = true;
  editorEl.appendChild(pop);

  // ツールバー
  const tb = document.createElement('div');
  tb.className = 'me-toolbar';
  const tools = [
    { key: 'size', label: 'サイズ' },
    { key: 'font', label: 'フォント' },
    { key: 'color', label: '色' },
    { key: 'align', label: '配置' },
    { key: 'del', label: '削除', danger: true },
  ];
  const toolBtns = {};
  tools.forEach(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'me-tool' + (t.danger ? ' danger' : '');
    btn.disabled = !sel;
    btn.innerHTML = `<span class="me-tool-ico">${TOOL_ICONS[t.key]}</span><span class="me-tool-label">${t.label}</span>`;
    btn.addEventListener('click', () => {
      if (t.key === 'del') { setTool(null); deleteBox(sel.id); return; }
      setTool(openTool === t.key ? null : t.key);
    });
    toolBtns[t.key] = btn;
    tb.appendChild(btn);
  });
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'me-tool primary';
  done.innerHTML = `<span class="me-tool-ico">${TOOL_ICONS.done}</span><span class="me-tool-label">できた！</span>`;
  done.addEventListener('click', () => enterDone());
  tb.appendChild(done);
  editorEl.appendChild(tb);

  const upd = () => { scheduleRender(); autoSave(); };

  function setTool(key) {
    openTool = key;
    for (const k of Object.keys(toolBtns)) toolBtns[k].classList.toggle('active', k === key);
    if (!key) { pop.hidden = true; pop.innerHTML = ''; return; }
    pop.innerHTML = buildPopover(key, sel);
    wirePopover(key, pop, sel, upd);
    pop.hidden = false;
  }
}

function buildPopover(key, b) {
  if (key === 'size') {
    return `<div class="me-pop-title">文字サイズ</div>
      <div class="me-row">
        <button type="button" class="me-step" data-d="-2">−</button>
        <input type="range" class="me-range" min="8" max="160" value="${Math.min(160, b.fontSize)}">
        <button type="button" class="me-step" data-d="2">＋</button>
        <span class="me-val">${b.fontSize}</span>
      </div>`;
  }
  if (key === 'font') {
    return `<div class="me-pop-title">フォント</div>
      <div class="me-row">
        <select class="me-font">${Object.keys(FONTS).map(k =>
          `<option value="${k}" ${b.font === k ? 'selected' : ''}>${FONT_LABELS[k]}</option>`).join('')}</select>
        <label class="me-check"><input type="checkbox" class="me-bold" ${b.bold ? 'checked' : ''}><span>太字</span></label>
      </div>`;
  }
  if (key === 'color') {
    return `<div class="me-pop-title">色</div>
      <div class="me-row"><span class="me-row-label">文字色</span><input type="color" class="me-color" value="${b.color}"></div>
      <div class="me-row"><label class="me-check"><input type="checkbox" class="me-bgon" ${b.bg ? 'checked' : ''}><span>背景</span></label><input type="color" class="me-bgcolor" value="${b.bgColor}"></div>
      <div class="me-row"><label class="me-check"><input type="checkbox" class="me-olon" ${b.outline ? 'checked' : ''}><span>縁取り</span></label><input type="color" class="me-olcolor" value="${b.outlineColor}"></div>`;
  }
  if (key === 'align') {
    return `<div class="me-pop-title">配置</div>
      <div class="me-row"><label class="me-check"><input type="checkbox" class="me-vertical" ${b.vertical ? 'checked' : ''}><span>縦書き</span></label></div>
      <div class="me-row"><div class="me-seg${b.vertical ? ' disabled' : ''}">
        <button type="button" data-a="left" class="${b.align === 'left' ? 'active' : ''}">左</button>
        <button type="button" data-a="center" class="${b.align === 'center' ? 'active' : ''}">中央</button>
        <button type="button" data-a="right" class="${b.align === 'right' ? 'active' : ''}">右</button>
      </div></div>`;
  }
  return '';
}

function wirePopover(key, pop, b, upd) {
  const q = s => pop.querySelector(s);
  if (key === 'size') {
    const range = q('.me-range'), val = q('.me-val');
    const apply = v => { b.fontSize = Math.max(8, Math.min(300, Math.round(v))); val.textContent = b.fontSize; range.value = Math.min(160, b.fontSize); upd(); };
    range.addEventListener('input', () => apply(Number(range.value)));
    pop.querySelectorAll('.me-step').forEach(s =>
      s.addEventListener('click', () => apply(b.fontSize + Number(s.dataset.d))));
  } else if (key === 'font') {
    q('.me-font').addEventListener('change', e => { b.font = e.target.value; upd(); });
    q('.me-bold').addEventListener('change', e => { b.bold = e.target.checked; upd(); });
  } else if (key === 'color') {
    q('.me-color').addEventListener('input', e => { b.color = e.target.value; upd(); });
    q('.me-bgon').addEventListener('change', e => { b.bg = e.target.checked; upd(); });
    q('.me-bgcolor').addEventListener('input', e => { b.bgColor = e.target.value; b.bg = true; q('.me-bgon').checked = true; upd(); });
    q('.me-olon').addEventListener('change', e => { b.outline = e.target.checked; upd(); });
    q('.me-olcolor').addEventListener('input', e => { b.outline = true; q('.me-olon').checked = true; b.outlineColor = e.target.value; upd(); });
  } else if (key === 'align') {
    const seg = q('.me-seg');
    q('.me-vertical').addEventListener('change', e => {
      b.vertical = e.target.checked;
      seg.classList.toggle('disabled', b.vertical);
      upd();
    });
    seg.querySelectorAll('button').forEach(btn =>
      btn.addEventListener('click', () => {
        if (b.vertical) return;
        b.align = btn.dataset.a;
        seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === btn));
        upd();
      }));
  }
}

// 選択が変わった時にエディタを追従（テキスト入力中は作り直さない）
function updateBoxSelection() {
  if (state.selectedId === shownId) {
    editorEl.querySelectorAll('.me-chip').forEach(c =>
      c.classList.toggle('active', c.dataset.boxId === state.selectedId));
    return;
  }
  renderEditor();
}

function focusEditorText() {
  const ta = editorEl.querySelector('.me-text');
  if (ta) { ta.focus(); ta.select(); }
}

function addBoxCentered() {
  if (!state.img) return;
  const w = Math.round(canvas.width * 0.3);
  const h = Math.round(canvas.height * 0.15);
  const box = newBox(Math.round((canvas.width - w) / 2), Math.round((canvas.height - h) / 2), w, h);
  state.boxes.push(box);
  state.selectedId = box.id;
  renderEditor();
  scheduleRender();
  autoSave();
  focusEditorText();
}

function deleteBox(id) {
  state.boxes = state.boxes.filter(b => b.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  renderEditor();
  scheduleRender();
  autoSave();
}

// ---------------- ビュー（二本指ピンチで拡大・パン） ----------------
// CSS transform でキャンバス表示だけを拡大する。getBoundingClientRect は
// transform 込みの値を返すため、canvasPos / displayScale はそのまま追従する。

const view = { scale: 1, tx: 0, ty: 0 };
const MAX_SCALE = 6;

function applyView() {
  canvas.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
  btnResetView.hidden = view.scale === 1;
}

function resetView() {
  view.scale = 1;
  view.tx = 0;
  view.ty = 0;
  applyView();
}

// transform 適用前のレイアウト上の左上（transform の基準点）
function layoutOrigin() {
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left - view.tx, y: rect.top - view.ty };
}

// キャンバスが表示領域から迷子にならないように平行移動を制限する
function clampView(L) {
  const stage = canvasWrap.getBoundingClientRect();
  const clampAxis = (pos, size, stagePos, stageSize) => {
    // 表示領域より小さい間は領域内に収め、大きい間は隙間ができないように挟む
    const min = size <= stageSize ? stagePos : stagePos + stageSize - size;
    const max = size <= stageSize ? stagePos + stageSize - size : stagePos;
    return Math.min(max, Math.max(min, pos));
  };
  const w = canvas.offsetWidth * view.scale;
  const h = canvas.offsetHeight * view.scale;
  view.tx = clampAxis(L.x + view.tx, w, stage.left, stage.width) - L.x;
  view.ty = clampAxis(L.y + view.ty, h, stage.top, stage.height) - L.y;
}

// 画面上の点 (cx, cy) の直下を固定したままズームする
function zoomAt(cx, cy, scale) {
  const next = Math.min(MAX_SCALE, Math.max(1, scale));
  if (next === 1) { resetView(); return; }
  const rect = canvas.getBoundingClientRect();
  const L = { x: rect.left - view.tx, y: rect.top - view.ty };
  const px = (cx - rect.left) / view.scale;
  const py = (cy - rect.top) / view.scale;
  view.scale = next;
  view.tx = cx - L.x - next * px;
  view.ty = cy - L.y - next * py;
  clampView(L);
  applyView();
}

btnResetView.addEventListener('click', resetView);

// PC: トラックパッドのピンチ（Ctrl+ホイールとして届く）と Ctrl+ホイール
canvasWrap.addEventListener('wheel', e => {
  if (!state.img || !e.ctrlKey) return;
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, view.scale * Math.exp(-e.deltaY * 0.01));
}, { passive: false });

// デスクトップSafariのトラックパッドピンチは gesture イベントでのみ届く
// （タッチ端末では pointer イベント側のピンチと二重処理になるため付けない）
if (!COARSE_POINTER && typeof GestureEvent !== 'undefined') {
  let gestureBase = 1;
  canvasWrap.addEventListener('gesturestart', e => { e.preventDefault(); gestureBase = view.scale; });
  canvasWrap.addEventListener('gesturechange', e => {
    e.preventDefault();
    if (state.img) zoomAt(e.clientX, e.clientY, gestureBase * e.scale);
  });
  canvasWrap.addEventListener('gestureend', e => e.preventDefault());
}

// ---------------- キャンバス操作（移動・リサイズ・新規作成・ピンチ） ----------------

let drag = null; // {mode, start, orig, handle, created}
const activePointers = new Map(); // pointerId -> {x, y}
let pinch = null; // {d0, m0, L, scale0, tx0, ty0}

function canvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * canvas.width / rect.width,
    y: (e.clientY - rect.top) * canvas.height / rect.height,
  };
}

function hitHandle(b, p) {
  const tol = (COARSE_POINTER ? 18 : 10) * displayScale();
  for (const h of handlePositions(b)) {
    if (Math.hypot(p.x - h.x, p.y - h.y) <= tol) return h.pos;
  }
  return null;
}

function hitBox(p) {
  for (let i = state.boxes.length - 1; i >= 0; i--) {
    const b = state.boxes[i];
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return b;
  }
  return null;
}

const HANDLE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };

function pointerDist() {
  const [a, b] = [...activePointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y) || 1;
}

function pointerMid() {
  const [a, b] = [...activePointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function startPinch() {
  // 枠ドラッグ中に2本目の指が触れたら、枠を動かさずピンチへ切り替える
  if (drag) {
    if (drag.mode === 'create') {
      state.boxes = state.boxes.filter(b => b.id !== drag.created);
      state.selectedId = null;
      updateBoxSelection();
    } else {
      const sel = getSelected();
      if (sel) Object.assign(sel, { x: drag.orig.x, y: drag.orig.y, w: drag.orig.w, h: drag.orig.h });
    }
    drag = null;
    scheduleRender();
  }
  pinch = {
    d0: pointerDist(),
    m0: pointerMid(),
    L: layoutOrigin(),
    scale0: view.scale,
    tx0: view.tx,
    ty0: view.ty,
  };
}

function movePinch() {
  const m1 = pointerMid();
  const next = Math.min(MAX_SCALE, Math.max(1, pinch.scale0 * pointerDist() / pinch.d0));
  // ピンチ開始時に中点の直下にあったコンテンツ点を、現在の中点に追従させる
  const px = (pinch.m0.x - pinch.L.x - pinch.tx0) / pinch.scale0;
  const py = (pinch.m0.y - pinch.L.y - pinch.ty0) / pinch.scale0;
  view.scale = next;
  view.tx = m1.x - pinch.L.x - next * px;
  view.ty = m1.y - pinch.L.y - next * py;
  clampView(pinch.L);
  applyView();
}

canvasWrap.addEventListener('pointerdown', e => {
  if (!state.img || e.button !== 0) return;
  if (e.target.closest('.view-reset')) return; // リセットボタンはそのまま押させる
  e.preventDefault();
  canvasWrap.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // 2本目の指でピンチ開始（余白に落ちた指も起点にできる）
  if (activePointers.size === 2) { startPinch(); return; }
  if (activePointers.size > 2 || pinch) return;
  if (e.target !== canvas) return; // 余白のシングルタップは枠操作の対象外

  const p = canvasPos(e);

  const sel = getSelected();
  if (sel) {
    const handle = hitHandle(sel, p);
    if (handle) {
      drag = { mode: 'resize', start: p, orig: { ...sel }, handle };
      return;
    }
  }

  const hit = hitBox(p);
  if (hit) {
    if (state.selectedId !== hit.id) {
      state.selectedId = hit.id;
      updateBoxSelection();
    }
    drag = { mode: 'move', start: p, orig: { ...hit } };
    scheduleRender();
    return;
  }

  // 空白部分: ドラッグで新規枠を作成
  const box = newBox(p.x, p.y, 0, 0);
  box.fontSize = Math.max(16, Math.round(canvas.height * 0.04));
  state.boxes.push(box);
  state.selectedId = box.id;
  drag = { mode: 'create', start: p, created: box.id };
  scheduleRender();
});

canvasWrap.addEventListener('pointermove', e => {
  if (!state.img) return;
  if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch) {
    if (activePointers.size >= 2) movePinch();
    return;
  }
  const p = canvasPos(e);

  if (!drag) {
    // カーソル形状のフィードバック
    const sel = getSelected();
    const handle = sel && hitHandle(sel, p);
    canvas.style.cursor = handle ? HANDLE_CURSORS[handle] : hitBox(p) ? 'move' : 'crosshair';
    return;
  }

  const sel = getSelected();
  if (!sel) return;
  const dx = p.x - drag.start.x;
  const dy = p.y - drag.start.y;

  if (drag.mode === 'move') {
    sel.x = Math.round(drag.orig.x + dx);
    sel.y = Math.round(drag.orig.y + dy);
  } else if (drag.mode === 'resize') {
    const o = drag.orig;
    let { x, y, w, h } = o;
    if (drag.handle.includes('w')) { x = o.x + dx; w = o.w - dx; }
    if (drag.handle.includes('e')) { w = o.w + dx; }
    if (drag.handle.includes('n')) { y = o.y + dy; h = o.h - dy; }
    if (drag.handle.includes('s')) { h = o.h + dy; }
    if (w < 20) { if (drag.handle.includes('w')) x = o.x + o.w - 20; w = 20; }
    if (h < 20) { if (drag.handle.includes('n')) y = o.y + o.h - 20; h = 20; }
    Object.assign(sel, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  } else if (drag.mode === 'create') {
    sel.x = Math.round(Math.min(drag.start.x, p.x));
    sel.y = Math.round(Math.min(drag.start.y, p.y));
    sel.w = Math.round(Math.abs(p.x - drag.start.x));
    sel.h = Math.round(Math.abs(p.y - drag.start.y));
  }
  scheduleRender();
});

function releasePointer(e, cancelled) {
  activePointers.delete(e.pointerId);

  if (pinch) {
    if (activePointers.size < 2) {
      pinch = null;
      if (view.scale <= 1) resetView(); // 最小倍率でのパンずれを戻す
    }
    return;
  }
  if (!drag) return;
  const d = drag;
  drag = null;

  if (d.mode === 'create') {
    const box = state.boxes.find(b => b.id === d.created);
    if (!box) return;
    if (cancelled || box.w < 15 || box.h < 15) {
      // クリックのみ／中断 → 作成キャンセル（選択解除として扱う）
      state.boxes = state.boxes.filter(b => b.id !== d.created);
      state.selectedId = null;
      updateBoxSelection();
      scheduleRender();
      return;
    }
    box.fontSize = Math.max(12, Math.round(box.h * 0.35));
    renderEditor();
    scheduleRender();
    autoSave();
    focusEditorText();
    return;
  }
  autoSave();
}

canvasWrap.addEventListener('pointerup', e => releasePointer(e, false));
canvasWrap.addEventListener('pointercancel', e => releasePointer(e, true));

canvas.addEventListener('dblclick', () => {
  if (state.selectedId) focusEditorText();
});

// キーボード: Delete で削除、矢印キーで移動、Esc で戻る/選択解除
document.addEventListener('keydown', e => {
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';
  if (typing) return;

  if (mode === 'done' && e.key === 'Escape') {
    setMode('edit');
    return;
  }
  if (mode !== 'edit') return;
  const sel = getSelected();
  if (!sel) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteBox(sel.id);
  } else if (e.key === 'Escape') {
    state.selectedId = null;
    updateBoxSelection();
    scheduleRender();
  } else if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') sel.x -= step;
    if (e.key === 'ArrowRight') sel.x += step;
    if (e.key === 'ArrowUp') sel.y -= step;
    if (e.key === 'ArrowDown') sel.y += step;
    scheduleRender();
    autoSave();
  }
});

// ---------------- 画像の追加（ファイル / D&D / ペースト） ----------------

fileInput.addEventListener('change', async () => {
  for (const file of fileInput.files) {
    await addTemplateFromBlob(file, file.name.replace(/\.[^.]+$/, ''));
  }
  fileInput.value = '';
});

// どの画面でもドロップで追加できるように window 全体で受ける
function dragHasFiles(e) {
  return e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
}
let dragDepth = 0;
window.addEventListener('dragenter', e => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', e => {
  if (dragHasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', e => {
  if (!dragHasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('drop', async e => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  for (const file of e.dataTransfer.files) {
    if (file.type.startsWith('image/')) {
      await addTemplateFromBlob(file, file.name.replace(/\.[^.]+$/, ''));
    }
  }
});

document.addEventListener('paste', async e => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      await addTemplateFromBlob(item.getAsFile(), '');
      return;
    }
  }
});

// ---------------- ③ できた画面: 出力 ----------------

let resultBlob = null;
let resultURL = null;

function exportBlob() {
  return new Promise((resolve, reject) => {
    render(true); // 選択UIなしで描画
    canvas.toBlob(blob => {
      render(); // 編集表示に戻す
      if (blob) resolve(blob);
      else reject(new Error('PNGの生成に失敗しました'));
    }, 'image/png');
  });
}

function makeShareFile(blob) {
  return new File([blob], `${state.name || 'meme'}.png`, { type: 'image/png' });
}

function canShareFile(blob) {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [makeShareFile(blob)] }));
  } catch {
    return false;
  }
}

async function enterDone() {
  if (!state.img) return;
  let blob;
  try {
    blob = await exportBlob();
  } catch (err) {
    toast(err.message, true);
    return;
  }
  resultBlob = blob;
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultURL = URL.createObjectURL(blob);
  resultImg.src = resultURL;
  const sharable = canShareFile(blob);
  btnShare.hidden = !sharable;
  btnSave.classList.toggle('primary', !sharable);
  setMode('done');
}

function downloadBlob(blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.name || 'meme'}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

btnShare.addEventListener('click', async () => {
  if (!resultBlob) return;
  try {
    await navigator.share({ files: [makeShareFile(resultBlob)] });
  } catch (err) {
    if (err && err.name !== 'AbortError') toast('共有できませんでした: ' + err.message, true);
  }
});

btnSave.addEventListener('click', () => {
  if (!resultBlob) return;
  downloadBlob(resultBlob);
  toast('PNGを保存しました');
});

btnCopy.addEventListener('click', async () => {
  if (!resultBlob) return;
  try {
    if (!navigator.clipboard || !window.ClipboardItem) {
      throw new Error('このブラウザは画像コピーに未対応です（PNG保存を使ってください）');
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': resultBlob })]);
    toast('クリップボードにコピーしました');
  } catch (err) {
    toast('コピーに失敗しました: ' + err.message, true);
  }
});

btnBack.addEventListener('click', () => setMode('edit'));

// Cmd/Ctrl+S で即PNG保存
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (!state.img) return;
    exportBlob()
      .then(blob => { downloadBlob(blob); toast('PNGを保存しました'); })
      .catch(err => toast(err.message, true));
  }
});

// ---------------- トースト ----------------

let toastTimer = null;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// ---------------- 初期化 ----------------

(async function init() {
  try {
    db = await openDB();
    state.templates = (await dbAll()).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    toast('初期化に失敗しました: ' + err.message, true);
  }
  setMode('pick');
  loadPresets();
})();
