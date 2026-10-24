// Convert — PDF editor. Everything runs locally; the original PDF is modified with pdf-lib on save.
const CDN = 'https://cdn.jsdelivr.net/npm/';
const PDFJS = CDN + 'pdfjs-dist@4.10.38/build/';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const DPR = Math.min(window.devicePixelRatio || 1, isIOS ? 2 : 3);
const LH = 1.2; // line-height used for text items (css + pdf)

/* ---------------- libraries ---------------- */
const cache = {};
const once = (k, fn) => (cache[k] ??= fn().catch((e) => { delete cache[k]; throw e; }));
const imp = (url) => import(url).catch(() => { throw new Error('Nu s-a putut încărca o librărie (ești offline la prima folosire?)'); });
const lib = {
  pdfjs: () => once('pdfjs', async () => { const m = await imp(PDFJS + 'pdf.min.mjs'); m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; return m; }),
  pdflib: () => once('pdflib', () => imp(CDN + 'pdf-lib@1.17.1/+esm')),
  fontkit: () => once('fontkit', async () => { const m = await imp(CDN + '@pdf-lib/fontkit@1.1.1/+esm'); return m.default || m; }),
};

/* ---------------- fonts (metric-compatible with Arial / Times / Courier) ---------------- */
const FONTS = {
  sans: { label: 'Sans (Arial)', base: CDN + '@expo-google-fonts/arimo@0.4.3/', r: '400Regular/Arimo_400Regular.ttf', b: '700Bold/Arimo_700Bold.ttf', i: '400Regular_Italic/Arimo_400Regular_Italic.ttf', bi: '700Bold_Italic/Arimo_700Bold_Italic.ttf' },
  serif: { label: 'Serif (Times)', base: CDN + '@expo-google-fonts/tinos@0.4.2/', r: '400Regular/Tinos_400Regular.ttf', b: '700Bold/Tinos_700Bold.ttf', i: '400Regular_Italic/Tinos_400Regular_Italic.ttf', bi: '700Bold_Italic/Tinos_700Bold_Italic.ttf' },
  mono: { label: 'Mono', base: CDN + 'dejavu-fonts-ttf@2.37.3/ttf/', r: 'DejaVuSansMono.ttf', b: 'DejaVuSansMono-Bold.ttf', i: 'DejaVuSansMono-Oblique.ttf', bi: 'DejaVuSansMono-BoldOblique.ttf' },
};
const variant = (b, i) => (b && i ? 'bi' : b ? 'b' : i ? 'i' : 'r');
const fontKey = (fam, b, i) => `${fam}-${variant(b, i)}`;
const cssFam = (fam, b, i) => `Ed_${fontKey(fam, b, i)}`;
const fontLoads = {};
function loadFont(fam, b, i) {
  const key = fontKey(fam, b, i);
  return (fontLoads[key] ??= (async () => {
    const F = FONTS[fam];
    const res = await fetch(F.base + F[variant(b, i)]);
    if (!res.ok) throw new Error('Nu s-a putut încărca fontul.');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const face = new FontFace(cssFam(fam, b, i), bytes.slice().buffer);
    await face.load(); document.fonts.add(face);
    const c = document.createElement('canvas').getContext('2d');
    c.font = `100px "${cssFam(fam, b, i)}"`;
    const m = c.measureText('Hgăș');
    const asc = m.fontBoundingBoxAscent ?? 92, desc = m.fontBoundingBoxDescent ?? 22;
    return { bytes, baseline: ((LH * 100 - (asc + desc)) / 2 + asc) / 100 };
  })().catch((e) => { delete fontLoads[key]; throw e; }));
}

/* ---------------- state ---------------- */
const S = {
  file: null, bytes: null, pdf: null, pages: [], order: [], scale: 1, fitScale: 1,
  tool: 'select', sel: null, seq: 0, undo: [], dirty: false,
  fields: [], numbering: null, watermark: null,
};
const viewer = $('#viewer'), pagesEl = $('#pages');

function toast(msg, action, ms = 3500) {
  const t = $('#toast'); t.innerHTML = ''; const s = document.createElement('span'); s.textContent = msg; t.appendChild(s);
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { action.fn(); t.hidden = true; }; t.appendChild(b); }
  t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function pushUndo(fn) { S.undo.push(fn); S.dirty = true; $('#undoBtn').disabled = false; }
function undo() { const fn = S.undo.pop(); if (fn) fn(); $('#undoBtn').disabled = !S.undo.length; }

/* ---------------- open ---------------- */
async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('Alege un fișier PDF.'); return; }
  const busy = showBusy('Deschid PDF-ul…');
  try {
    const pdfjs = await lib.pdfjs();
    S.file = file; S.bytes = new Uint8Array(await file.arrayBuffer());
    try { S.pdf = await pdfjs.getDocument({ data: S.bytes.slice(), isEvalSupported: false }).promise; }
    catch (e) { throw new Error(/password/i.test(e.name + e.message) ? 'PDF-ul are parolă — nu-l pot deschide.' : 'Nu pot citi PDF-ul ăsta.'); }
    S.pages = []; S.order = []; S.undo = []; S.sel = null; S.fields = []; pagesEl.innerHTML = '';
    for (let i = 0; i < S.pdf.numPages; i++) {
      const page = await S.pdf.getPage(i + 1);
      const vp1 = page.getViewport({ scale: 1 });
      S.pages.push({ i, page, vp1, W: vp1.width, H: vp1.height, R: vp1.rotation, rot: 0, deleted: false, items: [], crop: null, runs: null, rendered: 0 });
      S.order.push(i);
    }
    $('#empty').hidden = true;
    $('#fname').textContent = file.name;
    $('#topActions').hidden = false; $('#tools').hidden = false;
    $('#undoBtn').disabled = true;
    S.fitScale = fitScale(); S.scale = S.fitScale;
    buildPages();
    loadFont('sans', false, false).catch(() => {});
    await loadFields();
    S.dirty = false;
  } catch (e) { console.error(e); toast(e.message || 'Eroare la deschidere.'); }
  finally { busy.remove(); }
}
function fitScale() {
  const maxW = Math.max(...S.pages.map((p) => p.W));
  const avail = viewer.clientWidth - (innerWidth < 720 ? 24 : 96);
  return Math.max(0.3, Math.min(1.6, avail / maxW));
}
function showBusy(text) { const d = document.createElement('div'); d.className = 'busy-overlay'; d.textContent = text; document.body.appendChild(d); return d; }

/* ---------------- page DOM ---------------- */
let io;
function buildPages() {
  io?.disconnect();
  io = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) renderPage(S.pages[+e.target.dataset.i]); }, { root: viewer, rootMargin: '600px 0px' });
  for (const pg of S.pages) {
    const el = document.createElement('div'); el.className = 'pg'; el.dataset.i = pg.i;
    el.innerHTML = `<div class="pg-inner"><canvas></canvas><div class="ov"></div></div><span class="pg-label"></span>`;
    pg.el = el; pg.inner = $('.pg-inner', el); pg.canvas = $('canvas', el); pg.ov = $('.ov', el);
    bindOverlay(pg);
    io.observe(el);
  }
  syncOrder(); layoutAll();
}
function syncOrder() {
  S.order.forEach((i, k) => { const pg = S.pages[i]; pagesEl.appendChild(pg.el); });
  let n = 0;
  for (const i of S.order) { const pg = S.pages[i]; pg.el.classList.toggle('deleted', pg.deleted); if (!pg.deleted) $('.pg-label', pg.el).textContent = ++n; }
}
function layoutAll() {
  const s = S.scale;
  $('#zoomFit').textContent = Math.round((s / S.fitScale) * 100) + '%';
  for (const pg of S.pages) {
    const w = pg.W * s, h = pg.H * s, sw = pg.rot % 180 ? h : w, sh = pg.rot % 180 ? w : h;
    pg.el.style.width = sw + 'px'; pg.el.style.height = sh + 'px';
    Object.assign(pg.inner.style, { width: w + 'px', height: h + 'px', transform: `translate(-50%,-50%) rotate(${pg.rot}deg)` });
    for (const it of pg.items) placeItem(it);
    for (const f of S.fields.filter((f) => f.pg === pg)) placeField(f);
    for (const r of $$('.run', pg.ov)) placeRun(pg, r);
    drawCrop(pg);
    if (pg.rendered && pg.rendered !== s) { pg.rendered = 0; }
  }
  // re-render visible pages at the new scale
  const vr = viewer.getBoundingClientRect();
  for (const pg of S.pages) { const r = pg.el.getBoundingClientRect(); if (r.bottom > vr.top - 600 && r.top < vr.bottom + 600) renderPage(pg); }
}
async function renderPage(pg) {
  if (pg.rendered === S.scale || pg.rendering) return;
  pg.rendering = true;
  const s = S.scale;
  try {
    const vp = pg.page.getViewport({ scale: s * DPR });
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.page.render({ canvasContext: ctx, viewport: vp, annotationMode: 0 }).promise;
    pg.canvas.width = c.width; pg.canvas.height = c.height; pg.canvas.getContext('2d').drawImage(c, 0, 0);
    pg.rendered = s;
  } catch (e) { console.error(e); }
  finally { pg.rendering = false; if (pg.rendered !== S.scale) setTimeout(() => renderPage(pg), 0); }
}
function setZoom(s) {
  const cx = viewer.scrollLeft + viewer.clientWidth / 2, cy = viewer.scrollTop + viewer.clientHeight / 2, k = s / S.scale;
  S.scale = Math.max(0.25, Math.min(4, s)); layoutAll();
  viewer.scrollLeft = cx * k - viewer.clientWidth / 2; viewer.scrollTop = cy * k - viewer.clientHeight / 2;
}
$('#zoomIn').onclick = () => setZoom(S.scale * 1.2);
$('#zoomOut').onclick = () => setZoom(S.scale / 1.2);
$('#zoomFit').onclick = () => { S.fitScale = fitScale(); setZoom(S.fitScale); };
addEventListener('resize', () => { if (!S.pdf) return; const f = fitScale(); if (Math.abs(S.scale - S.fitScale) < 0.01) { S.fitScale = f; S.scale = f; layoutAll(); } else S.fitScale = f; });

/* pointer → page base coords (pt in the page's own display frame) */
function toBase(pg, e) {
  const r = pg.inner.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const a = (-pg.rot * Math.PI) / 180, s = S.scale;
  const x = dx * Math.cos(a) - dy * Math.sin(a), y = dx * Math.sin(a) + dy * Math.cos(a);
  return { x: (x + (pg.W * s) / 2) / s, y: (y + (pg.H * s) / 2) / s };
}
function currentPage() {
  const vr = viewer.getBoundingClientRect(); let best = null, bestA = -1;
  for (const i of S.order) { const pg = S.pages[i]; if (pg.deleted) continue; const r = pg.el.getBoundingClientRect(); const a = Math.max(0, Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top)); if (a > bestA) { bestA = a; best = pg; } }
  return best;
}

/* ---------------- tools ---------------- */
function setTool(t) {
  if (t === 'sign') { openSign(); return; }
  if (t === 'image') { $('#imgInput').click(); return; }
  S.tool = t;
  for (const b of $$('.tool')) b.classList.toggle('on', b.dataset.tool === t);
  document.body.className = 'tool-' + t;
  $('#cropbar').hidden = t !== 'crop';
  if (t === 'edit') S.pages.forEach((pg) => { if (!pg.deleted) ensureRuns(pg); });
  if (t !== 'select' && S.sel && !['text', 'edit'].includes(S.sel.type)) select(null);
}
for (const b of $$('.tool')) b.addEventListener('click', () => setTool(b.dataset.tool));
document.body.className = 'tool-select';

function bindOverlay(pg) {
  let draft = null;
  pg.ov.addEventListener('pointerdown', (e) => {
    if (e.target !== pg.ov && !e.target.classList.contains('run')) return;
    const p = toBase(pg, e);
    const t = S.tool;
    if (t === 'select') { select(null); return; }
    if (t === 'text') { e.preventDefault(); addText(pg, p); return; }
    if (t === 'edit') { if (!e.target.classList.contains('run')) select(null); return; }
    if (t === 'draw') {
      e.preventDefault(); pg.ov.setPointerCapture(e.pointerId);
      const it = newItem(pg, { type: 'path', pts: [[p.x, p.y]], color: S.penColor || '#1e3fae', width: S.penWidth || 2 });
      draft = { kind: 'path', it };
      return;
    }
    if (['whiteout', 'highlight', 'crop'].includes(t)) {
      e.preventDefault(); pg.ov.setPointerCapture(e.pointerId);
      const box = document.createElement('div'); box.className = 'draft'; pg.ov.appendChild(box);
      draft = { kind: 'rect', start: p, box, cur: p };
      placeDraft(draft);
    }
  });
  pg.ov.addEventListener('pointermove', (e) => {
    if (!draft) return;
    const p = toBase(pg, e);
    if (draft.kind === 'path') {
      const pts = draft.it.pts, last = pts[pts.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) * S.scale > 1.5) { pts.push([+p.x.toFixed(2), +p.y.toFixed(2)]); renderPath(draft.it); }
    } else { draft.cur = p; placeDraft(draft); }
  });
  const end = () => {
    if (!draft) return;
    const d = draft; draft = null;
    if (d.kind === 'path') { const it = d.it; pushUndo(() => removeItem(it, true)); return; }
    d.box.remove();
    const x = Math.min(d.start.x, d.cur.x), y = Math.min(d.start.y, d.cur.y), w = Math.abs(d.cur.x - d.start.x), h = Math.abs(d.cur.y - d.start.y);
    if (w * S.scale < 6 || h * S.scale < 6) return;
    if (S.tool === 'crop') { setCrop(pg, { x, y, w, h }); return; }
    const hl = S.tool === 'highlight';
    const it = newItem(pg, { type: 'rect', x, y, w, h, color: hl ? (S.hlColor || '#ffe24a') : sampleBg(pg, x, y, w, h), hl });
    pushUndo(() => removeItem(it, true));
    select(it);
  };
  pg.ov.addEventListener('pointerup', end);
  pg.ov.addEventListener('pointercancel', end);
  function placeDraft(d) {
    const s = S.scale, x = Math.min(d.start.x, d.cur.x), y = Math.min(d.start.y, d.cur.y);
    Object.assign(d.box.style, { left: x * s + 'px', top: y * s + 'px', width: Math.abs(d.cur.x - d.start.x) * s + 'px', height: Math.abs(d.cur.y - d.start.y) * s + 'px' });
  }
}

/* ---------------- items ---------------- */
function newItem(pg, props) {
  const it = { id: ++S.seq, pg, ...props };
  pg.items.push(it);
  mountItem(it);
  S.dirty = true;
  return it;
}
function removeItem(it, silent) {
  const a = it.pg.items; const k = a.indexOf(it); if (k < 0) return;
  a.splice(k, 1); it.el?.remove(); it.cover?.remove();
  if (it.run) it.run.style.display = '';
  if (S.sel === it) select(null);
  if (!silent) pushUndo(() => { a.splice(Math.min(k, a.length), 0, it); mountItem(it); if (it.run) it.run.style.display = 'none'; });
}
function mountItem(it) {
  const ov = it.pg.ov;
  if (it.type === 'path') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('it-svg'); svg.setAttribute('viewBox', `0 0 ${it.pg.W} ${it.pg.H}`); svg.setAttribute('preserveAspectRatio', 'none');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); svg.appendChild(path);
    ov.appendChild(svg); it.el = svg; it.path = path;
    path.addEventListener('pointerdown', (e) => { if (S.tool === 'draw') return; e.stopPropagation(); select(it); startMove(it, e); });
    renderPath(it); return;
  }
  const el = document.createElement('div');
  el.className = 'it';
  if (it.type === 'edit') {
    const cv = document.createElement('div'); cv.className = 'it-cover'; ov.appendChild(cv); it.cover = cv;
  }
  if (it.type === 'text' || it.type === 'edit') {
    el.classList.add('it-t');
    el.spellcheck = false;
    el.textContent = it.text;
    el.addEventListener('input', () => { it.text = el.innerText.replace(/\n$/, ''); S.dirty = true; });
    el.addEventListener('focus', () => { it._before = it.text; select(it); });
    el.addEventListener('blur', () => {
      const before = it._before; it.text = el.innerText.replace(/\n$/, '');
      if (it.type === 'text' && !it.text.trim() && it.isNew) { removeItem(it, true); return; }
      it.isNew = false;
      if (before !== undefined && before !== it.text) pushUndo(() => { it.text = before; el.textContent = before; });
    });
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (S.tool === 'select' && document.activeElement !== el) { e.preventDefault(); select(it); startMove(it, e); }
    });
    el.addEventListener('dblclick', () => focusText(it));
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') el.blur(); e.stopPropagation(); });
    setEditable(it);
  } else if (it.type === 'image') {
    el.classList.add('it-img'); const img = document.createElement('img'); img.src = it.src; img.alt = ''; el.appendChild(img);
  } else if (it.type === 'rect') {
    el.classList.add('it-rect'); if (it.hl) el.classList.add('hl');
  }
  if (it.type !== 'text' && it.type !== 'edit') {
    el.addEventListener('pointerdown', (e) => { if (e.target.classList.contains('handle')) return; e.stopPropagation(); select(it); startMove(it, e); });
  }
  const hm = document.createElement('span'); hm.className = 'handle h-move'; el.appendChild(hm);
  hm.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); startMove(it, e); });
  if (it.type === 'image' || it.type === 'rect') {
    const hs = document.createElement('span'); hs.className = 'handle h-size'; el.appendChild(hs);
    hs.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); startResize(it, e); });
  }
  ov.appendChild(el); it.el = el;
  placeItem(it);
}
function setEditable(it) {
  if (it.type !== 'text' && it.type !== 'edit') return;
  const ce = S.tool === 'select' ? 'false' : 'plaintext-only';
  try { it.el.contentEditable = ce; } catch { it.el.contentEditable = ce === 'false' ? 'false' : 'true'; }
  if (ce !== 'false' && it.el.contentEditable !== 'plaintext-only') it.el.contentEditable = 'true';
}
function focusText(it) {
  try { it.el.contentEditable = 'plaintext-only'; } catch {}
  if (it.el.contentEditable !== 'plaintext-only') it.el.contentEditable = 'true';
  it.el.focus();
  const r = document.createRange(); r.selectNodeContents(it.el); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function placeItem(it) {
  const s = S.scale, el = it.el; if (!el) return;
  if (it.type === 'path') { renderPath(it); return; }
  if (it.type === 'text' || it.type === 'edit') {
    const f = fontLoads[fontKey(it.fam, it.bold, it.italic)];
    const bl = it._bl ?? 0.9;
    Object.assign(el.style, {
      left: it.x * s + 'px', top: (it.base - bl * it.size) * s + 'px', fontSize: it.size * s + 'px', color: it.color,
      fontFamily: `"${cssFam(it.fam, it.bold, it.italic)}", ${it.fam === 'serif' ? 'Times New Roman, serif' : it.fam === 'mono' ? 'monospace' : 'Arial, sans-serif'}`,
    });
    if (f && it._blKey !== fontKey(it.fam, it.bold, it.italic)) f.then((m) => { it._bl = m.baseline; it._blKey = fontKey(it.fam, it.bold, it.italic); placeItem(it); }).catch(() => {});
    if (it.cover) Object.assign(it.cover.style, { left: it.cover_.x * s + 'px', top: it.cover_.y * s + 'px', width: it.cover_.w * s + 'px', height: it.cover_.h * s + 'px', background: it.bg });
    return;
  }
  Object.assign(el.style, { left: it.x * s + 'px', top: it.y * s + 'px', width: it.w * s + 'px', height: it.h * s + 'px' });
  if (it.type === 'rect') { el.style.background = it.color; el.style.opacity = it.hl ? 0.45 : 1; }
}
function renderPath(it) {
  const p = it.pts;
  let d = `M${p[0][0]} ${p[0][1]}`;
  if (p.length === 1) d += ` L${p[0][0] + 0.01} ${p[0][1]}`;
  for (let k = 1; k < p.length; k++) d += ` L${p[k][0]} ${p[k][1]}`;
  it.path.setAttribute('d', d); it.path.setAttribute('stroke', it.color); it.path.setAttribute('stroke-width', it.width);
}

function startMove(it, e) {
  const pg = it.pg, p0 = toBase(pg, e);
  const orig = it.type === 'path' ? it.pts.map((q) => [...q]) : it.type === 'text' || it.type === 'edit' ? { x: it.x, base: it.base } : { x: it.x, y: it.y };
  let moved = false;
  const mv = (ev) => {
    const p = toBase(pg, ev), dx = p.x - p0.x, dy = p.y - p0.y;
    if (!moved && Math.hypot(dx, dy) * S.scale < 3) return;
    moved = true;
    if (it.type === 'path') it.pts = orig.map(([x, y]) => [x + dx, y + dy]);
    else if (it.type === 'text' || it.type === 'edit') { it.x = orig.x + dx; it.base = orig.base + dy; }
    else { it.x = orig.x + dx; it.y = orig.y + dy; }
    placeItem(it);
  };
  const up = () => {
    removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    if (moved) pushUndo(() => { if (it.type === 'path') it.pts = orig; else Object.assign(it, orig); placeItem(it); });
  };
  addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}
function startResize(it, e) {
  const pg = it.pg, p0 = toBase(pg, e), o = { w: it.w, h: it.h }, ratio = it.h / it.w;
  const mv = (ev) => {
    const p = toBase(pg, ev);
    it.w = Math.max(8, o.w + (p.x - p0.x));
    it.h = it.type === 'image' ? it.w * ratio : Math.max(4, o.h + (p.y - p0.y));
    placeItem(it);
  };
  const up = () => {
    removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
    pushUndo(() => { Object.assign(it, o); placeItem(it); });
  };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
}

/* text */
async function addText(pg, p) {
  const it = newItem(pg, { type: 'text', x: p.x, base: p.y + (S.lastSize || 12) * 0.35, size: S.lastSize || 12, fam: S.lastFam || 'sans', bold: false, italic: false, color: S.lastColor || '#111111', text: '', isNew: true });
  pushUndo(() => removeItem(it, true));
  await loadFont(it.fam, false, false).catch(() => {});
  placeItem(it);
  focusText(it);
}

/* existing text runs */
async function ensureRuns(pg) {
  if (pg.runs) return pg.runs;
  pg.runs = [];
  const pdfjs = await lib.pdfjs();
  if (pg.rendered === 0) await renderPage(pg);
  const tc = await pg.page.getTextContent();
  const raw = [];
  for (const it of tc.items) {
    if (!it.str) continue;
    const tx = pdfjs.Util.transform(pg.vp1.transform, it.transform);
    const size = Math.hypot(tx[2], tx[3]);
    if (!size || Math.abs(tx[1]) > 0.02 * size || Math.abs(tx[2]) > 0.02 * size || tx[0] <= 0) continue; // only horizontal, upright text
    raw.push({ str: it.str, x: tx[4], base: tx[5], size, w: it.width * (pg.vp1.scale || 1), font: it.fontName });
  }
  raw.sort((a, b) => (Math.abs(a.base - b.base) > Math.min(a.size, b.size) * 0.3 ? a.base - b.base : a.x - b.x));
  const runs = [];
  for (const r of raw) {
    const L = runs[runs.length - 1];
    const gap = L ? r.x - (L.x + L.w) : 0;
    if (L && Math.abs(L.base - r.base) < Math.min(L.size, r.size) * 0.3 && gap > -L.size * 0.3 && gap < L.size * 0.9 && Math.abs(L.size - r.size) < L.size * 0.25) {
      if (gap > L.size * 0.12 && !/\s$/.test(L.text) && !/^\s/.test(r.str)) L.text += ' ';
      L.text += r.str; L.w = r.x + r.w - L.x; L.fonts.add(r.font);
    } else if (r.str.trim()) runs.push({ text: r.str, x: r.x, base: r.base, size: r.size, w: r.w, fonts: new Set([r.font]) });
  }
  for (const run of runs) {
    run.text = run.text.replace(/\s+$/, '');
    const fi = fontInfo(pg, [...run.fonts][0], tc.styles);
    Object.assign(run, fi);
    const el = document.createElement('div'); el.className = 'run'; run.el = el; el._run = run;
    el.addEventListener('pointerdown', (e) => { if (S.tool !== 'edit') return; e.preventDefault(); e.stopPropagation(); editRun(pg, run); });
    pg.ov.insertBefore(el, pg.ov.firstChild);
    placeRun(pg, el);
  }
  pg.runs = runs;
  return runs;
}
function placeRun(pg, el) {
  const r = el._run, s = S.scale;
  Object.assign(el.style, { left: (r.x - 1) * s + 'px', top: (r.base - r.size * 0.92) * s + 'px', width: (r.w + 2) * s + 'px', height: r.size * 1.18 * s + 'px' });
}
function fontInfo(pg, fontName, styles) {
  let name = '';
  try { if (pg.page.commonObjs.has(fontName)) name = pg.page.commonObjs.get(fontName)?.name || ''; } catch {}
  const famHint = styles?.[fontName]?.fontFamily || '';
  const n = name.replace(/^[A-Z]{6}\+/, '');
  const mono = /mono|courier|consol|menlo/i.test(n) || famHint === 'monospace';
  const serif = !mono && (/times|serif|georgia|garamond|cambria|roman|minion|palatino|book|baskerville|charter/i.test(n) && !/sans/i.test(n) || (!n && famHint === 'serif'));
  return { fam: mono ? 'mono' : serif ? 'serif' : 'sans', bold: /bold|black|heavy|semibold|demi|,b$/i.test(n), italic: /italic|oblique|,i$/i.test(n) };
}
function sampleColors(pg, x, y, w, h) {
  const c = pg.canvas; if (!c.width) return { bg: '#ffffff', fg: '#111111' };
  const k = c.width / pg.W;
  const sx = Math.max(0, Math.floor(x * k)), sy = Math.max(0, Math.floor(y * k));
  const sw = Math.max(1, Math.min(c.width - sx, Math.ceil(w * k))), sh = Math.max(1, Math.min(c.height - sy, Math.ceil(h * k)));
  let data;
  try { data = c.getContext('2d').getImageData(sx, sy, sw, sh).data; } catch { return { bg: '#ffffff', fg: '#111111' }; }
  const hist = new Map(); const step = Math.max(1, Math.floor((sw * sh) / 6000));
  for (let p = 0; p < data.length; p += 4 * step) {
    const key = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3);
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  const toRGB = (key) => [((key >> 10) & 31) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4];
  const sorted = [...hist.entries()].sort((a, b) => b[1] - a[1]);
  const bg = toRGB(sorted[0][0]);
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  let fg = null;
  for (const [key] of sorted) { const c2 = toRGB(key); if (Math.abs(lum(c2) - lum(bg)) > 90) { fg = c2; break; } }
  if (!fg) fg = lum(bg) > 128 ? [17, 17, 17] : [240, 240, 240];
  const hex = (c) => '#' + c.map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('');
  // snap near-white / near-black
  const bgHex = lum(bg) > 245 ? '#ffffff' : hex(bg);
  const fgHex = lum(fg) < 40 ? '#000000' : hex(fg);
  return { bg: bgHex, fg: fgHex };
}
const sampleBg = (pg, x, y, w, h) => sampleColors(pg, x, y, w, h).bg;
async function editRun(pg, run) {
  if (run.item && pg.items.includes(run.item)) { focusText(run.item); return; }
  const pad = run.size * 0.08;
  const cover = { x: run.x - pad, y: run.base - run.size * 0.92, w: run.w + 2 * pad, h: run.size * 1.18 };
  const { bg, fg } = sampleColors(pg, cover.x, cover.y, cover.w, cover.h);
  await loadFont(run.fam, run.bold, run.italic).catch(() => {});
  const it = newItem(pg, { type: 'edit', x: run.x, base: run.base, size: +run.size.toFixed(2), fam: run.fam, bold: run.bold, italic: run.italic, color: fg, bg, text: run.text, cover_: cover, run: run.el });
  run.item = it; run.el.style.display = 'none';
  pushUndo(() => { removeItem(it, true); run.item = null; });
  focusText(it);
}

/* images & signatures */
function addImage(src, natW, natH) {
  const pg = currentPage(); if (!pg) return;
  const w = Math.min(pg.W * 0.4, 220), h = (w * natH) / natW;
  const vr = viewer.getBoundingClientRect(), r = pg.inner.getBoundingClientRect();
  const midY = Math.min(Math.max((vr.top + vr.height / 2 - r.top) / S.scale, h / 2 + 10), pg.H - h / 2 - 10);
  const it = newItem(pg, { type: 'image', src, x: (pg.W - w) / 2, y: (pg.rot ? pg.H / 2 : midY) - h / 2, w, h });
  pushUndo(() => removeItem(it, true));
  setTool('select'); select(it);
}
$('#imgInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    const max = 2000, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const png = f.type === 'image/png' || f.type === 'image/webp' || f.type === 'image/gif';
    addImage(c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9), c.width, c.height);
  } catch { toast('Nu pot citi poza (încearcă JPG sau PNG).'); }
});

/* ---------------- selection & props ---------------- */
const SWATCHES = ['#000000', '#444444', '#1e3fae', '#d0342c', '#1b8a3a', '#ffffff'];
const HL = ['#ffe24a', '#8dfc7a', '#ff9ad5', '#7ad3ff'];
function select(it) {
  if (S.sel && S.sel !== it) { S.sel.el?.classList.remove('sel'); }
  S.sel = it;
  if (it) it.el.classList.add('sel');
  renderProps();
}
function renderProps() {
  const box = $('#props'); const it = S.sel;
  const showPen = !it && S.tool === 'draw';
  if (!it && !showPen) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false; box.innerHTML = '';
  const add = (el) => (box.appendChild(el), el);
  const btn = (txt, cls, fn, title) => { const b = document.createElement('button'); b.className = cls; b.textContent = txt; if (title) b.title = title; b.onmousedown = (e) => e.preventDefault(); b.onclick = fn; return add(b); };
  const sep = () => { const s = document.createElement('span'); s.className = 'sep'; add(s); };
  const colors = (list, cur, set) => {
    for (const c of list) { const b = document.createElement('button'); b.className = 'swatch' + (c.toLowerCase() === (cur || '').toLowerCase() ? ' on' : ''); b.style.setProperty('--c', c); b.onmousedown = (e) => e.preventDefault(); b.onclick = () => set(c); add(b); }
    const ci = document.createElement('input'); ci.type = 'color'; ci.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#000000'; ci.oninput = () => set(ci.value, true); add(ci);
  };
  const change = (props) => {
    const prev = {}; for (const k in props) prev[k] = it[k];
    Object.assign(it, props); placeItem(it); renderProps();
    pushUndo(() => { Object.assign(it, prev); placeItem(it); if (S.sel === it) renderProps(); });
  };
  if (showPen) {
    const l = document.createElement('span'); l.className = 'lbl'; l.textContent = 'Pix'; add(l);
    colors(['#1e3fae', '#000000', '#d0342c', '#1b8a3a'], S.penColor || '#1e3fae', (c) => { S.penColor = c; renderProps(); });
    sep();
    for (const [w, n] of [[1, 'Subțire'], [2, 'Normal'], [4, 'Gros']]) btn(n, 'tog' + ((S.penWidth || 2) === w ? ' on' : ''), () => { S.penWidth = w; renderProps(); });
    return;
  }
  if (it.type === 'text' || it.type === 'edit') {
    if (document.activeElement !== it.el) btn('Scrie', 'tog', () => focusText(it), 'Editează textul');
    const sel = document.createElement('select');
    for (const [k, F] of Object.entries(FONTS)) { const o = document.createElement('option'); o.value = k; o.textContent = F.label; sel.appendChild(o); }
    sel.value = it.fam; sel.onchange = async () => { await loadFont(sel.value, it.bold, it.italic).catch(() => {}); S.lastFam = sel.value; change({ fam: sel.value }); };
    add(sel);
    const num = document.createElement('input'); num.type = 'number'; num.min = 4; num.max = 200; num.step = 0.5; num.value = +it.size.toFixed(1);
    num.onchange = () => { const v = Math.max(4, Math.min(200, +num.value || it.size)); S.lastSize = v; change({ size: v }); };
    btn('−', 'tog', () => { S.lastSize = Math.max(4, it.size - 1); change({ size: S.lastSize }); });
    add(num);
    btn('+', 'tog', () => { S.lastSize = Math.min(200, it.size + 1); change({ size: S.lastSize }); });
    sep();
    btn('B', 'tog' + (it.bold ? ' on' : ''), async () => { await loadFont(it.fam, !it.bold, it.italic).catch(() => {}); change({ bold: !it.bold }); }, 'Bold');
    btn('I', 'tog' + (it.italic ? ' on' : ''), async () => { await loadFont(it.fam, it.bold, !it.italic).catch(() => {}); change({ italic: !it.italic }); }, 'Italic').style.fontStyle = 'italic';
    sep();
    colors(SWATCHES, it.color, (c, live) => { S.lastColor = c; if (live) { it.color = c; placeItem(it); } else change({ color: c }); });
    if (it.type === 'edit') {
      sep();
      const l = document.createElement('span'); l.className = 'lbl'; l.textContent = 'Fundal'; add(l);
      const ci = document.createElement('input'); ci.type = 'color'; ci.value = it.bg; ci.title = 'Culoarea care acoperă textul original'; ci.oninput = () => { it.bg = ci.value; placeItem(it); }; add(ci);
    }
  } else if (it.type === 'rect') {
    colors(it.hl ? HL : ['#ffffff', '#000000', '#f5f5f5'], it.color, (c, live) => { if (it.hl) S.hlColor = c; if (live) { it.color = c; placeItem(it); } else change({ color: c }); });
  } else if (it.type === 'path') {
    colors(['#1e3fae', '#000000', '#d0342c', '#1b8a3a'], it.color, (c, live) => { if (live) { it.color = c; renderPath(it); } else change({ color: c }); });
    sep();
    for (const [w, n] of [[1, 'Subțire'], [2, 'Normal'], [4, 'Gros']]) btn(n, 'tog' + (it.width === w ? ' on' : ''), () => change({ width: w }));
  }
  sep();
  btn(it.type === 'edit' ? 'Renunță la modificare' : 'Șterge', 'tog del', () => { const x = it; select(null); if (x.type === 'edit') { removeItem(x, false); x.run && (x.run.style.display = ''); } else removeItem(x, false); });
}
addEventListener('keydown', (e) => {
  if (!S.pdf) return;
  const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); undo(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel && !inField) { e.preventDefault(); removeItem(S.sel, false); }
  if (e.key === 'Escape' && !inField) select(null);
});
$('#undoBtn').onclick = undo;

/* ---------------- crop ---------------- */
function setCrop(pg, rect, noUndo) {
  const prev = pg.crop; pg.crop = rect; drawCrop(pg);
  if (!noUndo) pushUndo(() => { pg.crop = prev; drawCrop(pg); });
}
function drawCrop(pg) {
  let el = $('.crop', pg.ov);
  if (!pg.crop) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.className = 'crop'; pg.ov.appendChild(el); }
  const s = S.scale, c = pg.crop;
  Object.assign(el.style, { left: c.x * s + 'px', top: c.y * s + 'px', width: c.w * s + 'px', height: c.h * s + 'px' });
}
$('#cropAll').onclick = () => {
  const src = S.pages.find((p) => p.crop && p === currentPage()) || S.pages.find((p) => p.crop);
  if (!src) { toast('Trage întâi un dreptunghi pe o pagină.'); return; }
  const prev = S.pages.map((p) => p.crop);
  for (const pg of S.pages) { const fx = pg.W / src.W, fy = pg.H / src.H; pg.crop = { x: src.crop.x * fx, y: src.crop.y * fy, w: src.crop.w * fx, h: src.crop.h * fy }; drawCrop(pg); }
  pushUndo(() => S.pages.forEach((p, k) => { p.crop = prev[k]; drawCrop(p); }));
  toast('Decuparea s-a aplicat pe toate paginile.');
};
$('#cropClear').onclick = () => {
  const prev = S.pages.map((p) => p.crop);
  S.pages.forEach((p) => { p.crop = null; drawCrop(p); });
  pushUndo(() => S.pages.forEach((p, k) => { p.crop = prev[k]; drawCrop(p); }));
};

/* ---------------- forms ---------------- */
async function loadFields() {
  let count = 0;
  for (const pg of S.pages) {
    let anns = [];
    try { anns = await pg.page.getAnnotations({ intent: 'display' }); } catch {}
    for (const a of anns) {
      if (a.subtype !== 'Widget' || !a.fieldName || a.readOnly || a.hidden) continue;
      let el;
      if (a.fieldType === 'Tx') {
        el = document.createElement(a.multiLine ? 'textarea' : 'input');
        el.value = typeof a.fieldValue === 'string' ? a.fieldValue : '';
        if (a.maxLen) el.maxLength = a.maxLen;
      } else if (a.fieldType === 'Btn' && a.checkBox) {
        el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!a.fieldValue && a.fieldValue !== 'Off';
      } else if (a.fieldType === 'Btn' && a.radioButton) {
        el = document.createElement('input'); el.type = 'radio'; el.name = 'r_' + a.fieldName; el.checked = a.fieldValue === a.buttonValue;
      } else if (a.fieldType === 'Ch' && a.options) {
        el = document.createElement('select');
        for (const o of a.options) { const op = document.createElement('option'); op.value = o.exportValue; op.textContent = o.displayValue; el.appendChild(op); }
        el.value = Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue;
      } else continue;
      el.className = 'fld';
      const r = pg.vp1.convertToViewportRectangle(a.rect);
      const f = { pg, a, el, x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]), w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]), initial: fieldValue({ a, el }) };
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('input', () => { S.dirty = true; });
      pg.ov.appendChild(el); S.fields.push(f); placeField(f); count++;
    }
  }
  const b = $('#banner');
  b.hidden = !count;
  if (count) b.textContent = `Formular detectat: ${count} câmpuri — completează-le direct pe pagină, apoi Salvează.`;
}
function placeField(f) {
  const s = S.scale;
  Object.assign(f.el.style, { left: f.x * s + 'px', top: f.y * s + 'px', width: f.w * s + 'px', height: f.h * s + 'px', fontSize: Math.max(8, Math.min(f.h * 0.7, 14)) * s + 'px' });
}
function fieldValue(f) {
  const { a, el } = f;
  if (a.fieldType === 'Btn') return el.checked;
  return el.value;
}

/* ---------------- pages panel ---------------- */
function openSheet(id) {
  for (const s of $$('.sheet')) if (s.id !== id) s.hidden = true;
  const s = $('#' + id); s.hidden = !s.hidden;
  if (id === 'pagesSheet' && !s.hidden) buildThumbs();
}
$('#pagesBtn').onclick = () => openSheet('pagesSheet');
$('#docBtn').onclick = () => openSheet('docSheet');
for (const c of $$('[data-close]')) c.onclick = () => (c.closest('.sheet').hidden = true);

async function buildThumbs() {
  const box = $('#thumbs'); box.innerHTML = '';
  const live = S.order.filter((i) => !S.pages[i].deleted);
  $('#pagesCount').textContent = `${live.length} ${live.length === 1 ? 'pagină' : 'pagini'}`;
  for (const i of S.order) {
    const pg = S.pages[i];
    const card = document.createElement('div'); card.className = 'th' + (pg.deleted ? ' gone' : '');
    const holder = document.createElement('div'); holder.className = 'th-img';
    if (!pg.thumb) {
      pg.thumb = document.createElement('canvas');
      const vp = pg.page.getViewport({ scale: 140 / Math.max(pg.W, pg.H) * 1.5 });
      pg.thumb.width = vp.width; pg.thumb.height = vp.height;
      const ctx = pg.thumb.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, vp.width, vp.height);
      pg.page.render({ canvasContext: ctx, viewport: vp, annotationMode: 0 }).promise.catch(() => {});
      Object.assign(pg.thumb.style, { width: vp.width / 1.5 + 'px', height: vp.height / 1.5 + 'px' });
    }
    pg.thumb.style.transform = `rotate(${pg.rot}deg)`;
    holder.appendChild(pg.thumb); card.appendChild(holder);
    const row = document.createElement('div'); row.className = 'th-row';
    const pos = live.indexOf(i);
    const n = document.createElement('span'); n.className = 'n'; n.textContent = pg.deleted ? 'ștearsă' : pos + 1; row.appendChild(n);
    const mk = (txt, title, fn, dis) => { const b = document.createElement('button'); b.textContent = txt; b.title = title; b.disabled = !!dis; b.onclick = fn; row.appendChild(b); };
    if (pg.deleted) mk('↺', 'Restaurează', () => delPage(pg, false));
    else {
      mk('↑', 'Mută mai sus', () => movePage(i, -1), pos === 0);
      mk('↓', 'Mută mai jos', () => movePage(i, 1), pos === live.length - 1);
      mk('⟲', 'Rotește stânga', () => rotatePage(pg, -90));
      mk('⟳', 'Rotește dreapta', () => rotatePage(pg, 90));
      mk('🗑', 'Șterge pagina', () => delPage(pg, true), live.length === 1);
    }
    card.appendChild(row); box.appendChild(card);
  }
}
function rotatePage(pg, d, noUndo) {
  pg.rot = (pg.rot + d + 360) % 360; layoutAll(); buildThumbsIfOpen();
  if (!noUndo) pushUndo(() => rotatePage(pg, -d, true));
}
function delPage(pg, del, noUndo) {
  pg.deleted = del; syncOrder(); buildThumbsIfOpen();
  if (!noUndo) { pushUndo(() => delPage(pg, !del, true)); if (del) toast('Pagină ștearsă.', { label: 'Anulează', fn: undo }); }
}
function movePage(i, dir, noUndo) {
  const live = S.order.filter((k) => !S.pages[k].deleted);
  const pos = live.indexOf(i), other = live[pos + dir]; if (other === undefined) return;
  const a = S.order.indexOf(i), b = S.order.indexOf(other);
  [S.order[a], S.order[b]] = [S.order[b], S.order[a]];
  syncOrder(); buildThumbsIfOpen();
  if (!noUndo) pushUndo(() => movePage(i, -dir, true));
}
function buildThumbsIfOpen() { if (!$('#pagesSheet').hidden) buildThumbs(); }

/* ---------------- signature pad ---------------- */
const pad = $('#pad'); let padCtx, padDrawn = false, padColor = '#111111', padPts = null;
function openSign() {
  renderSaved();
  $('#signDlg').showModal();
  requestAnimationFrame(() => {
    const r = pad.getBoundingClientRect();
    pad.width = r.width * DPR; pad.height = r.height * DPR;
    padCtx = pad.getContext('2d'); padCtx.scale(DPR, DPR);
    padCtx.lineCap = 'round'; padCtx.lineJoin = 'round'; padDrawn = false;
    $('.pad-hint').style.display = '';
  });
}
pad.addEventListener('pointerdown', (e) => {
  e.preventDefault(); pad.setPointerCapture(e.pointerId);
  const r = pad.getBoundingClientRect(); padPts = [[e.clientX - r.left, e.clientY - r.top, e.pressure || 0.5]];
  padDrawn = true; $('.pad-hint').style.display = 'none';
});
pad.addEventListener('pointermove', (e) => {
  if (!padPts) return;
  const r = pad.getBoundingClientRect(); const p = [e.clientX - r.left, e.clientY - r.top]; const q = padPts[padPts.length - 1];
  const dist = Math.hypot(p[0] - q[0], p[1] - q[1]); if (dist < 1) return;
  const w = Math.max(1.4, Math.min(3.4, 3.6 - dist * 0.06));
  padCtx.strokeStyle = padColor; padCtx.lineWidth = w;
  padCtx.beginPath(); padCtx.moveTo(q[0], q[1]);
  const mx = (q[0] + p[0]) / 2, my = (q[1] + p[1]) / 2;
  padCtx.quadraticCurveTo(q[0], q[1], mx, my); padCtx.lineTo(p[0], p[1]); padCtx.stroke();
  padPts.push(p);
});
const padEnd = () => { padPts = null; };
pad.addEventListener('pointerup', padEnd); pad.addEventListener('pointercancel', padEnd);
$('#padClear').onclick = () => { padCtx.clearRect(0, 0, pad.width, pad.height); padDrawn = false; $('.pad-hint').style.display = ''; };
for (const sw of $$('.pad-tools .swatch')) sw.onclick = () => { padColor = sw.dataset.c; $$('.pad-tools .swatch').forEach((x) => x.classList.toggle('on', x === sw)); };
function trimCanvas(c) {
  const ctx = c.getContext('2d'); const { width: w, height: h } = c; const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const m = 6 * DPR; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}
function savedSigns() { try { return JSON.parse(localStorage.getItem('convert.signs') || '[]'); } catch { return []; } }
function renderSaved() {
  const box = $('#savedSigns'); box.innerHTML = '';
  savedSigns().forEach((src, k) => {
    const b = document.createElement('div'); b.className = 'sg'; b.title = 'Folosește semnătura';
    const img = document.createElement('img'); img.src = src; b.appendChild(img);
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'rm'; rm.textContent = '×'; rm.title = 'Șterge';
    rm.onclick = (e) => { e.stopPropagation(); const a = savedSigns(); a.splice(k, 1); try { localStorage.setItem('convert.signs', JSON.stringify(a)); } catch {} renderSaved(); };
    b.appendChild(rm);
    b.onclick = () => { $('#signDlg').close(); placeSignature(src); };
    box.appendChild(b);
  });
}
function placeSignature(src) {
  const img = new Image(); img.onload = () => addImage(src, img.naturalWidth, img.naturalHeight); img.src = src;
}
$('#padUse').onclick = () => {
  if (!padDrawn) { toast('Semnează întâi în chenar.'); return; }
  const t = trimCanvas(pad); if (!t) return;
  const src = t.toDataURL('image/png');
  if ($('#padKeep').checked) { const a = savedSigns(); a.unshift(src); try { localStorage.setItem('convert.signs', JSON.stringify(a.slice(0, 5))); } catch {} }
  $('#signDlg').close(); placeSignature(src);
};

/* ---------------- document settings ---------------- */
const docOpts = () => ({
  num: $('#numOn').checked ? { pos: $('#numPos').value, fmt: $('#numFmt').value, size: +$('#numSize').value || 10, from: Math.max(1, +$('#numFrom').value || 1) } : null,
  wm: $('#wmOn').checked && $('#wmText').value.trim() ? { text: $('#wmText').value.trim(), size: +$('#wmSize').value || 64, opacity: +$('#wmOpacity').value / 100, color: $('#wmColor').value, angle: +$('#wmAngle').value } : null,
});
for (const id of ['numOn', 'wmOn']) $('#' + id).addEventListener('change', () => { S.dirty = true; });

/* ---------------- save ---------------- */
const hexRGB = (rgb, hex) => { const n = parseInt(hex.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
async function save() {
  document.activeElement?.blur?.();
  const busy = showBusy('Salvez PDF-ul…');
  try {
    const L = await lib.pdflib();
    const { PDFDocument, rgb, degrees, BlendMode, LineCapStyle } = L;
    const fontkit = await lib.fontkit();
    const doc = await PDFDocument.load(S.bytes, { ignoreEncryption: true, updateMetadata: false });
    doc.registerFontkit(fontkit);
    const emb = {};
    const font = async (fam, b, i) => {
      const k = fontKey(fam, b, i);
      if (!emb[k]) emb[k] = doc.embedFont((await loadFont(fam, b, i)).bytes, { subset: true });
      return emb[k];
    };
    const baseOf = async (it) => (await loadFont(it.fam, it.bold, it.italic)).baseline;

    // forms
    const changed = S.fields.filter((f) => fieldValue(f) !== f.initial);
    let hasForm = false;
    try { hasForm = doc.getForm().getFields().length > 0; } catch {}
    if (changed.length) {
      const form = doc.getForm();
      for (const f of changed) {
        try {
          const name = f.a.fieldName;
          if (f.a.fieldType === 'Tx') form.getTextField(name).setText(f.el.value);
          else if (f.a.checkBox) { const cb = form.getCheckBox(name); f.el.checked ? cb.check() : cb.uncheck(); }
          else if (f.a.radioButton) { if (f.el.checked) form.getRadioGroup(name).select(f.a.buttonValue); }
          else if (f.a.fieldType === 'Ch') { const fld = form.getField(name); fld.select?.(f.el.value); }
        } catch (e) { console.warn('field', f.a.fieldName, e); }
      }
      try { form.updateFieldAppearances(await font('sans', false, false)); } catch (e) { console.warn(e); }
    }

    // page content
    const opts = docOpts();
    const live = S.order.filter((i) => !S.pages[i].deleted);
    for (const pg of S.pages) {
      const p = doc.getPage(pg.i);
      const vp = pg.vp1, R = pg.R;
      const P = (x, y) => vp.convertToPdfPoint(x, y);
      const rot = degrees(R);
      const rect = (x, y, w, h, o) => { const [ax, ay] = P(x, y + h); p.drawRectangle({ x: ax, y: ay, width: w, height: h, rotate: rot, borderWidth: 0, ...o }); };
      const text = async (it) => {
        const f = await font(it.fam, it.bold, it.italic), bl = await baseOf(it);
        const lines = (it.text || '').split('\n');
        const top = it.base - bl * it.size;
        lines.forEach((ln, k) => {
          if (!ln) return;
          const [ax, ay] = P(it.x, top + (k * LH + bl) * it.size);
          p.drawText(ln, { x: ax, y: ay, size: it.size, font: f, color: hexRGB(rgb, it.color), rotate: rot });
        });
      };
      for (const it of pg.items.filter((x) => x.type === 'edit')) rect(it.cover_.x, it.cover_.y, it.cover_.w, it.cover_.h, { color: hexRGB(rgb, it.bg) });
      for (const it of pg.items) {
        if (it.type === 'rect') rect(it.x, it.y, it.w, it.h, it.hl ? { color: hexRGB(rgb, it.color), opacity: 0.45, blendMode: BlendMode.Multiply } : { color: hexRGB(rgb, it.color) });
        else if (it.type === 'image') {
          const bytes = await (await fetch(it.src)).arrayBuffer();
          const img = it.src.startsWith('data:image/png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          const [ax, ay] = P(it.x, it.y + it.h);
          p.drawImage(img, { x: ax, y: ay, width: it.w, height: it.h, rotate: rot });
        } else if (it.type === 'path') {
          const pts = it.pts.map(([x, y]) => P(x, y)), col = hexRGB(rgb, it.color);
          if (pts.length === 1) p.drawCircle({ x: pts[0][0], y: pts[0][1], size: it.width / 2, color: col });
          for (let k = 1; k < pts.length; k++) p.drawLine({ start: { x: pts[k - 1][0], y: pts[k - 1][1] }, end: { x: pts[k][0], y: pts[k][1] }, thickness: it.width, color: col, lineCap: LineCapStyle.Round });
        } else if (it.type === 'text' || it.type === 'edit') {
          if (it.text && it.text.trim()) await text(it);
        }
      }
      // crop
      const frame = pg.crop || { x: 0, y: 0, w: pg.W, h: pg.H };
      if (pg.crop) {
        const a = P(frame.x, frame.y), b = P(frame.x + frame.w, frame.y + frame.h);
        p.setCropBox(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      }
      // final frame (after user rotation) helpers
      const u = pg.rot, FW = u % 180 ? frame.h : frame.w, FH = u % 180 ? frame.w : frame.h;
      const toOrig = (X, Y) => {
        let x, y;
        if (u === 0) [x, y] = [X, Y]; else if (u === 90) [x, y] = [Y, frame.h - X]; else if (u === 180) [x, y] = [frame.w - X, frame.h - Y]; else [x, y] = [frame.w - Y, X];
        return P(frame.x + x, frame.y + y);
      };
      const finalRot = (extra = 0) => degrees(R + u + extra);
      if (!pg.deleted && opts.num) {
        const idx = live.indexOf(pg.i) + 1;
        if (idx >= opts.num.from) {
          const n = idx - opts.num.from + 1, N = live.length - opts.num.from + 1;
          const label = opts.num.fmt === 'n' ? String(n) : opts.num.fmt === 'n/N' ? `${n} / ${N}` : `Pagina ${n} din ${N}`;
          const f = await font('sans', false, false), size = opts.num.size, tw = f.widthOfTextAtSize(label, size), m = Math.max(18, size * 2);
          const X = opts.num.pos.endsWith('c') ? (FW - tw) / 2 : opts.num.pos.endsWith('r') ? FW - m - tw : m;
          const Y = opts.num.pos.startsWith('t') ? m + size * 0.75 : FH - m;
          const [ax, ay] = toOrig(X, Y);
          p.drawText(label, { x: ax, y: ay, size, font: f, color: rgb(0.2, 0.2, 0.2), rotate: finalRot() });
        }
      }
      if (!pg.deleted && opts.wm) {
        const f = await font('sans', true, false), size = Math.min(opts.wm.size, (Math.max(FW, FH) * 0.9) / Math.max(1, opts.wm.text.length * 0.6));
        const tw = f.widthOfTextAtSize(opts.wm.text, size), capH = size * 0.7;
        const th = (opts.wm.angle * Math.PI) / 180;
        const ux = Math.cos(th), uy = -Math.sin(th), nx = -Math.sin(th), ny = -Math.cos(th);
        const X = FW / 2 - ux * tw / 2 - nx * capH / 2, Y = FH / 2 - uy * tw / 2 - ny * capH / 2;
        const [ax, ay] = toOrig(X, Y);
        p.drawText(opts.wm.text, { x: ax, y: ay, size, font: f, color: hexRGB(rgb, opts.wm.color), opacity: opts.wm.opacity, rotate: finalRot(opts.wm.angle) });
      }
      if (u) p.setRotation(degrees((R + u) % 360));
    }

    // order / deletions
    const reordered = live.length !== S.pages.length || live.some((v, k) => v !== k);
    let out;
    if (reordered) {
      if (hasForm) { try { doc.getForm().flatten(); } catch {} }
      const mid = await PDFDocument.load(await doc.save(), { ignoreEncryption: true });
      const fin = await PDFDocument.create();
      const copied = await fin.copyPages(mid, live);
      copied.forEach((pp) => fin.addPage(pp));
      out = await fin.save();
    } else out = await doc.save();
    S.dirty = false;
    showResult(new Blob([out], { type: 'application/pdf' }), S.file.name.replace(/\.pdf$/i, '') + '-editat.pdf');
  } catch (e) {
    console.error(e);
    toast('Nu s-a putut salva: ' + (e.message || e));
  } finally { busy.remove(); }
}
$('#saveBtn').onclick = save;

function showResult(blob, name) {
  const box = $('#result'); box.innerHTML = '';
  const url = URL.createObjectURL(blob);
  const info = document.createElement('span'); info.textContent = `Gata · ${(blob.size / 1048576).toFixed(blob.size > 1048576 ? 1 : 2)} MB`; info.style.fontWeight = '600'; box.appendChild(info);
  const a = document.createElement('a'); a.className = 'btn primary'; a.href = url; a.download = name; a.textContent = 'Descarcă'; box.appendChild(a);
  const file = new File([blob], name, { type: 'application/pdf' });
  if ((isIOS || matchMedia('(hover: none)').matches) && navigator.canShare?.({ files: [file] })) {
    const s = document.createElement('button'); s.className = 'btn'; s.textContent = 'Salvează / Trimite'; s.onclick = () => navigator.share({ files: [file] }).catch(() => {}); box.appendChild(s);
  }
  const x = document.createElement('button'); x.className = 'ibtn'; x.textContent = '×'; x.onclick = () => (box.hidden = true); box.appendChild(x);
  box.hidden = false;
  window.__lastSave = blob;
}

/* ---------------- file input / drop ---------------- */
$('#pdfInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
addEventListener('dragover', (e) => { e.preventDefault(); $('#empty').classList.add('over'); });
addEventListener('dragleave', () => $('#empty').classList.remove('over'));
addEventListener('drop', (e) => {
  e.preventDefault(); $('#empty').classList.remove('over');
  const f = [...(e.dataTransfer?.files || [])];
  const pdf = f.find((x) => /\.pdf$/i.test(x.name)); const img = f.find((x) => x.type.startsWith('image/'));
  if (pdf) { if (S.dirty && !confirm('Ai modificări nesalvate. Deschizi alt PDF?')) return; openFile(pdf); }
  else if (img && S.pdf) { const dt = new DataTransfer(); dt.items.add(img); $('#imgInput').files = dt.files; $('#imgInput').dispatchEvent(new Event('change')); }
});
addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// keep contentEditable in sync with tool
for (const b of $$('.tool')) b.addEventListener('click', () => { for (const pg of S.pages) for (const it of pg.items) setEditable(it); renderProps(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__edit = { S, openFile, save, setTool, ensureRuns, editRun, addImage, loadFont, lib };
