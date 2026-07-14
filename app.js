'use strict';

/* ================================================================
 * クソミーム・メーカー
 * テンプレート画像にテキスト枠を重ねてPNG出力するローカルGUIツール。
 * データはブラウザの IndexedDB に保存される（サーバー不要）。
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

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const canvasWrap = document.getElementById('canvasWrap');
const emptyState = document.getElementById('emptyState');
const templateListEl = document.getElementById('templateList');
const boxListEl = document.getElementById('boxList');
const tplNameInput = document.getElementById('tplName');
const saveStatusEl = document.getElementById('saveStatus');
const fileInput = document.getElementById('fileInput');
const btnAddBox = document.getElementById('btnAddBox');
const btnSave = document.getElementById('btnSave');
const btnCopy = document.getElementById('btnCopy');
const toastEl = document.getElementById('toast');

const thumbURLs = new Map(); // templateId -> objectURL

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
  renderTemplateList();
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
  canvas.classList.add('visible');
  emptyState.style.display = 'none';

  tplNameInput.disabled = false;
  tplNameInput.value = tpl.name;
  btnAddBox.disabled = false;
  btnSave.disabled = false;
  btnCopy.disabled = false;
  saveStatusEl.textContent = '';

  renderTemplateList();
  renderEditor();
  render();
}

async function deleteTemplate(id) {
  const tpl = state.templates.find(t => t.id === id);
  if (!tpl) return;
  if (!confirm(`テンプレート「${tpl.name}」を削除しますか？`)) return;
  await dbDelete(id);
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
    canvas.classList.remove('visible');
    emptyState.style.display = '';
    tplNameInput.value = '';
    tplNameInput.disabled = true;
    btnAddBox.disabled = true;
    btnSave.disabled = true;
    btnCopy.disabled = true;
    renderEditor();
    if (state.templates.length > 0) await loadTemplate(state.templates[0].id);
  }
  renderTemplateList();
}

// 変更をデバウンスして自動保存
let saveTimer = null;
function autoSave() {
  if (!state.templateId) return;
  saveStatusEl.textContent = '保存中…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const tpl = state.templates.find(t => t.id === state.templateId);
    if (!tpl) return;
    tpl.name = state.name;
    tpl.boxes = structuredClone(state.boxes);
    tpl.updatedAt = Date.now();
    try {
      await dbPut(tpl);
      saveStatusEl.textContent = '保存済み';
    } catch (err) {
      saveStatusEl.textContent = '';
      toast('自動保存に失敗しました: ' + err.message, true);
    }
  }, 400);
}

function renderTemplateList() {
  templateListEl.innerHTML = '';
  for (const tpl of state.templates) {
    const item = document.createElement('div');
    item.className = 'tpl-item' + (tpl.id === state.templateId ? ' active' : '');

    const img = document.createElement('img');
    if (!thumbURLs.has(tpl.id)) thumbURLs.set(tpl.id, URL.createObjectURL(tpl.imageBlob));
    img.src = thumbURLs.get(tpl.id);
    img.alt = '';

    const name = document.createElement('span');
    name.className = 'tpl-name';
    name.textContent = tpl.name;

    const del = document.createElement('button');
    del.className = 'tpl-del';
    del.textContent = '✕';
    del.title = '削除';
    del.addEventListener('click', e => { e.stopPropagation(); deleteTemplate(tpl.id); });

    item.append(img, name, del);
    item.addEventListener('click', () => loadTemplate(tpl.id));
    templateListEl.appendChild(item);
  }
}

// ---------------- テキスト枠エディタ（右パネル） ----------------

function renderBoxList() {
  boxListEl.innerHTML = '';
  if (!state.img) return;

  if (state.boxes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-boxes';
    empty.innerHTML = 'テキスト枠がありません。<br>画像の上をドラッグするか<br>「＋枠を追加」を押してください。';
    boxListEl.appendChild(empty);
    return;
  }

  state.boxes.forEach((box, i) => {
    const item = document.createElement('div');
    item.className = 'box-item' + (box.id === state.selectedId ? ' selected' : '');
    item.dataset.boxId = box.id;
    item.innerHTML = `
      <textarea placeholder="テキスト">${escapeHTML(box.text)}</textarea>
      <div class="box-controls">
        <span class="ctrl">サイズ <input type="number" class="c-size" min="8" max="300" value="${box.fontSize}"></span>
        <span class="ctrl"><label><input type="checkbox" class="c-vertical" ${box.vertical ? 'checked' : ''}>縦書き</label></span>
        <span class="ctrl">フォント <select class="c-font">${Object.keys(FONTS).map(k =>
          `<option value="${k}" ${box.font === k ? 'selected' : ''}>${FONT_LABELS[k]}</option>`).join('')}</select></span>
        <span class="ctrl"><label><input type="checkbox" class="c-bold" ${box.bold ? 'checked' : ''}>太字</label></span>
        <span class="ctrl">文字色 <input type="color" class="c-color" value="${box.color}"></span>
        <span class="ctrl"><label><input type="checkbox" class="c-bg" ${box.bg ? 'checked' : ''}>背景</label><input type="color" class="c-bgcolor" value="${box.bgColor}"></span>
        <span class="ctrl"><label><input type="checkbox" class="c-outline" ${box.outline ? 'checked' : ''}>縁取り</label><input type="color" class="c-outlinecolor" value="${box.outlineColor}"></span>
        <span class="ctrl">配置 <select class="c-align" ${box.vertical ? 'disabled' : ''}>
          <option value="center" ${box.align === 'center' ? 'selected' : ''}>中央</option>
          <option value="left" ${box.align === 'left' ? 'selected' : ''}>左</option>
          <option value="right" ${box.align === 'right' ? 'selected' : ''}>右</option>
        </select></span>
      </div>
      <button class="box-del">枠を削除</button>
    `;

    const q = sel => item.querySelector(sel);
    const update = (fn) => { fn(); scheduleRender(); autoSave(); };

    item.addEventListener('click', () => {
      if (state.selectedId !== box.id) {
        state.selectedId = box.id;
        updateBoxSelection();
        scheduleRender();
      }
    });

    q('textarea').addEventListener('input', e => update(() => { box.text = e.target.value; }));
    q('.c-size').addEventListener('input', e => update(() => {
      box.fontSize = Math.max(8, Math.min(300, Number(e.target.value) || box.fontSize));
    }));
    q('.c-vertical').addEventListener('change', e => update(() => {
      box.vertical = e.target.checked;
      q('.c-align').disabled = box.vertical;
    }));
    q('.c-font').addEventListener('change', e => update(() => { box.font = e.target.value; }));
    q('.c-bold').addEventListener('change', e => update(() => { box.bold = e.target.checked; }));
    q('.c-color').addEventListener('input', e => update(() => { box.color = e.target.value; }));
    q('.c-bg').addEventListener('change', e => update(() => { box.bg = e.target.checked; }));
    q('.c-bgcolor').addEventListener('input', e => update(() => { box.bgColor = e.target.value; box.bg = true; q('.c-bg').checked = true; }));
    q('.c-outline').addEventListener('change', e => update(() => { box.outline = e.target.checked; }));
    q('.c-outlinecolor').addEventListener('input', e => update(() => { box.outlineColor = e.target.value; box.outline = true; q('.c-outline').checked = true; }));
    q('.c-align').addEventListener('change', e => update(() => { box.align = e.target.value; }));
    q('.box-del').addEventListener('click', e => {
      e.stopPropagation();
      deleteBox(box.id);
    });

    boxListEl.appendChild(item);
  });
}

// 選択状態のハイライトだけ更新（テキスト入力中のフォーカスを壊さない）
function updateBoxSelection() {
  for (const el of boxListEl.querySelectorAll('.box-item')) {
    el.classList.toggle('selected', el.dataset.boxId === state.selectedId);
  }
  syncMobileSelection();
}

// デスクトップの右パネルとスマホのボトムエディタを両方更新
function renderEditor() {
  renderBoxList();
  renderMobileEditor();
}

// ---------------- テキスト枠エディタ（スマホ用ボトムツールバー） ----------------

const mobileEditorEl = document.getElementById('mobileEditor');
let meOpenTool = null; // スマホエディタで開いているツール

const ME_ICONS = {
  size: '<svg viewBox="0 0 24 24"><path d="M4 19 9 5l5 14M6 14h6"/><path d="M18 8v9M15.5 10.5 18 8l2.5 2.5M15.5 14.5 18 17l2.5-2.5"/></svg>',
  font: '<svg viewBox="0 0 24 24"><path d="M5 6h14M12 6v13M9 19h6"/></svg>',
  color: '<svg viewBox="0 0 24 24"><path d="M12 3C8 9 6 12 6 15a6 6 0 0 0 12 0c0-3-2-6-6-12z"/></svg>',
  align: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h16"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
};

// スマホエディタが今表示している枠。選択が変わった時だけ作り直す。
let meShownId = null;

function renderMobileEditor() {
  if (!mobileEditorEl) return;
  mobileEditorEl.innerHTML = '';
  meShownId = state.selectedId;
  if (!state.img) return;

  // 枠切替バー（横スクロールのチップ + 追加）
  const bar = document.createElement('div');
  bar.className = 'me-boxbar';
  state.boxes.forEach((b, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'me-chip' + (b.id === state.selectedId ? ' active' : '');
    const label = (b.text || '').trim().split('\n')[0].slice(0, 6);
    chip.textContent = label ? `${i + 1}. ${label}` : `枠${i + 1}`;
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
  add.setAttribute('aria-label', '枠を追加');
  add.textContent = '＋';
  add.addEventListener('click', addBoxCentered);
  bar.appendChild(add);
  mobileEditorEl.appendChild(bar);

  const sel = getSelected();
  if (!sel) {
    const empty = document.createElement('div');
    empty.className = 'me-empty';
    empty.innerHTML = state.boxes.length
      ? '上のバーで枠を選ぶか、<br>キャンバスの枠をタップしてください。'
      : 'テキスト枠がありません。<br>キャンバスをドラッグ／上の ＋ で追加。';
    mobileEditorEl.appendChild(empty);
    return;
  }

  // テキスト入力
  const ta = document.createElement('textarea');
  ta.className = 'me-text';
  ta.placeholder = 'テキストを入力';
  ta.value = sel.text;
  ta.addEventListener('input', () => { sel.text = ta.value; scheduleRender(); autoSave(); });
  ta.addEventListener('focus', () => setTool(null));
  mobileEditorEl.appendChild(ta);

  // ポップオーバー（ツールの詳細設定。開いた時だけ中身を作る）
  const pop = document.createElement('div');
  pop.className = 'me-popover';
  pop.hidden = true;
  mobileEditorEl.appendChild(pop);

  // ボトムツールバー
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
    btn.dataset.tool = t.key;
    btn.innerHTML = `<span class="me-tool-ico">${ME_ICONS[t.key]}</span><span class="me-tool-label">${t.label}</span>`;
    btn.addEventListener('click', () => {
      if (t.key === 'del') { setTool(null); deleteBox(sel.id); return; }
      setTool(meOpenTool === t.key ? null : t.key);
    });
    toolBtns[t.key] = btn;
    tb.appendChild(btn);
  });
  mobileEditorEl.appendChild(tb);

  const upd = () => { scheduleRender(); autoSave(); };

  function setTool(key) {
    meOpenTool = key;
    for (const k of Object.keys(toolBtns)) toolBtns[k].classList.toggle('active', k === key);
    if (!key) { pop.hidden = true; pop.innerHTML = ''; return; }
    pop.innerHTML = buildPopover(key, sel);
    wirePopover(key, pop, sel, upd);
    pop.hidden = false;
  }

  meOpenTool = null;
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

// 選択が変わった時にスマホエディタを追従（テキスト入力中は作り直さない）
function syncMobileSelection() {
  if (!mobileEditorEl) return;
  if (state.selectedId === meShownId) {
    // 同じ枠 → チップのハイライトだけ更新（フォーカス維持）
    mobileEditorEl.querySelectorAll('.me-chip').forEach((c, i) =>
      c.classList.toggle('active', state.boxes[i] && state.boxes[i].id === state.selectedId));
    return;
  }
  renderMobileEditor();
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  setMobileTab('boxes');
  focusSelectedTextarea();
}

function deleteBox(id) {
  state.boxes = state.boxes.filter(b => b.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  renderEditor();
  scheduleRender();
  autoSave();
}

function focusSelectedTextarea() {
  const item = boxListEl.querySelector(`.box-item[data-box-id="${state.selectedId}"] textarea`);
  if (item) { item.focus(); item.select(); }
}

// ---------------- キャンバス操作（移動・リサイズ・新規作成） ----------------

let drag = null; // {mode, start, orig, handle, created}

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

canvas.addEventListener('pointerdown', e => {
  if (!state.img || e.button !== 0) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
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

canvas.addEventListener('pointermove', e => {
  if (!state.img) return;
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

canvas.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag;
  drag = null;

  if (d.mode === 'create') {
    const box = state.boxes.find(b => b.id === d.created);
    if (box && (box.w < 15 || box.h < 15)) {
      // クリックのみ → 作成キャンセル（選択解除として扱う）
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
    setMobileTab('boxes');
    focusSelectedTextarea();
    return;
  }
  autoSave();
});

canvas.addEventListener('dblclick', () => {
  if (state.selectedId) focusSelectedTextarea();
});

// キーボード: Delete で削除、矢印キーで移動、Esc で選択解除
document.addEventListener('keydown', e => {
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT';
  if (typing) return;
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

canvasWrap.addEventListener('dragover', e => {
  e.preventDefault();
  canvasWrap.classList.add('dragover');
});
canvasWrap.addEventListener('dragleave', () => canvasWrap.classList.remove('dragover'));
canvasWrap.addEventListener('drop', async e => {
  e.preventDefault();
  canvasWrap.classList.remove('dragover');
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

// ---------------- 出力 ----------------

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

btnSave.addEventListener('click', async () => {
  try {
    const blob = await exportBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.name || 'meme'}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('PNGを保存しました');
  } catch (err) {
    toast(err.message, true);
  }
});

btnCopy.addEventListener('click', async () => {
  try {
    if (!navigator.clipboard || !window.ClipboardItem) {
      throw new Error('このブラウザは画像コピーに未対応です（PNG保存を使ってください）');
    }
    render(true);
    const item = new ClipboardItem({
      'image/png': new Promise(resolve => canvas.toBlob(resolve, 'image/png')),
    });
    await navigator.clipboard.write([item]);
    render();
    toast('クリップボードにコピーしました');
  } catch (err) {
    render();
    toast('コピーに失敗しました: ' + err.message, true);
  }
});

// Cmd/Ctrl+S でPNG保存
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (!btnSave.disabled) btnSave.click();
  }
});

// ---------------- その他UI ----------------

tplNameInput.addEventListener('input', () => {
  state.name = tplNameInput.value;
  autoSave();
  const tpl = state.templates.find(t => t.id === state.templateId);
  if (tpl) {
    tpl.name = state.name;
    const active = templateListEl.querySelector('.tpl-item.active .tpl-name');
    if (active) active.textContent = state.name;
  }
});

btnAddBox.addEventListener('click', addBoxCentered);

// ---------------- モバイル用パネル切替タブ ----------------
const mobileTabsEl = document.getElementById('mobileTabs');
function setMobileTab(which) {
  document.body.classList.toggle('m-tab-boxes', which === 'boxes');
  document.body.classList.toggle('m-tab-templates', which === 'templates');
  mobileTabsEl.querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === which));
}
mobileTabsEl.querySelectorAll('button').forEach(b =>
  b.addEventListener('click', () => setMobileTab(b.dataset.tab)));
setMobileTab('templates');

let toastTimer = null;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// ---------------- プリセット（templates/manifest.json） ----------------

const presetSection = document.getElementById('presetSection');
const presetListEl = document.getElementById('presetList');

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
  const presets = (manifest.templates || []).filter(p => p && p.file);
  if (presets.length === 0) return;

  presetSection.hidden = false;
  presetListEl.innerHTML = '';
  for (const preset of presets) {
    const item = document.createElement('div');
    item.className = 'tpl-item';

    const img = document.createElement('img');
    img.src = 'templates/' + encodeURIComponent(preset.file);
    img.alt = '';
    img.loading = 'lazy';

    const name = document.createElement('span');
    name.className = 'tpl-name';
    name.textContent = preset.name || preset.file.replace(/\.[^.]+$/, '');

    const badge = document.createElement('span');
    badge.className = 'tpl-badge';
    badge.textContent = 'preset';

    item.append(img, name, badge);
    item.addEventListener('click', () => importPreset(preset));
    presetListEl.appendChild(item);
  }
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
  renderTemplateList();
  await loadTemplate(id);
  toast(`プリセット「${tpl.name}」を取り込みました`);
}

// ---------------- 初期化 ----------------

(async function init() {
  try {
    db = await openDB();
    state.templates = (await dbAll()).sort((a, b) => b.updatedAt - a.updatedAt);
    renderTemplateList();
    if (state.templates.length > 0) await loadTemplate(state.templates[0].id);
  } catch (err) {
    toast('初期化に失敗しました: ' + err.message, true);
  }
  loadPresets();
})();
