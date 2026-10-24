// Convert — local, in-browser file converter. No uploads, no limits.
const CDN = 'https://cdn.jsdelivr.net/npm/';
const FFMPEG_CORE = CDN + '@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js';
const FFMPEG_WASM = CDN + '@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm';
const PDFJS = CDN + 'pdfjs-dist@4.10.38/build/';

const $ = (s, el = document) => el.querySelector(s);
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MAX_PIXELS = isIOS ? 16_000_000 : 120_000_000;

/* ---------------- lazy libraries ---------------- */
const cache = {};
const once = (k, fn) => (cache[k] ??= fn().catch((e) => { delete cache[k]; throw e; }));
const loadScript = (src) => new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = src; s.onload = res; s.onerror = () => rej(new Error('Nu s-a putut încărca o librărie (ești offline la prima folosire?)'));
  document.head.appendChild(s);
});
const imp = (url) => import(url).catch(() => { throw new Error('Nu s-a putut încărca o librărie (ești offline la prima folosire?)'); });
const lib = {
  pdfjs: () => once('pdfjs', async () => {
    const m = await imp(PDFJS + 'pdf.min.mjs');
    m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
    return m;
  }),
  jsPDF: () => once('jspdf', async () => { const m = await imp(CDN + 'jspdf@2.5.2/+esm'); return m.jsPDF || m.default.jsPDF || m.default; }),
  pdflib: () => once('pdflib', () => imp(CDN + 'pdf-lib@1.17.1/+esm')),
  docx: () => once('docx', () => imp(CDN + 'docx@9/+esm')),
  docxPreview: () => once('docxPreview', () => imp(CDN + 'docx-preview@0.3/+esm')),
  html2canvas: () => once('h2c', async () => (await imp(CDN + 'html2canvas@1.4.1/+esm')).default),
  mammoth: () => once('mammoth', async () => { await loadScript(CDN + 'mammoth@1/mammoth.browser.min.js'); return window.mammoth; }),
  heic2any: () => once('heic', async () => { await loadScript(CDN + 'heic2any@0.0.4/dist/heic2any.min.js'); return window.heic2any; }),
  JSZip: () => once('jszip', async () => (await imp(CDN + 'jszip@3.10.1/+esm')).default),
  XLSX: () => once('xlsx', async () => { await loadScript(CDN + 'xlsx@0.18.5/dist/xlsx.full.min.js'); return window.XLSX; }),
  pptx: () => once('pptx', async () => { await loadScript(CDN + 'pptxgenjs@3.12.0/dist/pptxgen.bundle.js'); return window.PptxGenJS; }),
  tesseract: () => once('tess', async () => { await loadScript(CDN + 'tesseract.js@5/dist/tesseract.min.js'); return window.Tesseract; }),
};

/* ---------------- ffmpeg (own worker around the core) ---------------- */
class FF {
  constructor() { this.w = null; this.ready = null; this.seq = 0; this.pending = new Map(); this.listener = null; }
  load() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.w = new Worker(new URL('./ffmpeg-worker.js', import.meta.url), { type: 'module' });
      this.w.onmessage = ({ data }) => {
        if (data.type === 'log' || data.type === 'progress') { this.listener?.(data); return; }
        const p = this.pending.get(data.id); if (!p) return;
        this.pending.delete(data.id);
        data.ok ? p.res(data.result) : p.rej(new Error(data.error));
      };
      this.w.onerror = (e) => { e.preventDefault?.(); this.kill(new Error('Motorul video a crăpat (posibil memorie insuficientă).')); };
      await this.call('load', { coreURL: FFMPEG_CORE, wasmURL: FFMPEG_WASM });
    })().catch((e) => {
      this.kill(e);
      const net = /fetch|import|network|load/i.test(e.message);
      throw new Error(net ? 'Nu s-a putut descărca motorul video (ești offline la prima folosire?)' : 'Nu s-a putut porni ffmpeg: ' + e.message);
    });
    return this.ready;
  }
  call(type, payload = {}, transfer = []) {
    return new Promise((res, rej) => {
      const id = ++this.seq;
      this.pending.set(id, { res, rej });
      this.w.postMessage({ id, type, ...payload }, transfer);
    });
  }
  kill(err) {
    this.w?.terminate(); this.w = null; this.ready = null;
    for (const p of this.pending.values()) p.rej(err || new Error('ffmpeg oprit'));
    this.pending.clear();
  }
  write(path, bytes) { return this.call('write', { path, bytes }, [bytes.buffer]); }
  read(path) { return this.call('read', { path }); }
  unlink(path) { return this.call('unlink', { path }); }
  async exec(args, { duration = 0, onProgress } = {}) {
    const logs = [];
    this.listener = (d) => {
      if (d.type === 'log') {
        logs.push(d.message);
        const t = /time=\s*(\d+):(\d+):([\d.]+)/.exec(d.message);
        if (t && duration && onProgress) onProgress(Math.min(1, (+t[1] * 3600 + +t[2] * 60 + +t[3]) / duration));
      }
    };
    try {
      const ret = await this.call('exec', { args });
      return { ret, logs };
    } finally { this.listener = null; }
  }
  async probe(path) {
    const { logs } = await this.exec(['-hide_banner', '-i', path]);
    const all = logs.join('\n');
    const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(all);
    const vLine = /Stream #[^\n]*?: Video: [^\n]*/.exec(all)?.[0] || '';
    const v = /Video: (\w+)/.exec(vLine);
    const a = /Stream #[^\n]*?: Audio: (\w+)/.exec(all);
    const dim = /, (\d{2,5})x(\d{2,5})/.exec(vLine);
    const rot = /rotate\s*:\s*-?(90|270)|rotation of -?(90|270)/.test(all);
    let h = dim ? +dim[2] : 0, w = dim ? +dim[1] : 0;
    if (rot) [w, h] = [h, w];
    return { duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0, v: v?.[1] || null, a: a?.[1] || null, w, h };
  }
}
const ff = new FF();

/* ---------------- OCR ---------------- */
let ocrWorker = null, ocrProgress = null;
async function getOcr(job) {
  if (ocrWorker) return ocrWorker;
  job?.say('Pornesc OCR-ul (prima dată ~15 MB)…', true);
  const T = await lib.tesseract();
  try {
    ocrWorker = await T.createWorker(['ron', 'eng'], 1, {
      logger: (m) => { if (m.status === 'recognizing text') ocrProgress?.(m.progress); },
    });
  } catch (e) { ocrWorker = null; throw new Error('Nu s-a putut porni OCR-ul (ești offline la prima folosire?)'); }
  return ocrWorker;
}
async function ocrText(input, job, label) {
  const w = await getOcr(job);
  job?.say(label || 'Citesc textul (OCR)…');
  ocrProgress = (p) => job?.progress(p);
  try { const { data } = await w.recognize(input); return data.text || ''; }
  finally { ocrProgress = null; }
}
function ocrParas(text) {
  return text.split(/\n\s*\n/).map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean)
    .reduce((acc, l) => (/[-‐]$/.test(acc) && /^[a-zăâîșț]/.test(l) ? acc.replace(/[-‐]$/, '') + l : acc ? acc + ' ' + l : l), ''))
    .filter((p) => p.trim());
}

/* ---------------- formats ---------------- */
const EXT = {
  image: ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'svg', 'tif', 'tiff', 'ico'],
  video: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'ogv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff', 'aif', 'amr'],
  pdf: ['pdf'],
  docx: ['docx', 'doc', 'odt', 'rtf'],
  sheet: ['xlsx', 'xls', 'xlsm', 'ods', 'csv'],
  text: ['txt', 'md', 'log'],
};
const TARGETS = {
  image: ['jpg', 'png', 'webp', 'pdf', 'small', 'docx', 'txt'],
  video: ['mp4', 'small', 'mov', 'mkv', 'webm', 'avi', 'gif', 'mp3', 'wav', 'm4a'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac'],
  pdf: ['docx', 'jpg', 'png', 'txt', 'pptx', 'ocr', 'small', 'merge', 'split'],
  sheet: ['pdf', 'xlsx', 'csv'],
  docx: ['pdf', 'txt'],
  text: ['pdf', 'docx'],
};
const LABELS = { small: 'COMPRIMĂ', ocr: 'PDF CĂUTABIL', merge: 'UNEȘTE', split: 'SEPARĂ PAGINI' };
const TIPS = {
  small: 'Același format, fișier mai mic', ocr: 'OCR: PDF scanat → text selectabil și căutabil',
  merge: 'Unește toate PDF-urile cu „UNEȘTE” într-unul singur, în ordinea din listă', split: 'Fiecare pagină devine un PDF separat',
};
const labelFor = (job, t) => (job?.kind === 'image' && (t === 'docx' || t === 'txt') ? `${t.toUpperCase()} · OCR` : LABELS[t] || t.toUpperCase());
const DEFAULTS = {
  heic: 'jpg', heif: 'jpg', webp: 'jpg', avif: 'jpg', png: 'jpg', jpg: 'png', jpeg: 'png', jfif: 'jpg', bmp: 'png', tif: 'jpg', tiff: 'jpg', svg: 'png',
  mov: 'mp4', mkv: 'mp4', avi: 'mp4', wmv: 'mp4', flv: 'mp4', '3gp': 'mp4', m4v: 'mp4', webm: 'mp4', mpg: 'mp4', mpeg: 'mp4', ts: 'mp4', mts: 'mp4', m2ts: 'mp4', ogv: 'mp4',
  wav: 'mp3', flac: 'mp3', m4a: 'mp3', aac: 'mp3', ogg: 'mp3', oga: 'mp3', opus: 'mp3', wma: 'mp3', aiff: 'mp3', aif: 'mp3', amr: 'mp3',
  pdf: 'docx', docx: 'pdf', txt: 'pdf', md: 'pdf', xlsx: 'pdf', xls: 'pdf', xlsm: 'pdf', ods: 'pdf', csv: 'xlsx',
};
const MIME = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain;charset=utf-8', csv: 'text/csv;charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip',
};
function kindOf(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  for (const [k, list] of Object.entries(EXT)) if (list.includes(ext)) return { kind: k, ext };
  const t = file.type || '';
  if (t.startsWith('image/')) return { kind: 'image', ext: t.split('/')[1] };
  if (t.startsWith('video/')) return { kind: 'video', ext: t.split('/')[1] };
  if (t.startsWith('audio/')) return { kind: 'audio', ext: t.split('/')[1] };
  if (t === 'application/pdf') return { kind: 'pdf', ext: 'pdf' };
  if (t.startsWith('text/')) return { kind: 'text', ext: 'txt' };
  return { kind: null, ext };
}
function targetsFor(job) {
  let list = [...(TARGETS[job.kind] || [])];
  if (job.ext === 'gif') list = ['mp4', 'webm', 'png', 'jpg', 'webp', 'pdf'];
  const same = { jpeg: 'jpg', jfif: 'jpg', heif: 'heic', tiff: 'tif', aif: 'aiff' }[job.ext] || job.ext;
  return list.filter((t) => t !== same);
}

/* ---------------- options ---------------- */
const opts = {
  quality: 90, videoQ: '23', dpi: '2.5', gifW: '480', gifFps: '15', forceH264: false, mergePdf: true, maxImg: '0', maxVid: '0',
};
try { Object.assign(opts, JSON.parse(localStorage.getItem('convert.opts') || '{}')); } catch {}
const optEls = {
  quality: $('#optQuality'), videoQ: $('#optVideoQ'), dpi: $('#optDpi'), gifW: $('#optGifW'), gifFps: $('#optGifFps'),
  forceH264: $('#optForceH264'), mergePdf: $('#optMergePdf'), maxImg: $('#optMaxImg'), maxVid: $('#optMaxVid'),
};
for (const [k, el] of Object.entries(optEls)) {
  if (!el) continue;
  if (el.type === 'checkbox') el.checked = !!opts[k]; else el.value = opts[k];
  el.addEventListener('input', () => {
    opts[k] = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'quality') $('#qVal').textContent = el.value;
    try { localStorage.setItem('convert.opts', JSON.stringify(opts)); } catch {}
  });
}
$('#qVal').textContent = opts.quality;
$('#settingsBtn').addEventListener('click', (e) => {
  const s = $('#settings'); s.hidden = !s.hidden; e.currentTarget.setAttribute('aria-expanded', String(!s.hidden));
});

/* ---------------- helpers ---------------- */
const baseName = (n) => n.replace(/\.[^.]+$/, '') || 'fisier';
const fmtSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
const canvasToBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (s) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60); const ss = (x < 10 ? '0' : '') + (Number.isInteger(x) ? x : x.toFixed(1)); return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`; };
function parseTime(str) {
  str = (str || '').trim().replace(',', '.');
  if (!str) return null;
  const parts = str.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0) || parts.length > 3) return NaN;
  return parts.reduce((t, n) => t * 60 + n, 0);
}
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

/* ---------------- image pipeline ---------------- */
async function decodeImage(file, ext, job) {
  if (ext === 'svg') {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
      const s = Math.max(1, 2048 / Math.max(w, h)); // render svgs crisp
      return { src: img, w: Math.round(w * s), h: Math.round(h * s), cleanup: () => URL.revokeObjectURL(url) };
    } catch (e) { URL.revokeObjectURL(url); throw new Error('SVG invalid'); }
  }
  try {
    const bmp = await createImageBitmap(file);
    return { src: bmp, w: bmp.width, h: bmp.height, cleanup: () => bmp.close() };
  } catch {}
  if (ext === 'heic' || ext === 'heif') {
    job?.say('Decodez HEIC…', true);
    const heic2any = await lib.heic2any();
    let out = await heic2any({ blob: file, toType: 'image/png' });
    if (Array.isArray(out)) out = out[0];
    const bmp = await createImageBitmap(out);
    return { src: bmp, w: bmp.width, h: bmp.height, cleanup: () => bmp.close() };
  }
  // last resort: let ffmpeg decode it (tiff, odd bmp, ico…)
  job?.say('Decodez cu ffmpeg…', true);
  const png = await ffmpegRun(file, ext, 'png', ['-frames:v', '1'], job);
  const bmp = await createImageBitmap(png);
  return { src: bmp, w: bmp.width, h: bmp.height, cleanup: () => bmp.close() };
}
function drawToCanvas(img, bg, maxSide = 0) {
  let { w, h } = img;
  let scaled = false, resized = false;
  if (maxSide && Math.max(w, h) > maxSide) { const s = maxSide / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); resized = true; }
  if (w * h > MAX_PIXELS) { const s = Math.sqrt(MAX_PIXELS / (w * h)); w = Math.floor(w * s); h = Math.floor(h * s); scaled = true; }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img.src, 0, 0, w, h);
  return { canvas: c, scaled, resized };
}
async function encodeCanvas(canvas, target, quality = opts.quality) {
  const q = quality / 100;
  if (target === 'png') return canvasToBlob(canvas, 'image/png');
  if (target === 'jpg') return canvasToBlob(canvas, 'image/jpeg', q);
  if (target === 'webp') {
    const b = await canvasToBlob(canvas, 'image/webp', q);
    if (b && b.type === 'image/webp') return b;
    // Safari can't encode WebP from canvas → ffmpeg
    const png = await canvasToBlob(canvas, 'image/png');
    return ffmpegRun(png, 'png', 'webp', ['-c:v', 'libwebp', '-quality', String(quality)], null);
  }
  throw new Error('format necunoscut');
}
async function imageConvert(job, target) {
  if (target === 'pdf') return imagesToPdf([job], job);
  if (target === 'docx' || target === 'txt') return imageOcr(job, target);
  const small = target === 'small';
  const fmt = small ? (['jpg', 'jpeg', 'jfif'].includes(job.ext) ? 'jpg' : job.ext === 'webp' ? 'webp' : 'jpg') : target;
  job.say(small ? 'Comprim…' : 'Convertesc…', true);
  const img = await decodeImage(job.file, job.ext, job);
  try {
    const maxSide = +opts.maxImg || (small ? 2560 : 0);
    const { canvas, scaled, resized } = drawToCanvas(img, fmt === 'jpg' ? '#ffffff' : null, maxSide);
    let blob = await encodeCanvas(canvas, fmt, small ? Math.min(opts.quality, 78) : opts.quality);
    const notes = [];
    if (resized) notes.push(`Redimensionată la ${canvas.width}×${canvas.height}.`);
    if (scaled) notes.push('Poza era prea mare pentru iPhone, am micșorat-o.');
    if (small) {
      if (blob.size >= job.file.size && fmt === job.ext.replace(/jpeg|jfif/, 'jpg')) { blob = job.file; notes.push('Era deja optimizată, am păstrat originalul.'); }
      else notes.push(`−${Math.max(0, Math.round((1 - blob.size / job.file.size) * 100))}% față de original.`);
      if (fmt !== job.ext.replace(/jpeg|jfif/, 'jpg')) notes.push(`Salvată ca ${fmt.toUpperCase()}.`);
    }
    job.note = notes.join(' ');
    return [{ name: `${baseName(job.file.name)}${small ? '-mic' : ''}.${fmt}`, blob }];
  } finally { img.cleanup?.(); }
}
async function imageOcr(job, target) {
  const img = await decodeImage(job.file, job.ext, job);
  let text;
  try {
    const { canvas } = drawToCanvas(img, '#ffffff', 4000);
    text = await ocrText(canvas, job);
  } finally { img.cleanup?.(); }
  const paras = ocrParas(text);
  if (!paras.length) throw new Error('N-am găsit text în poză.');
  job.note = 'Text recunoscut cu OCR — recitește-l, pot fi greșeli.';
  if (target === 'txt') return [{ name: `${baseName(job.file.name)}.txt`, blob: new Blob([paras.join('\n\n')], { type: MIME.txt }) }];
  const D = await lib.docx();
  const doc = new D.Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children: paras.map((p) => new D.Paragraph({ spacing: { after: 120 }, children: [new D.TextRun(p)] })) }],
  });
  return [{ name: `${baseName(job.file.name)}.docx`, blob: await D.Packer.toBlob(doc) }];
}
async function imagesToPdf(jobs, statusJob) {
  const jsPDF = await lib.jsPDF();
  let doc = null;
  let i = 0;
  for (const j of jobs) {
    statusJob.say(jobs.length > 1 ? `Pagina ${++i}/${jobs.length}…` : 'Fac PDF-ul…', true);
    const img = await decodeImage(j.file, j.ext, statusJob);
    try {
      const { canvas } = drawToCanvas(img, '#ffffff', +opts.maxImg || 0);
      // page: long side = A4 height (842pt), image stays at full resolution inside
      const s = 842 / Math.max(canvas.width, canvas.height);
      const pw = canvas.width * s, ph = canvas.height * s;
      const orient = pw > ph ? 'l' : 'p';
      if (!doc) doc = new jsPDF({ unit: 'pt', format: [pw, ph], orientation: orient, compress: true });
      else doc.addPage([pw, ph], orient);
      const data = canvas.toDataURL('image/jpeg', Math.max(0.85, opts.quality / 100));
      doc.addImage(data, 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
    } finally { img.cleanup?.(); }
    await sleep(0);
  }
  const name = jobs.length > 1 ? 'poze.pdf' : `${baseName(jobs[0].file.name)}.pdf`;
  return [{ name, blob: doc.output('blob') }];
}

/* ---------------- ffmpeg pipelines ---------------- */
async function ffmpegRun(input, inExt, outExt, args, job) {
  if (!ff.ready) job?.say('Pornesc motorul video (prima dată ~30 MB)…', true);
  await ff.load();
  const inName = `in.${inExt || 'bin'}`, outName = `out.${outExt}`;
  await ff.write(inName, new Uint8Array(await input.arrayBuffer()));
  try {
    const { ret, logs } = await ff.exec(['-hide_banner', '-y', '-i', inName, ...args, outName]);
    if (ret !== 0) throw new Error(lastError(logs));
    const data = await ff.read(outName);
    return new Blob([data], { type: MIME[outExt] || 'application/octet-stream' });
  } finally {
    await ff.unlink(inName).catch(() => {}); await ff.unlink(outName).catch(() => {});
  }
}
function lastError(logs) {
  const l = logs.filter((x) => /error|invalid|not|could|unsupported|failed/i.test(x)).slice(-1)[0];
  return 'ffmpeg: ' + (l ? l.trim().slice(0, 160) : 'conversia a eșuat');
}

async function mediaConvert(job, target) {
  const trim = readTrim(job);
  if (!ff.ready) job.say('Pornesc motorul video (prima dată ~30 MB)…', true);
  await ff.load();
  const outExt = target === 'small' ? 'mp4' : target;
  const inName = `in.${job.ext}`, outName = `out.${outExt}`;
  job.say('Citesc fișierul…', true);
  await ff.write(inName, new Uint8Array(await job.file.arrayBuffer()));
  try {
    const info = await ff.probe(inName);
    if (trim.start != null && info.duration && trim.start >= info.duration) throw new Error(`Începutul (${fmtTime(trim.start)}) e după finalul clipului (${fmtTime(info.duration)}).`);
    const pre = [];
    if (trim.start) pre.push('-ss', String(trim.start));
    if (trim.end != null) pre.push('-t', String(trim.end - (trim.start || 0)));
    const dur = Math.max(0.1, (trim.end ?? info.duration) - (trim.start || 0));
    const plans = buildPlans(info, target, trim);
    let lastLogs = [];
    for (const plan of plans) {
      job.say(plan.label, !info.duration);
      job.progress(0);
      const { ret, logs } = await ff.exec(['-hide_banner', '-y', ...pre, '-i', inName, ...plan.args, outName], {
        duration: dur, onProgress: (p) => job.progress(p),
      });
      lastLogs = logs;
      if (ret === 0) {
        const data = await ff.read(outName);
        if (data.byteLength > 0) {
          const notes = [];
          if (plan.note) notes.push(plan.note);
          if (trim.start != null || trim.end != null) notes.push(`Tăiat ${fmtTime(trim.start || 0)} → ${fmtTime(trim.end ?? info.duration)}.`);
          if (target === 'small') {
            if (data.byteLength >= job.file.size) { job.note = 'Nu s-a putut micșora mai mult — e deja comprimat bine.'; return [{ name: job.file.name, blob: job.file }]; }
            notes.push(`−${Math.round((1 - data.byteLength / job.file.size) * 100)}% față de original.`);
          }
          let outData = data;
          if (trim.loop) {
            outData = await loopPass(job, data, outExt, trim, dur);
            notes.push(trim.loop.mode === 'boom' ? 'Boomerang (înainte + înapoi, fără sunet).' : trim.loop.mode === 'until' ? `Repetat până la ${fmtTime(trim.loop.secs)}.` : `Repetat de ${trim.loop.n} ori.`);
          }
          job.note = notes.join(' ');
          const suffix = trim.loop ? (trim.loop.mode === 'boom' ? '-boomerang' : '-loop') : target === 'small' ? '-mic' : (trim.start != null || trim.end != null) ? '-taiat' : '';
          return [{ name: `${baseName(job.file.name)}${suffix}.${outExt}`, blob: new Blob([outData], { type: MIME[outExt] }) }];
        }
      }
      await ff.unlink(outName).catch(() => {});
    }
    throw new Error(lastError(lastLogs));
  } finally {
    await ff.unlink(inName).catch(() => {}); await ff.unlink(outName).catch(() => {});
  }
}
function buildPlans(info, target, trim) {
  const crf = String(opts.videoQ);
  const maxH = +opts.maxVid || 0;
  const scaleTo = (H) => (H ? `scale=-2:'trunc(min(ih,${H})/2)*2'` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  const needsScale = maxH && info.h > maxH;
  const x264 = (c = crf, H = maxH) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', c, '-pix_fmt', 'yuv420p', '-vf', scaleTo(H)];
  const aac = (br = '160k') => (trim.mute ? ['-an'] : ['-c:a', 'aac', '-b:a', br]);
  const mapVA = trim.mute ? ['-map', '0:v:0'] : ['-map', '0:v:0', '-map', '0:a:0?'];
  const needAudio = () => { if (!info.a) throw new Error('Fișierul nu are pistă audio.'); };
  const needVideo = () => { if (!info.v) throw new Error('Fișierul nu are pistă video.'); };
  const enc = { label: 'Re-encodez video (durează)…', args: [] };
  switch (target) {
    case 'small': {
      needVideo();
      const H = maxH || (info.h > 1080 ? 1080 : 0);
      const c = String(Math.max(27, +crf + 4));
      return [{ label: 'Comprim video (durează)…', args: [...mapVA, ...x264(c, H), ...aac('128k'), '-movflags', '+faststart'] }];
    }
    case 'mp4': case 'mov': {
      needVideo();
      const aOk = !info.a || trim.mute || ['aac', 'mp3', 'alac'].includes(info.a);
      const vOk = !needsScale && (info.v === 'h264' || (info.v === 'hevc' && !opts.forceH264));
      const fast = target === 'mp4' ? ['-movflags', '+faststart'] : [];
      const encode = { ...enc, args: [...mapVA, ...x264(), ...aac(), ...fast] };
      if (vOk) {
        const tag = info.v === 'hevc' ? ['-tag:v', 'hvc1'] : [];
        const audio = trim.mute ? ['-an'] : aOk ? ['-c:a', 'copy'] : aac();
        const copy = { label: 'Schimb containerul (rapid, fără pierderi)…', args: [...mapVA, '-c:v', 'copy', ...tag, ...audio, ...fast] };
        if (info.v === 'hevc') copy.note = 'Video-ul e HEVC (H.265), l-am păstrat așa. Dacă nu merge pe un PC vechi, bifează „forțează H.264” în setări.';
        if (trim.start) copy.note = ((copy.note || '') + ' Tăiere rapidă: începutul poate sări la cel mai apropiat cadru-cheie (~1 s).').trim();
        return [copy, encode];
      }
      return [encode];
    }
    case 'mkv':
      needVideo();
      return needsScale ? [{ ...enc, args: [...mapVA, ...x264(), ...aac()] }] : [
        { label: 'Schimb containerul (rapid)…', args: trim.mute ? ['-map', '0', '-map', '-0:a', '-c', 'copy'] : ['-map', '0', '-c', 'copy'] },
        { ...enc, args: [...mapVA, ...x264(), ...aac()] },
      ];
    case 'webm': {
      needVideo();
      const br = { 20: '4M', 23: '2500k', 28: '1200k' }[crf] || '2500k';
      return [{ label: 'Encodez WebM (durează)…', args: [...mapVA, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', br, '-crf', '10', '-vf', scaleTo(maxH), ...(trim.mute ? ['-an'] : ['-c:a', 'libvorbis', '-q:a', '5'])] }];
    }
    case 'avi':
      needVideo();
      return [{ label: 'Encodez AVI…', args: [...mapVA, '-c:v', 'mpeg4', '-q:v', crf === '20' ? '2' : crf === '28' ? '6' : '4', '-vf', scaleTo(maxH), ...(trim.mute ? ['-an'] : ['-c:a', 'libmp3lame', '-q:a', '4'])] }];
    case 'gif': {
      needVideo();
      const w = opts.gifW, fps = opts.gifFps;
      return [{ label: 'Fac GIF-ul…', args: ['-vf', `fps=${fps},scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0'] }];
    }
    case 'mp3': needAudio(); return [{ label: 'Extrag MP3…', args: ['-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '2'] }];
    case 'wav': needAudio(); return [{ label: 'Extrag WAV…', args: ['-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le'] }];
    case 'flac': needAudio(); return [{ label: 'Encodez FLAC…', args: ['-map', '0:a:0', '-vn', '-c:a', 'flac'] }];
    case 'ogg': needAudio(); return [{ label: 'Encodez OGG…', args: ['-map', '0:a:0', '-vn', '-c:a', 'libvorbis', '-q:a', '6'] }];
    case 'm4a': {
      needAudio();
      const plans = [{ label: 'Encodez M4A…', args: ['-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k'] }];
      if (info.a === 'aac') plans.unshift({ label: 'Extrag audio (rapid)…', args: ['-map', '0:a:0', '-vn', '-c:a', 'copy'] });
      return plans;
    }
  }
  throw new Error('Conversie nesuportată');
}
function readTrim(job) {
  const el = job.el;
  const start = parseTime($('.t-start', el)?.value), end = parseTime($('.t-end', el)?.value);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('Timp invalid. Scrie gen 1:30 sau 90.');
  if (start != null && end != null && end <= start) throw new Error('Finalul trebuie să fie după început.');
  const lv = $('.t-loop', el)?.value || 'off';
  let loop = null;
  if (lv === 'boom') loop = { mode: 'boom' };
  else if (lv === 'until') {
    const secs = +$('.t-secs', el).value;
    if (!(secs >= 1)) throw new Error('Scrie câte secunde să aibă loop-ul.');
    loop = { mode: 'until', secs };
  } else if (lv !== 'off') loop = { mode: 'times', n: +lv };
  return { start: start || null, end, mute: !!$('.t-mute', el)?.checked, loop };
}
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg', 'flac'];
function encodeArgs(ext, mute) {
  const v = { mp4: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(opts.videoQ), '-pix_fmt', 'yuv420p'],
    webm: ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2500k', '-crf', '10'], avi: ['-c:v', 'mpeg4', '-q:v', '4'], gif: [] };
  v.mov = v.mkv = v.mp4;
  const a = { mp4: ['-c:a', 'aac', '-b:a', '160k'], webm: ['-c:a', 'libvorbis', '-q:a', '5'], avi: ['-c:a', 'libmp3lame', '-q:a', '4'], gif: ['-an'],
    mp3: ['-c:a', 'libmp3lame', '-q:a', '2'], wav: ['-c:a', 'pcm_s16le'], m4a: ['-c:a', 'aac', '-b:a', '192k'], ogg: ['-c:a', 'libvorbis', '-q:a', '6'], flac: ['-c:a', 'flac'] };
  a.mov = a.mkv = a.mp4;
  return { v: v[ext] || [], a: mute ? ['-an'] : a[ext] || [], fast: ext === 'mp4' ? ['-movflags', '+faststart'] : [] };
}
async function loopPass(job, data, ext, trim, dur) {
  const lp = trim.loop, mid = `mid.${ext}`, out = `loop.${ext}`;
  const total = lp.mode === 'boom' ? dur * 2 : lp.mode === 'until' ? lp.secs : dur * lp.n;
  const enc = encodeArgs(ext, trim.mute);
  const tries = [];
  if (lp.mode === 'boom') {
    if (AUDIO_EXT.includes(ext)) throw new Error('Boomerang merge doar pe video.');
    const vf = ext === 'gif'
      ? '[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0,split[x][y];[x]palettegen=stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=4[v]'
      : '[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0,scale=trunc(iw/2)*2:trunc(ih/2)*2[v]';
    tries.push(['-i', mid, '-filter_complex', vf, '-map', '[v]', ...enc.v, ...(ext === 'gif' ? ['-loop', '0'] : []), ...enc.fast]);
  } else {
    const pre = lp.mode === 'until' ? ['-stream_loop', '-1'] : ['-stream_loop', String(lp.n - 1)];
    const post = lp.mode === 'until' ? ['-t', String(lp.secs)] : [];
    tries.push([...pre, '-i', mid, ...post, '-c', 'copy', ...enc.fast]);
    tries.push([...pre, '-i', mid, ...post, ...enc.v, ...enc.a, ...enc.fast]);
  }
  await ff.write(mid, data);
  try {
    for (const args of tries) {
      job.say(lp.mode === 'boom' ? 'Fac boomerang-ul…' : 'Fac loop-ul…');
      job.progress(0);
      const { ret } = await ff.exec(['-hide_banner', '-y', ...args, out], { duration: total, onProgress: (p) => job.progress(p) });
      if (ret === 0) {
        const d = await ff.read(out);
        if (d.byteLength) return d;
      }
      await ff.unlink(out).catch(() => {});
    }
    throw new Error(lp.mode === 'boom' ? 'Boomerang-ul a eșuat (clipul e prea lung pentru memorie?). Încearcă o bucată mai scurtă.' : 'Loop-ul a eșuat pentru formatul ăsta.');
  } finally { await ff.unlink(mid).catch(() => {}); await ff.unlink(out).catch(() => {}); }
}

/* ---------------- PDF pipelines ---------------- */
async function pdfBytes(job) { return new Uint8Array(await job.file.arrayBuffer()); }
async function openPdf(job) {
  const pdfjs = await lib.pdfjs();
  try { return await pdfjs.getDocument({ data: await pdfBytes(job), isEvalSupported: false }).promise; }
  catch (e) { if (/password/i.test(e.name + e.message)) throw new Error('PDF-ul are parolă.'); throw e; }
}
async function renderPdfPage(page, scale) {
  const vp = page.getViewport({ scale });
  const w = Math.floor(vp.width), h = Math.floor(vp.height);
  if (w * h > MAX_PIXELS) { const s = Math.sqrt(MAX_PIXELS / (w * h)); return renderPdfPage(page, scale * s * 0.98); }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}
async function pdfToImages(job, target) {
  const pdf = await openPdf(job);
  const out = [];
  const n = pdf.numPages, pad = String(n).length;
  for (let i = 1; i <= n; i++) {
    job.say(`Pagina ${i}/${n}…`); job.progress((i - 1) / n);
    const page = await pdf.getPage(i);
    const c = await renderPdfPage(page, +opts.dpi);
    const blob = await encodeCanvas(c, target);
    out.push({ name: n === 1 ? `${baseName(job.file.name)}.${target}` : `${baseName(job.file.name)}-p${String(i).padStart(pad, '0')}.${target}`, blob });
    page.cleanup(); c.width = c.height = 0;
  }
  pdf.destroy();
  return out;
}
function pageLines(items, styles) {
  const lines = [];
  const its = items.filter((it) => 'str' in it && it.str !== '').map((it) => {
    const [a, b, , d, x, y] = it.transform;
    const size = Math.hypot(a, b) || Math.abs(d) || it.height || 10;
    const font = (styles[it.fontName]?.fontFamily || '') + ' ' + it.fontName;
    return { str: it.str, x, y, w: it.width, size, bold: /bold|black|heavy|semibold/i.test(font) };
  }).sort((p, q) => (Math.abs(q.y - p.y) > Math.min(p.size, q.size) * 0.4 ? q.y - p.y : p.x - q.x));
  for (const it of its) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(L.y - it.y) < Math.max(L.size, it.size) * 0.45) {
      const gap = it.x - L.endX;
      if (gap > it.size * 0.2 && !L.text.endsWith(' ') && !it.str.startsWith(' ')) L.text += ' ';
      L.text += it.str; L.endX = it.x + it.w; L.size = Math.max(L.size, it.size); L.bold = L.bold && it.bold;
    } else {
      lines.push({ text: it.str, y: it.y, x: it.x, endX: it.x + it.w, size: it.size, bold: it.bold });
    }
  }
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
}
function linesToParas(lines) {
  const paras = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], prev = lines[i - 1], P = paras[paras.length - 1];
    const gap = prev ? prev.y - l.y : 0;
    const sameStyle = prev && Math.abs(prev.size - l.size) / l.size < 0.15 && prev.bold === l.bold;
    const cont = prev && P && sameStyle && gap > 0 && gap < l.size * 1.75 && !/^([•\-–▪●]|\d+[.)])\s/.test(l.text);
    if (cont) {
      P.text = /[-‐]$/.test(P.text) && /^[a-zăâîșț]/.test(l.text) ? P.text.replace(/[-‐]$/, '') + l.text : P.text + ' ' + l.text;
    } else paras.push({ text: l.text, size: l.size, bold: l.bold });
  }
  return paras;
}
const hasRealText = (tc) => tc.items.reduce((n, it) => n + ((it.str || '').trim().length), 0) > 20;

async function pdfToDocx(job) {
  const pdf = await openPdf(job);
  const D = await lib.docx();
  const pages = [];
  const sizes = [];
  let ocrPages = 0, imgPages = 0;
  const n = pdf.numPages;
  for (let i = 1; i <= n; i++) {
    job.say(`Citesc pagina ${i}/${n}…`); job.progress((i - 1) / n);
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let paras = hasRealText(tc) ? linesToParas(pageLines(tc.items, tc.styles)) : [];
    paras.forEach((p) => sizes.push(p.size));
    let image = null, ocr = null;
    if (!paras.length) {
      const c = await renderPdfPage(page, 3);
      const text = await ocrText(c, job, `OCR pagina ${i}/${n}…`);
      ocr = ocrParas(text);
      if (ocr.length) ocrPages++;
      else {
        imgPages++;
        const s = 1600 / c.width;
        const small = document.createElement('canvas'); small.width = 1600; small.height = Math.round(c.height * s);
        small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
        image = { data: new Uint8Array(await (await canvasToBlob(small, 'image/jpeg', 0.85)).arrayBuffer()), w: small.width, h: small.height };
      }
      c.width = c.height = 0;
    }
    pages.push({ paras, image, ocr });
    page.cleanup();
  }
  pdf.destroy();
  sizes.sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 11;
  const children = [];
  pages.forEach((pg, idx) => {
    if (idx > 0) children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
    if (pg.image) {
      const w = 600, h = Math.round((pg.image.h / pg.image.w) * w);
      children.push(new D.Paragraph({ children: [new D.ImageRun({ type: 'jpg', data: pg.image.data, transformation: { width: w, height: Math.min(h, 860) } })] }));
      return;
    }
    if (pg.ocr) {
      for (const t of pg.ocr) children.push(new D.Paragraph({ spacing: { after: 120 }, children: [new D.TextRun({ text: t, size: 22 })] }));
      return;
    }
    for (const p of pg.paras) {
      const heading = p.size > body * 1.25;
      const sz = Math.round(Math.min(48, Math.max(8, heading ? p.size : body)) * 2);
      children.push(new D.Paragraph({ spacing: { after: heading ? 160 : 120 }, children: [new D.TextRun({ text: p.text, size: sz, bold: p.bold || heading })] }));
    }
  });
  const doc = new D.Document({ styles: { default: { document: { run: { font: 'Calibri' } } } }, sections: [{ children }] });
  const blob = await D.Packer.toBlob(doc);
  const notes = [];
  if (ocrPages) notes.push(ocrPages === n ? 'PDF scanat — text recunoscut cu OCR, recitește-l.' : `${ocrPages} pagini scanate citite cu OCR.`);
  if (imgPages) notes.push(`${imgPages} pagini fără text puse ca imagini.`);
  job.note = notes.join(' ');
  return [{ name: `${baseName(job.file.name)}.docx`, blob }];
}
async function pdfToTxt(job) {
  const pdf = await openPdf(job);
  const parts = [];
  let ocrPages = 0;
  const n = pdf.numPages;
  for (let i = 1; i <= n; i++) {
    job.say(`Pagina ${i}/${n}…`); job.progress((i - 1) / n);
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    if (hasRealText(tc)) parts.push(linesToParas(pageLines(tc.items, tc.styles)).map((p) => p.text).join('\n\n'));
    else {
      const c = await renderPdfPage(page, 3);
      parts.push(ocrParas(await ocrText(c, job, `OCR pagina ${i}/${n}…`)).join('\n\n'));
      c.width = c.height = 0; ocrPages++;
    }
    page.cleanup();
  }
  pdf.destroy();
  const text = parts.join('\n\n\f\n\n');
  if (!text.replace(/\s/g, '')) throw new Error('N-am găsit niciun text în PDF.');
  if (ocrPages) job.note = 'Pagini scanate citite cu OCR — recitește textul.';
  return [{ name: `${baseName(job.file.name)}.txt`, blob: new Blob([text], { type: MIME.txt }) }];
}
async function pdfSearchable(job) {
  const pdf = await openPdf(job);
  const { PDFDocument } = await lib.pdflib();
  const src = await PDFDocument.load(await pdfBytes(job), { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const n = pdf.numPages;
  let ocrPages = 0;
  for (let i = 1; i <= n; i++) {
    job.say(`Pagina ${i}/${n}…`); job.progress((i - 1) / n);
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    if (hasRealText(tc)) {
      const [p] = await out.copyPages(src, [i - 1]); out.addPage(p);
    } else {
      const DPI = 216;
      const c = await renderPdfPage(page, DPI / 72);
      const jpg = await canvasToBlob(c, 'image/jpeg', 0.8);
      const w = await getOcr(job);
      await w.setParameters({ user_defined_dpi: String(Math.round(DPI * c.width / Math.floor(page.getViewport({ scale: DPI / 72 }).width))) });
      job.say(`OCR pagina ${i}/${n}…`);
      ocrProgress = (p) => job.progress((i - 1 + p) / n);
      let data;
      try { ({ data } = await w.recognize(jpg, {}, { pdf: true })); } finally { ocrProgress = null; }
      const one = await PDFDocument.load(new Uint8Array(data.pdf));
      const [p] = await out.copyPages(one, [0]);
      const vp = page.getViewport({ scale: 1 });
      const { width, height } = p.getSize();
      if (Math.abs(width - vp.width) > 2) { p.scale(vp.width / width, vp.height / height); }
      out.addPage(p);
      ocrPages++;
      c.width = c.height = 0;
    }
    page.cleanup();
  }
  pdf.destroy();
  if (!ocrPages) { job.note = 'PDF-ul avea deja text selectabil — nu era nevoie de OCR.'; return [{ name: job.file.name, blob: job.file }]; }
  job.note = `${ocrPages} ${ocrPages === 1 ? 'pagină trecută' : 'pagini trecute'} prin OCR — acum poți căuta și copia textul.`;
  const bytes = await out.save();
  return [{ name: `${baseName(job.file.name)}-cautabil.pdf`, blob: new Blob([bytes], { type: MIME.pdf }) }];
}
async function pdfCompress(job) {
  const pdf = await openPdf(job);
  const jsPDF = await lib.jsPDF();
  let doc = null;
  const n = pdf.numPages;
  let textPages = 0;
  for (let i = 1; i <= n; i++) {
    job.say(`Comprim pagina ${i}/${n}…`); job.progress((i - 1) / n);
    const page = await pdf.getPage(i);
    if (hasRealText(await page.getTextContent())) textPages++;
    const vp = page.getViewport({ scale: 1 });
    const c = await renderPdfPage(page, 1.6);
    const pw = vp.width, ph = vp.height, orient = pw > ph ? 'l' : 'p';
    if (!doc) doc = new jsPDF({ unit: 'pt', format: [pw, ph], orientation: orient, compress: true });
    else doc.addPage([pw, ph], orient);
    doc.addImage(c.toDataURL('image/jpeg', 0.6), 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
    c.width = c.height = 0; page.cleanup();
  }
  pdf.destroy();
  const blob = doc.output('blob');
  if (blob.size >= job.file.size * 0.9) {
    job.note = 'PDF-ul e deja mic — comprimarea n-ar fi ajutat, am păstrat originalul.';
    return [{ name: job.file.name, blob: job.file }];
  }
  job.note = `−${Math.round((1 - blob.size / job.file.size) * 100)}% față de original.` + (textPages ? ' Textul devine imagine (nu se mai poate selecta).' : '');
  return [{ name: `${baseName(job.file.name)}-mic.pdf`, blob }];
}
async function pdfSplit(job) {
  job.say('Separ paginile…', true);
  const { PDFDocument } = await lib.pdflib();
  const src = await PDFDocument.load(await pdfBytes(job), { ignoreEncryption: true });
  const n = src.getPageCount(), pad = String(n).length;
  if (n === 1) throw new Error('PDF-ul are o singură pagină.');
  const out = [];
  for (let i = 0; i < n; i++) {
    job.progress(i / n);
    const d = await PDFDocument.create();
    const [p] = await d.copyPages(src, [i]); d.addPage(p);
    out.push({ name: `${baseName(job.file.name)}-p${String(i + 1).padStart(pad, '0')}.pdf`, blob: new Blob([await d.save()], { type: MIME.pdf }) });
  }
  return out;
}
async function pdfMerge(list, statusJob) {
  const { PDFDocument } = await lib.pdflib();
  const out = await PDFDocument.create();
  let k = 0;
  for (const j of list) {
    statusJob.say(`Adaug ${++k}/${list.length}…`); statusJob.progress((k - 1) / list.length);
    let src;
    try { src = await PDFDocument.load(await pdfBytes(j), { ignoreEncryption: true }); }
    catch { throw new Error(`Nu pot citi ${j.file.name}.`); }
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  statusJob.note = `${list.length} PDF-uri, ${out.getPageCount()} pagini.`;
  return [{ name: list.length > 1 ? 'unite.pdf' : list[0].file.name, blob: new Blob([await out.save()], { type: MIME.pdf }) }];
}

/* ---------------- Word pipelines ---------------- */
function checkWordFormat(job) {
  if (job.ext !== 'docx') throw new Error(`.${job.ext} nu e suportat în browser. Deschide-l în Word/LibreOffice și salvează-l ca .docx.`);
}
async function docxToPdf(job) {
  checkWordFormat(job);
  job.say('Randez documentul…', true);
  const [{ renderAsync }, html2canvas, jsPDF] = await Promise.all([lib.docxPreview(), lib.html2canvas(), lib.jsPDF()]);
  const host = document.createElement('div');
  host.className = 'render-host';
  document.body.appendChild(host);
  try {
    await renderAsync(await job.file.arrayBuffer(), host, null, {
      inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: true, experimental: true,
      renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, useBase64URL: true,
    });
    await document.fonts.ready;
    await Promise.all([...host.querySelectorAll('img')].map((i) => i.decode().catch(() => {})));
    const pages = [...host.querySelectorAll('section.docx')];
    if (!pages.length) throw new Error('Documentul pare gol.');
    let doc = null;
    for (let i = 0; i < pages.length; i++) {
      job.say(`Pagina ${i + 1}/${pages.length}…`); job.progress(i / pages.length);
      const el = pages[i];
      const canvas = await html2canvas(el, {
        scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false,
        windowWidth: Math.max(1200, el.scrollWidth + 50),
        onclone: (d) => { const h = d.querySelector('.render-host'); if (h) h.style.opacity = '1'; },
      });
      const pw = el.offsetWidth * 0.75, ph = el.offsetHeight * 0.75;
      const orient = pw > ph ? 'l' : 'p';
      if (!doc) doc = new jsPDF({ unit: 'pt', format: [pw, ph], orientation: orient, compress: true });
      else doc.addPage([pw, ph], orient);
      doc.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pw, ph, undefined, 'FAST');
      canvas.width = canvas.height = 0;
    }
    job.note = 'Aspect fidel, dar textul din PDF e imagine (nu se poate selecta). Vrei text selectabil? Trece-l apoi prin „PDF căutabil”.';
    return [{ name: `${baseName(job.file.name)}.pdf`, blob: doc.output('blob') }];
  } finally { host.remove(); }
}
async function docxToTxt(job) {
  checkWordFormat(job);
  job.say('Extrag textul…', true);
  const mammoth = await lib.mammoth();
  const { value } = await mammoth.extractRawText({ arrayBuffer: await job.file.arrayBuffer() });
  return [{ name: `${baseName(job.file.name)}.txt`, blob: new Blob([value], { type: MIME.txt }) }];
}

/* ---------------- text pipelines ---------------- */
async function readText(file) {
  const buf = await file.arrayBuffer();
  let t = new TextDecoder('utf-8').decode(buf);
  if ((t.match(/�/g) || []).length > 3) { try { t = new TextDecoder('windows-1250').decode(buf); } catch {} }
  return t.replace(/\r\n?/g, '\n');
}
async function txtToPdf(job) {
  job.say('Fac PDF-ul…', true);
  const jsPDF = await lib.jsPDF();
  const text = await readText(job.file);
  try { await document.fonts.load('13px "Instrument Sans"'); } catch {}
  const S = 2, W = 794 * S, H = 1123 * S, M = 72 * S, FS = 13 * S, LH = FS * 1.55;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const font = `${FS}px "Instrument Sans", Arial, sans-serif`;
  ctx.font = font;
  const maxW = W - 2 * M;
  const lines = [];
  for (const raw of text.split('\n')) {
    if (raw === '\f') { lines.push('\f'); continue; }
    const words = raw.replace(/\t/g, '    ').split(/(\s+)/);
    let cur = '';
    for (const w of words) {
      if (ctx.measureText(cur + w).width <= maxW) { cur += w; continue; }
      if (cur.trim()) lines.push(cur.trimEnd());
      cur = w.trimStart();
      while (ctx.measureText(cur).width > maxW) { // very long word
        let k = cur.length; while (k > 1 && ctx.measureText(cur.slice(0, k)).width > maxW) k--;
        lines.push(cur.slice(0, k)); cur = cur.slice(k);
      }
    }
    lines.push(cur);
  }
  const perPage = Math.floor((H - 2 * M) / LH);
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  let li = 0, pageNo = 0;
  while (li < lines.length || pageNo === 0) {
    if (pageNo > 0) doc.addPage('a4', 'p');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#111'; ctx.font = font; ctx.textBaseline = 'top';
    for (let r = 0; r < perPage && li < lines.length; r++, li++) {
      if (lines[li] === '\f') { li++; break; }
      ctx.fillText(lines[li], M, M + r * LH);
    }
    doc.addImage(c.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 595.28, 841.89, undefined, 'FAST');
    pageNo++;
    job.progress(li / Math.max(1, lines.length));
  }
  return [{ name: `${baseName(job.file.name)}.pdf`, blob: doc.output('blob') }];
}
async function txtToDocx(job) {
  job.say('Fac documentul…', true);
  const D = await lib.docx();
  const text = await readText(job.file);
  const children = text.split('\n').map((l) => new D.Paragraph({ children: [new D.TextRun({ text: l, size: 22 })] }));
  const doc = new D.Document({ styles: { default: { document: { run: { font: 'Calibri' } } } }, sections: [{ children }] });
  return [{ name: `${baseName(job.file.name)}.docx`, blob: await D.Packer.toBlob(doc) }];
}


/* ---------------- spreadsheets ---------------- */
async function readWorkbook(job) {
  const XLSX = await lib.XLSX();
  const buf = await job.file.arrayBuffer();
  if (job.ext === 'csv') return { XLSX, wb: XLSX.read(await readText(job.file), { type: 'string', raw: false }) };
  return { XLSX, wb: XLSX.read(buf, { type: 'array', cellDates: true }) };
}
async function sheetConvert(job, target) {
  job.say('Convertesc…', true);
  const { XLSX, wb } = await readWorkbook(job);
  if (target === 'xlsx') {
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    return [{ name: `${baseName(job.file.name)}.xlsx`, blob: new Blob([out], { type: MIME.xlsx }) }];
  }
  const outs = wb.SheetNames.map((n) => ({
    name: wb.SheetNames.length > 1 ? `${baseName(job.file.name)}-${n.replace(/[\\/:*?"<>|]/g, '_')}.csv` : `${baseName(job.file.name)}.csv`,
    blob: new Blob(['﻿' + XLSX.utils.sheet_to_csv(wb.Sheets[n])], { type: MIME.csv }),
  }));
  if (outs.length > 1) job.note = 'Câte un CSV pentru fiecare foaie.';
  return outs;
}
async function sheetToPdf(job) {
  job.say('Citesc tabelul…', true);
  const [{ XLSX, wb }, html2canvas, jsPDF] = await Promise.all([readWorkbook(job), lib.html2canvas(), lib.jsPDF()]);
  const PW = 841.89, PH = 595.28, M = 28; // A4 landscape, pt
  let doc = null, pages = 0;
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws['!ref']) continue;
    const host = document.createElement('div');
    host.className = 'render-host sheet-host';
    host.innerHTML = (wb.SheetNames.length > 1 ? `<h3></h3>` : '') + XLSX.utils.sheet_to_html(ws, { editable: false });
    if (wb.SheetNames.length > 1) host.querySelector('h3').textContent = name;
    document.body.appendChild(host);
    try {
      const table = host.querySelector('table');
      if (!table || !table.rows.length) continue;
      job.say(`Randez „${name}”…`, true);
      const canvas = await html2canvas(host, {
        scale: 2, backgroundColor: '#ffffff', logging: false, windowWidth: Math.max(1200, host.scrollWidth + 50),
        onclone: (d) => { for (const h of d.querySelectorAll('.render-host')) h.style.opacity = '1'; },
      });
      const cssW = host.offsetWidth, k = canvas.width / cssW;
      const scale = Math.min(1, (PW - 2 * M) / (cssW * 0.75)); // css px → pt, fit to width
      const pageCss = (PH - 2 * M) / (0.75 * scale);
      const rowBottoms = [...table.rows].map((r) => r.offsetTop + r.offsetHeight + table.offsetTop);
      let y = 0;
      while (y < host.offsetHeight - 1) {
        let end = y + pageCss;
        if (end < host.offsetHeight) {
          const fits = rowBottoms.filter((b) => b > y + 1 && b <= end);
          if (fits.length) end = fits[fits.length - 1];
        } else end = host.offsetHeight;
        const slice = document.createElement('canvas');
        slice.width = canvas.width; slice.height = Math.max(1, Math.round((end - y) * k));
        slice.getContext('2d').drawImage(canvas, 0, Math.round(y * k), canvas.width, slice.height, 0, 0, canvas.width, slice.height);
        if (!doc) doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'l', compress: true });
        else doc.addPage('a4', 'l');
        doc.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', M, M, cssW * 0.75 * scale, (end - y) * 0.75 * scale, undefined, 'FAST');
        pages++; y = end;
        job.progress(Math.min(1, y / host.offsetHeight));
      }
      canvas.width = canvas.height = 0;
    } finally { host.remove(); }
  }
  if (!doc) throw new Error('Fișierul nu are date.');
  job.note = `${pages} ${pages === 1 ? 'pagină' : 'pagini'} A4 landscape. Formatările complexe (grafice, culori condiționale) nu sunt păstrate.`;
  return [{ name: `${baseName(job.file.name)}.pdf`, blob: doc.output('blob') }];
}

/* ---------------- PDF → PowerPoint ---------------- */
async function pdfToPptx(job) {
  const [pdf, PptxGenJS] = await Promise.all([openPdf(job), lib.pptx()]);
  const p1 = await pdf.getPage(1);
  const vp1 = p1.getViewport({ scale: 1 });
  const pptx = new PptxGenJS();
  const W = 13.333, H = W * (vp1.height / vp1.width);
  pptx.defineLayout({ name: 'PDF', width: W, height: H });
  pptx.layout = 'PDF';
  const n = pdf.numPages;
  for (let i = 1; i <= n; i++) {
    job.say(`Slide ${i}/${n}…`); job.progress((i - 1) / n);
    const page = await pdf.getPage(i);
    const c = await renderPdfPage(page, 2);
    const vp = page.getViewport({ scale: 1 });
    const slide = pptx.addSlide();
    // fit page into slide keeping aspect
    const r = Math.min(W / vp.width, H / vp.height);
    const w = vp.width * r, h = vp.height * r;
    slide.addImage({ data: c.toDataURL('image/jpeg', 0.88), x: (W - w) / 2, y: (H - h) / 2, w, h });
    c.width = c.height = 0; page.cleanup();
  }
  pdf.destroy();
  const blob = await pptx.write({ outputType: 'blob' });
  job.note = 'Fiecare pagină e un slide (ca imagine).';
  return [{ name: `${baseName(job.file.name)}.pptx`, blob }];
}

/* ---------------- router ---------------- */
async function convert(job, target) {
  switch (job.kind) {
    case 'image':
      if (job.ext === 'gif' && ['mp4', 'webm'].includes(target)) return mediaConvert(job, target);
      return imageConvert(job, target);
    case 'video': case 'audio': return mediaConvert(job, target);
    case 'pdf':
      switch (target) {
        case 'docx': return pdfToDocx(job);
        case 'txt': return pdfToTxt(job);
        case 'ocr': return pdfSearchable(job);
        case 'small': return pdfCompress(job);
        case 'split': return pdfSplit(job);
        case 'pptx': return pdfToPptx(job);
        case 'merge': return pdfMerge([job], job);
        default: return pdfToImages(job, target);
      }
    case 'docx': return target === 'pdf' ? docxToPdf(job) : docxToTxt(job);
    case 'text': return target === 'pdf' ? txtToPdf(job) : txtToDocx(job);
    case 'sheet': return target === 'pdf' ? sheetToPdf(job) : sheetConvert(job, target);
  }
  throw new Error('Tip de fișier necunoscut');
}

/* ---------------- UI ---------------- */
const jobs = [];
let seq = 0, running = false;
const queueEl = $('#queue');

function addFiles(list) {
  let added = 0, skipped = 0;
  for (const file of list) {
    const { kind, ext } = kindOf(file);
    if (!kind) { skipped++; continue; }
    const job = { id: ++seq, file, kind, ext, target: null, outputs: [], state: 'idle', note: '' };
    const t = targetsFor(job);
    if (DEFAULTS[ext] && t.includes(DEFAULTS[ext])) job.target = DEFAULTS[ext];
    mountJob(job); jobs.push(job); added++;
  }
  if (skipped) toast(`${skipped} fișier(e) cu format necunoscut au fost ignorate.`);
  refreshBulk();
  return added;
}

function mountJob(job) {
  const el = $('#itemTpl').content.firstElementChild.cloneNode(true);
  job.el = el;
  $('.name', el).textContent = job.file.name;
  $('.name', el).title = job.file.name;
  $('.size', el).textContent = `${job.ext.toUpperCase()} · ${fmtSize(job.file.size)}`;
  $('.ext', el).textContent = job.ext.toUpperCase();
  if (job.kind === 'image' && !['heic', 'heif', 'tif', 'tiff'].includes(job.ext)) {
    job.thumbUrl = URL.createObjectURL(job.file);
    const th = $('.thumb', el); th.style.backgroundImage = `url("${job.thumbUrl}")`; th.classList.add('has-img');
  }
  const chips = $('.targets', el);
  for (const t of targetsFor(job)) {
    const b = document.createElement('button');
    b.className = 'chip' + (LABELS[t] ? ' tool' : ''); b.textContent = labelFor(job, t); b.dataset.t = t;
    if (TIPS[t]) b.title = TIPS[t];
    b.addEventListener('click', () => { if (job.state !== 'busy') setTarget(job, t); });
    chips.appendChild(b);
  }
  if (job.kind === 'video' || job.kind === 'audio') {
    const tools = $('.tools', el); tools.hidden = false;
    if (job.kind === 'audio') $('.t-mute-wrap', el).remove();
    $('.tool-toggle', el).addEventListener('click', (e) => {
      const tr = $('.trim', el); tr.hidden = !tr.hidden; e.currentTarget.classList.toggle('on', !tr.hidden);
      if (!tr.hidden && !job.trimReady) setupTrimUI(job);
      if (tr.hidden) $('.pv', el).pause();
    });
    for (const inp of el.querySelectorAll('.trim input')) inp.addEventListener('input', () => { if (job.state === 'done' || job.state === 'fail') resetJob(job); });
  }
  $('.x', el).addEventListener('click', () => removeJob(job));
  job.say = (m, indet = false) => { $('.msg', el).textContent = m; $('.bar i', el).classList.toggle('indet', indet); };
  job.progress = (p) => { const i = $('.bar i', el); i.classList.remove('indet'); i.style.width = Math.round(p * 100) + '%'; };
  setTarget(job, job.target, true);
  queueEl.appendChild(el);
}
function setupTrimUI(job) {
  job.trimReady = true;
  const el = job.el, v = $('.pv', el), wrap = $('.pv-wrap', el), tl = $('.tl', el), a = $('.tl-a', el), b = $('.tl-b', el);
  const sel = $('.tl-sel', el), head = $('.tl-head', el), ts = $('.t-start', el), te = $('.t-end', el);
  if (job.kind === 'audio') { wrap.classList.add('off'); $('.t-loop option[value="boom"]', el)?.remove(); }
  job.pvUrl = URL.createObjectURL(job.file);
  v.controls = true; v.src = job.pvUrl;
  let D = 0;
  const pvOff = () => { wrap.classList.add('off'); $('.set-a', el).hidden = $('.set-b', el).hidden = true; };
  if (job.kind === 'audio') pvOff();
  const round = (t) => Math.round(t * 10) / 10;
  const changed = () => { if (job.state === 'done' || job.state === 'fail') resetJob(job); };
  const paint = () => { const A = +a.value / 10, B = +b.value / 10; sel.style.left = A + '%'; sel.style.width = Math.max(0, B - A) + '%'; };
  const fromInputs = () => {
    if (!D) return;
    const s = parseTime(ts.value), e = parseTime(te.value);
    a.value = Number.isFinite(s) ? Math.round(Math.min(1, s / D) * 1000) : 0;
    b.value = Number.isFinite(e) ? Math.round(Math.min(1, e / D) * 1000) : 1000;
    paint();
  };
  v.addEventListener('loadedmetadata', () => {
    if (!Number.isFinite(v.duration) || !v.duration) return;
    D = v.duration; tl.hidden = false;
    $('.dur', el).textContent = `Durată ${fmtTime(round(D))}`;
    te.placeholder = fmtTime(Math.floor(D));
    if (!v.videoWidth && job.kind === 'video') pvOff(); // codec the browser can't show (e.g. HEVC on some PCs)
    fromInputs();
  });
  v.addEventListener('error', pvOff);
  v.addEventListener('timeupdate', () => {
    if (D) head.style.left = (v.currentTime / D) * 100 + '%';
    const e = parseTime(te.value);
    if (Number.isFinite(e) && !v.paused && v.currentTime >= e) v.pause();
  });
  v.addEventListener('play', () => {
    const s = parseTime(ts.value) || 0, e = parseTime(te.value);
    if (v.currentTime < s - 0.05 || (Number.isFinite(e) && v.currentTime >= e - 0.05)) v.currentTime = s;
  });
  const onRange = (which) => {
    if (+a.value > +b.value - 5) { if (which === 'a') a.value = +b.value - 5; else b.value = +a.value + 5; }
    const s = round((+a.value / 1000) * D), e = round((+b.value / 1000) * D);
    ts.value = +a.value > 0 ? fmtTime(s) : '';
    te.value = +b.value < 1000 ? fmtTime(e) : '';
    paint();
    if (!wrap.classList.contains('off')) { v.pause(); v.currentTime = which === 'a' ? s : e; }
    changed();
  };
  a.addEventListener('input', () => onRange('a'));
  b.addEventListener('input', () => onRange('b'));
  ts.addEventListener('change', fromInputs); te.addEventListener('change', fromInputs);
  $('.set-a', el).onclick = () => { ts.value = fmtTime(round(v.currentTime)); fromInputs(); changed(); };
  $('.set-b', el).onclick = () => { te.value = fmtTime(round(v.currentTime)); fromInputs(); changed(); };
  const loopSel = $('.t-loop', el);
  loopSel.onchange = () => { $('.t-secs-wrap', el).hidden = loopSel.value !== 'until'; changed(); };
}

function setTarget(job, t, silent) {
  job.target = t;
  for (const c of job.el.querySelectorAll('.targets .chip')) c.classList.toggle('on', c.dataset.t === t);
  const tg = $('.target', job.el);
  tg.textContent = t ? labelFor(job, t) : 'alege format';
  tg.classList.toggle('set', !!t);
  if (!silent && (job.state === 'done' || job.state === 'fail')) resetJob(job);
  refreshBulk();
}
function resetJob(job) {
  job.state = 'idle'; job.outputs = []; job.note = '';
  job.el.classList.remove('done', 'fail', 'busy');
  $('.outs', job.el).innerHTML = '';
  refreshBulk();
}
function removeJob(job) {
  const i = jobs.indexOf(job); if (i < 0 || job.state === 'busy') return;
  jobs.splice(i, 1); job.el.remove();
  if (job.thumbUrl) URL.revokeObjectURL(job.thumbUrl);
  if (job.pvUrl) URL.revokeObjectURL(job.pvUrl);
  for (const o of job.outputs) if (o.url) URL.revokeObjectURL(o.url);
  refreshBulk();
}

const ORDER = ['jpg', 'png', 'webp', 'pdf', 'docx', 'pptx', 'xlsx', 'csv', 'txt', 'mp4', 'mov', 'mkv', 'webm', 'avi', 'gif', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'small', 'ocr', 'merge', 'split'];
function refreshBulk() {
  $('#bulk').hidden = jobs.length === 0;
  const union = [];
  for (const j of jobs) for (const t of targetsFor(j)) if (!union.includes(t)) union.push(t);
  union.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const box = $('#bulkChips'); box.innerHTML = '';
  for (const t of union) {
    const b = document.createElement('button');
    b.className = 'chip' + (LABELS[t] ? ' tool' : ''); b.textContent = LABELS[t] || t.toUpperCase();
    if (TIPS[t]) b.title = TIPS[t];
    const applicable = jobs.filter((j) => targetsFor(j).includes(t) && j.state !== 'busy');
    if (applicable.length && applicable.every((j) => j.target === t)) b.classList.add('on');
    b.addEventListener('click', () => { for (const j of applicable) setTarget(j, t); });
    box.appendChild(b);
  }
  const pending = jobs.filter((j) => j.target && j.state !== 'done' && j.state !== 'busy');
  $('#goBtn').disabled = running || pending.length === 0;
  $('#goBtn').textContent = running ? 'Convertesc…' : pending.length > 1 ? `Convertește (${pending.length})` : 'Convertește';
  const outs = jobs.reduce((n, j) => n + j.outputs.length, 0);
  $('#zipBtn').hidden = outs < 2;
}

function showOutputs(job) {
  const box = $('.outs', job.el); box.innerHTML = '';
  const canShare = isIOS || matchMedia('(hover: none)').matches;
  const many = job.outputs.length > 3;
  const list = many ? [] : job.outputs;
  for (const o of list) {
    o.url ??= URL.createObjectURL(o.blob);
    const a = document.createElement('a');
    a.className = 'out'; a.href = o.url; a.download = o.name;
    a.innerHTML = `<span></span><small>${fmtSize(o.blob.size)}</small>`;
    a.firstChild.textContent = job.outputs.length > 1 ? o.name : 'Descarcă';
    box.appendChild(a);
  }
  if (many) {
    const b = document.createElement('button');
    b.className = 'out'; b.innerHTML = `<span>Descarcă ${job.outputs.length} fișiere (.zip)</span>`;
    b.addEventListener('click', () => downloadZip(job.outputs, `${baseName(job.file.name)}.zip`));
    box.appendChild(b);
  }
  if (canShare && navigator.canShare) {
    const files = job.outputs.slice(0, 20).map((o) => new File([o.blob], o.name, { type: o.blob.type || MIME[o.name.split('.').pop()] }));
    if (navigator.canShare({ files })) {
      const s = document.createElement('button');
      s.className = 'out sec'; s.textContent = 'Salvează / Trimite';
      s.addEventListener('click', () => navigator.share({ files }).catch(() => {}));
      box.appendChild(s);
    }
  }
  if (job.note) {
    const n = document.createElement('span'); n.className = 'note'; n.textContent = job.note; box.appendChild(n);
  }
}

async function downloadZip(outputs, name) {
  toast('Fac arhiva…');
  const JSZip = await lib.JSZip();
  const zip = new JSZip();
  const used = new Set();
  for (const o of outputs) {
    let n = o.name, k = 1;
    while (used.has(n)) n = o.name.replace(/(\.[^.]+)$/, `-${++k}$1`);
    used.add(n); zip.file(n, o.blob);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function runOne(job, fn) {
  job.state = 'busy'; job.note = ''; job.outputs = [];
  job.el.classList.remove('done', 'fail'); job.el.classList.add('busy');
  $('.outs', job.el).innerHTML = '';
  job.say('Pregătesc…', true);
  try {
    job.outputs = await fn();
    job.state = 'done';
    job.el.classList.replace('busy', 'done');
    const total = job.outputs.reduce((n, o) => n + o.blob.size, 0);
    job.say(`Gata · ${fmtSize(total)}`);
    showOutputs(job);
  } catch (e) {
    console.error(e);
    job.state = 'fail';
    job.el.classList.replace('busy', 'fail');
    let msg = e?.message || String(e);
    if (/memory|OOM|Aborted|RangeError|Array buffer allocation/i.test(msg)) msg = 'Memorie insuficientă pentru fișierul ăsta în browser. Încearcă pe PC sau un fișier mai mic.';
    job.say(msg);
    if (/crăpat|Memorie/.test(msg)) ff.kill();
  }
}

async function runGroup(group, fn, label) {
  if (group.length < 2) return;
  const [first, ...rest] = group;
  for (const j of rest) { j.state = 'busy'; j.el.classList.add('busy'); j.say(label, true); }
  await runOne(first, () => fn(group, first));
  for (const j of rest) {
    j.el.classList.remove('busy');
    if (first.state === 'done') { j.state = 'done'; j.el.classList.add('done'); j.say('Inclus în ' + first.outputs[0].name); }
    else { j.state = 'idle'; j.say(''); }
  }
}
async function runAll() {
  if (running) return;
  running = true; refreshBulk();
  try {
    const pending = jobs.filter((j) => j.target && j.state !== 'done' && j.state !== 'busy');
    if (opts.mergePdf) await runGroup(pending.filter((j) => j.kind === 'image' && j.target === 'pdf'), imagesToPdf, 'Inclus în PDF-ul comun');
    await runGroup(pending.filter((j) => j.kind === 'pdf' && j.target === 'merge'), pdfMerge, 'Se unește cu primul');
    for (const job of pending) {
      if (job.state === 'done' || job.state === 'busy') continue;
      await runOne(job, () => convert(job, job.target));
      refreshBulk();
    }
  } finally {
    running = false; refreshBulk();
    if (ocrWorker && !jobs.some((j) => j.state === 'busy')) { ocrWorker.terminate().catch(() => {}); ocrWorker = null; }
  }
}

$('#goBtn').addEventListener('click', runAll);
$('#clearBtn').addEventListener('click', () => { for (const j of [...jobs]) removeJob(j); });
$('#zipBtn').addEventListener('click', () => downloadZip(jobs.flatMap((j) => j.outputs), 'convertite.zip'));
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

const drop = $('#drop');
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); dragDepth++; drop.classList.add('over'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('over'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; drop.classList.remove('over');
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});
addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files.map((f, i) => (f.name === 'image.png' ? new File([f], `paste-${Date.now()}-${i}.png`, { type: f.type }) : f)));
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// test hook (used for automated checks; harmless otherwise)
window.__convert = { addFiles, runAll, jobs, setTarget, ff, lib };
