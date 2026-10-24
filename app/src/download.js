const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// Descarga url -> dest con progreso. onProgress(hechos, total) (total puede ser 0 si se desconoce).
async function download(url, dest, onProgress) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Descarga fallida (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const tmp = dest + '.part';
  const src = Readable.fromWeb(res.body);
  src.on('data', chunk => { done += chunk.length; if (onProgress) onProgress(done, total); });
  await pipeline(src, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

module.exports = { download };
