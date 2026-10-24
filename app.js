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
  s.src = src; s.onload = res; s.onerror = () => rej(new Error('Nu s-a putut încărca ' + src.split('/').slice(-1)[0] + ' (ești offline?)'));
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
  docx: () => once('docx', () => imp(CDN + 'docx@9/+esm')),
  docxPreview: () => once('docxPreview', () => imp(CDN + 'docx-preview@0.3/+esm')),
  html2canvas: () => once('h2c', async () => (await imp(CDN + 'html2canvas@1.4.1/+esm')).default),
  mammoth: () => once('mammoth', async () => { await loadScript(CDN + 'mammoth@1/mammoth.browser.min.js'); return window.mammoth; }),
  heic2any: () => once('heic', async () => { await loadScript(CDN + 'heic2any@0.0.4/dist/heic2any.min.js'); return window.heic2any; }),
  JSZip: () => once('jszip', async () => (await imp(CDN + 'jszip@3.10.1/+esm')).default),
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
    const v = /Stream #[^\n]*?: Video: (\w+)/.exec(all);
    const a = /Stream #[^\n]*?: Audio: (\w+)/.exec(all);
    return { duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0, v: v?.[1] || null, a: a?.[1] || null, logs: all };
  }
}
const ff = new FF();

/* ---------------- formats ---------------- */
const EXT = {
  image: ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'svg', 'tif', 'tiff', 'ico'],
  video: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'ogv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff', 'aif', 'amr'],
  pdf: ['pdf'],
  docx: ['docx', 'doc', 'odt', 'rtf'],
  text: ['txt', 'md', 'csv', 'log'],
};
const TARGETS = {
  image: ['jpg', 'png', 'webp', 'pdf'],
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'gif', 'mp3', 'wav', 'm4a'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac'],
  pdf: ['docx', 'jpg', 'png', 'txt'],
  docx: ['pdf', 'txt'],
  text: ['pdf', 'docx'],
};
const DEFAULTS = {
  heic: 'jpg', heif: 'jpg', webp: 'jpg', avif: 'jpg', png: 'jpg', jpg: 'png', jpeg: 'png', jfif: 'jpg', bmp: 'png', tif: 'jpg', tiff: 'jpg', svg: 'png',
  mov: 'mp4', mkv: 'mp4', avi: 'mp4', wmv: 'mp4', flv: 'mp4', '3gp': 'mp4', m4v: 'mp4', webm: 'mp4', mpg: 'mp4', mpeg: 'mp4', ts: 'mp4', mts: 'mp4', m2ts: 'mp4', ogv: 'mp4',
  wav: 'mp3', flac: 'mp3', m4a: 'mp3', aac: 'mp3', ogg: 'mp3', oga: 'mp3', opus: 'mp3', wma: 'mp3', aiff: 'mp3', aif: 'mp3', amr: 'mp3',
  pdf: 'docx', docx: 'pdf', txt: 'pdf', md: 'pdf',
};
const MIME = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain;charset=utf-8', zip: 'application/zip',
};
function kindOf(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  for (const [k, list] of Object.entries(EXT)) if (list.includes(ext)) return { kind: k, ext };
  const t = file.type || '';
  if (t.startsWith('image/')) return { kind: 'image', ext: t.split('/')[1] };
  if (t.startsWith('video/')) return { kind: 'video', ext: t.split('/')[1] };
  if (t.startsWith('audio/')) return { kind: 'audio', ext: t.split('/')[1] };
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
  quality: 90, videoQ: '23', dpi: '2.5', gifW: '480', gifFps: '15', forceH264: false, mergePdf: true,
};
try { Object.assign(opts, JSON.parse(localStorage.getItem('convert.opts') || '{}')); } catch {}
const optEls = {
  quality: $('#optQuality'), videoQ: $('#optVideoQ'), dpi: $('#optDpi'), gifW: $('#optGifW'), gifFps: $('#optGifFps'),
  forceH264: $('#optForceH264'), mergePdf: $('#optMergePdf'),
};
for (const [k, el] of Object.entries(optEls)) {
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
      let w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
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
  const png = await ffmpegRun(file, ext, 'png', ['-frames:v', '1'], job, false);
  const bmp = await createImageBitmap(png);
  return { src: bmp, w: bmp.width, h: bmp.height, cleanup: () => bmp.close() };
}
function drawToCanvas(img, bg) {
  let { w, h } = img;
  let scaled = false;
  if (w * h > MAX_PIXELS) { const s = Math.sqrt(MAX_PIXELS / (w * h)); w = Math.floor(w * s); h = Math.floor(h * s); scaled = true; }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img.src, 0, 0, w, h);
  return { canvas: c, scaled };
}
async function encodeCanvas(canvas, target) {
  const q = opts.quality / 100;
  if (target === 'png') return canvasToBlob(canvas, 'image/png');
  if (target === 'jpg') return canvasToBlob(canvas, 'image/jpeg', q);
  if (target === 'webp') {
    const b = await canvasToBlob(canvas, 'image/webp', q);
    if (b && b.type === 'image/webp') return b;
    // Safari can't encode WebP from canvas → ffmpeg
    const png = await canvasToBlob(canvas, 'image/png');
    return ffmpegRun(png, 'png', 'webp', ['-c:v', 'libwebp', '-quality', String(opts.quality)], null, false);
  }
  throw new Error('format necunoscut');
}
async function imageConvert(job, target) {
  if (target === 'pdf') return imagesToPdf([job], job);
  job.say('Convertesc…', true);
  const img = await decodeImage(job.file, job.ext, job);
  try {
    const { canvas, scaled } = drawToCanvas(img, target === 'jpg' ? '#ffffff' : null);
    const blob = await encodeCanvas(canvas, target);
    if (scaled) job.note = 'Poza era prea mare pentru iPhone, am micșorat-o.';
    return [{ name: `${baseName(job.file.name)}.${target}`, blob }];
  } finally { img.cleanup?.(); }
}
async function imagesToPdf(jobs, statusJob) {
  const jsPDF = await lib.jsPDF();
  let doc = null;
  let i = 0;
  for (const j of jobs) {
    statusJob.say(jobs.length > 1 ? `Pagina ${++i}/${jobs.length}…` : 'Fac PDF-ul…', true);
    const img = await decodeImage(j.file, j.ext, statusJob);
    try {
      const { canvas } = drawToCanvas(img, '#ffffff');
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
async function ffmpegRun(input, inExt, outExt, args, job, withProgress = true) {
  if (!ff.ready) job?.say('Pornesc motorul video (prima dată ~30 MB)…', true);
  await ff.load();
  const inName = `in.${inExt || 'bin'}`, outName = `out.${outExt}`;
  await ff.write(inName, new Uint8Array(await input.arrayBuffer()));
  try {
    const info = withProgress ? await ff.probe(inName) : { duration: 0 };
    const { ret, logs } = await ff.exec(['-hide_banner', '-y', '-i', inName, ...args, outName], {
      duration: info.duration, onProgress: (p) => job?.progress(p),
    });
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
  if (!ff.ready) job.say('Pornesc motorul video (prima dată ~30 MB)…', true);
  await ff.load();
  const inName = `in.${job.ext}`, outName = `out.${target}`;
  job.say('Citesc fișierul…', true);
  await ff.write(inName, new Uint8Array(await job.file.arrayBuffer()));
  try {
    const info = await ff.probe(inName);
    const plans = buildPlans(info, target, job);
    let lastLogs = [];
    for (const plan of plans) {
      job.say(plan.label, !info.duration);
      job.progress(0);
      const { ret, logs } = await ff.exec(['-hide_banner', '-y', '-i', inName, ...plan.args, outName], {
        duration: info.duration, onProgress: (p) => job.progress(p),
      });
      lastLogs = logs;
      if (ret === 0) {
        const data = await ff.read(outName);
        if (data.byteLength > 0) {
          if (plan.note) job.note = plan.note;
          return [{ name: `${baseName(job.file.name)}.${target}`, blob: new Blob([data], { type: MIME[target] }) }];
        }
      }
      await ff.unlink(outName).catch(() => {});
    }
    throw new Error(lastError(lastLogs));
  } finally {
    await ff.unlink(inName).catch(() => {}); await ff.unlink(outName).catch(() => {});
  }
}
function buildPlans(info, target, job) {
  const crf = String(opts.videoQ);
  const even = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const x264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf, '-pix_fmt', 'yuv420p', '-vf', even];
  const aac = ['-c:a', 'aac', '-b:a', '160k'];
  const mapVA = ['-map', '0:v:0', '-map', '0:a:0?'];
  const needAudio = () => { if (!info.a) throw new Error('Fișierul nu are pistă audio.'); };
  const needVideo = () => { if (!info.v) throw new Error('Fișierul nu are pistă video.'); };
  const enc = { label: 'Re-encodez video (durează)…', args: [] };
  switch (target) {
    case 'mp4': case 'mov': {
      needVideo();
      const aOk = !info.a || ['aac', 'mp3', 'alac'].includes(info.a);
      const vOk = info.v === 'h264' || (info.v === 'hevc' && !opts.forceH264);
      const fast = target === 'mp4' ? ['-movflags', '+faststart'] : [];
      const encode = { ...enc, args: [...mapVA, ...x264, ...aac, ...fast] };
      if (vOk) {
        const copy = { label: 'Schimb containerul (rapid, fără pierderi)…', args: [...mapVA, '-c', 'copy', ...(info.v === 'hevc' ? ['-tag:v', 'hvc1'] : []), ...fast] };
        if (!aOk) copy.args = [...mapVA, '-c:v', 'copy', ...(info.v === 'hevc' ? ['-tag:v', 'hvc1'] : []), ...aac, ...fast];
        if (info.v === 'hevc') copy.note = 'Video-ul e HEVC (H.265), l-am păstrat așa. Dacă nu merge pe un PC vechi, bifează „forțează H.264” în setări.';
        return [copy, encode];
      }
      return [encode];
    }
    case 'mkv':
      needVideo();
      return [
        { label: 'Schimb containerul (rapid)…', args: ['-map', '0', '-c', 'copy'] },
        { ...enc, args: [...mapVA, ...x264, ...aac] },
      ];
    case 'webm': {
      needVideo();
      const br = { 20: '4M', 23: '2500k', 28: '1200k' }[crf] || '2500k';
      return [{ label: 'Encodez WebM (durează)…', args: [...mapVA, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', br, '-crf', '10', '-vf', even, '-c:a', 'libvorbis', '-q:a', '5'] }];
    }
    case 'avi':
      needVideo();
      return [{ label: 'Encodez AVI…', args: [...mapVA, '-c:v', 'mpeg4', '-q:v', crf === '20' ? '2' : crf === '28' ? '6' : '4', '-vf', even, '-c:a', 'libmp3lame', '-q:a', '4'] }];
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

/* ---------------- PDF pipelines ---------------- */
async function openPdf(job) {
  const pdfjs = await lib.pdfjs();
  const data = new Uint8Array(await job.file.arrayBuffer());
  try { return await pdfjs.getDocument({ data, isEvalSupported: false }).promise; }
  catch (e) { if (/password/i.test(e.name + e.message)) throw new Error('PDF-ul are parolă.'); throw e; }
}
async function renderPdfPage(page, scale) {
  const vp = page.getViewport({ scale });
  let w = Math.floor(vp.width), h = Math.floor(vp.height);
  if (w * h > MAX_PIXELS) { const s = Math.sqrt(MAX_PIXELS / (w * h)); return renderPdfPage(page, scale * s); }
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
async function pdfToDocx(job) {
  const pdf = await openPdf(job);
  const D = await lib.docx();
  const pages = [];
  const sizes = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    job.say(`Citesc pagina ${i}/${pdf.numPages}…`); job.progress((i - 1) / pdf.numPages);
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const paras = linesToParas(pageLines(tc.items, tc.styles));
    paras.forEach((p) => sizes.push(p.size));
    let image = null;
    if (!paras.length) {
      const c = await renderPdfPage(page, 2);
      image = { data: new Uint8Array(await (await canvasToBlob(c, 'image/jpeg', 0.85)).arrayBuffer()), w: c.width, h: c.height };
      c.width = c.height = 0;
    }
    pages.push({ paras, image });
    page.cleanup();
  }
  pdf.destroy();
  sizes.sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 11;
  const children = [];
  let scanned = 0;
  pages.forEach((pg, idx) => {
    if (idx > 0) children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
    if (pg.image) {
      scanned++;
      const w = 600, h = Math.round((pg.image.h / pg.image.w) * w);
      children.push(new D.Paragraph({ children: [new D.ImageRun({ type: 'jpg', data: pg.image.data, transformation: { width: w, height: Math.min(h, 860) } })] }));
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
  if (scanned === pages.length) job.note = 'PDF scanat (fără text) — am pus paginile ca imagini în Word.';
  else if (scanned) job.note = `${scanned} pagini fără text au fost puse ca imagini.`;
  return [{ name: `${baseName(job.file.name)}.docx`, blob }];
}
async function pdfToTxt(job) {
  const pdf = await openPdf(job);
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    job.say(`Pagina ${i}/${pdf.numPages}…`); job.progress((i - 1) / pdf.numPages);
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    parts.push(linesToParas(pageLines(tc.items, tc.styles)).map((p) => p.text).join('\n\n'));
    page.cleanup();
  }
  pdf.destroy();
  const text = parts.join('\n\n\f\n\n');
  if (!text.replace(/\s/g, '')) throw new Error('PDF-ul nu conține text (e scanat). Încearcă PDF → JPG.');
  return [{ name: `${baseName(job.file.name)}.txt`, blob: new Blob([text], { type: MIME.txt }) }];
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
    job.note = 'Aspect fidel, dar textul din PDF e imagine (nu se poate selecta).';
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

/* ---------------- router ---------------- */
async function convert(job, target) {
  switch (job.kind) {
    case 'image':
      if (job.ext === 'gif' && ['mp4', 'webm'].includes(target)) return mediaConvert(job, target);
      return imageConvert(job, target);
    case 'video': case 'audio': return mediaConvert(job, target);
    case 'pdf': return target === 'docx' ? pdfToDocx(job) : target === 'txt' ? pdfToTxt(job) : pdfToImages(job, target);
    case 'docx': return target === 'pdf' ? docxToPdf(job) : docxToTxt(job);
    case 'text': return target === 'pdf' ? txtToPdf(job) : txtToDocx(job);
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
    b.className = 'chip'; b.textContent = t.toUpperCase(); b.dataset.t = t;
    b.addEventListener('click', () => { if (job.state !== 'busy') setTarget(job, t); });
    chips.appendChild(b);
  }
  $('.x', el).addEventListener('click', () => removeJob(job));
  job.say = (m, indet = false) => { $('.msg', el).textContent = m; $('.bar i', el).classList.toggle('indet', indet); };
  job.progress = (p) => { const i = $('.bar i', el); i.classList.remove('indet'); i.style.width = Math.round(p * 100) + '%'; };
  setTarget(job, job.target, true);
  queueEl.appendChild(el);
}

function setTarget(job, t, silent) {
  job.target = t;
  for (const c of job.el.querySelectorAll('.targets .chip')) c.classList.toggle('on', c.dataset.t === t);
  const tg = $('.target', job.el);
  tg.textContent = t ? t.toUpperCase() : 'alege format';
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
  for (const o of job.outputs) if (o.url) URL.revokeObjectURL(o.url);
  refreshBulk();
}

function refreshBulk() {
  $('#bulk').hidden = jobs.length === 0;
  const union = [];
  for (const j of jobs) for (const t of targetsFor(j)) if (!union.includes(t)) union.push(t);
  const order = ['jpg', 'png', 'webp', 'pdf', 'docx', 'txt', 'mp4', 'mov', 'mkv', 'webm', 'avi', 'gif', 'mp3', 'wav', 'm4a', 'ogg', 'flac'];
  union.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const box = $('#bulkChips'); box.innerHTML = '';
  for (const t of union) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = t.toUpperCase();
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

async function runAll() {
  if (running) return;
  running = true; refreshBulk();
  try {
    const pending = jobs.filter((j) => j.target && j.state !== 'done' && j.state !== 'busy');
    const pdfImgs = pending.filter((j) => j.kind === 'image' && j.target === 'pdf');
    if (opts.mergePdf && pdfImgs.length > 1) {
      const [first, ...rest] = pdfImgs;
      for (const j of rest) { j.state = 'busy'; j.el.classList.add('busy'); j.say('Inclus în PDF-ul comun', true); }
      await runOne(first, () => imagesToPdf(pdfImgs, first));
      for (const j of rest) {
        j.el.classList.remove('busy');
        if (first.state === 'done') { j.state = 'done'; j.el.classList.add('done'); j.say('Inclus în ' + first.outputs[0].name); }
        else { j.state = 'idle'; j.say(''); }
      }
    }
    for (const job of pending) {
      if (job.state === 'done' || job.state === 'busy') continue;
      await runOne(job, () => convert(job, job.target));
      refreshBulk();
    }
  } finally { running = false; refreshBulk(); }
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
  if (files.length) { addFiles(files.map((f, i) => f.name === 'image.png' ? new File([f], `paste-${Date.now()}-${i}.png`, { type: f.type }) : f)); }
});

// warm the ffmpeg core in the background when a media file is queued (saves time on first convert)
// (not done automatically to avoid 30 MB downloads on mobile data)

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// test hook (used for automated checks; harmless otherwise)
window.__convert = { addFiles, runAll, jobs, setTarget, ff };
