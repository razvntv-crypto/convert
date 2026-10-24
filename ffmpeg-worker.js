// Same-origin module worker that loads the ffmpeg.wasm core from the CDN.
// (A worker must be same-origin; the core itself can be imported cross-origin.)
let core = null;

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    let result;
    if (type === 'load') {
      if (!core) {
        const mod = await import(data.coreURL);
        const create = mod.default;
        const hash = btoa(JSON.stringify({ wasmURL: data.wasmURL }));
        core = await create({ mainScriptUrlOrBlob: `${data.coreURL}#${hash}` });
        core.setLogger((e) => self.postMessage({ type: 'log', message: e.message }));
        core.setProgress((e) => self.postMessage({ type: 'progress', progress: e.progress, time: e.time }));
      }
      result = true;
    } else if (type === 'exec') {
      core.setTimeout(-1);
      core.exec(...data.args);
      result = core.ret;
      core.reset();
    } else if (type === 'write') {
      core.FS.writeFile(data.path, data.bytes);
      result = true;
    } else if (type === 'read') {
      const bytes = core.FS.readFile(data.path);
      self.postMessage({ id, ok: true, result: bytes }, [bytes.buffer]);
      return;
    } else if (type === 'unlink') {
      try { core.FS.unlink(data.path); } catch {}
      result = true;
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
