// Lee nombre, autor, versión e icono de un mod (.jar) sin dependencias: solo el directorio central del zip.
const fs = require('fs');
const zlib = require('zlib');
const cache = new Map();

function entries(fd, size) {
  const n = Math.min(size, 65557), buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, size - n);
  let i = n - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) return new Map();
  const count = buf.readUInt16LE(i + 10), cdSize = buf.readUInt32LE(i + 12), cdOff = buf.readUInt32LE(i + 16);
  const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
  const map = new Map(); let p = 0;
  for (let k = 0; k < count && p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; k++) {
    const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    map.set(cd.toString('utf8', p + 46, p + 46 + nl), { method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20), off: cd.readUInt32LE(p + 42) });
    p += 46 + nl + el + cl;
  }
  return map;
}
function read(fd, e, max = 400000) {
  if (!e || e.csize > max) return null;
  const h = Buffer.alloc(30); fs.readSync(fd, h, 0, 30, e.off);
  const data = Buffer.alloc(e.csize); fs.readSync(fd, data, 0, e.csize, e.off + 30 + h.readUInt16LE(26) + h.readUInt16LE(28));
  return e.method === 0 ? data : e.method === 8 ? zlib.inflateRawSync(data) : null;
}
const toml = (t, k) => { const m = t.match(new RegExp('^\\s*' + k + '\\s*=\\s*(?:"([^"]*)"|\'\'\'([^\']*)\'\'\')', 'm')); return m ? (m[1] ?? m[2]).trim() : ''; };

function info(file, size, mtime) {
  const key = file + size + mtime;
  if (cache.has(key)) return cache.get(key);
  const base = file.split(/[\\/]/).pop().replace(/\.jar$/i, '');
  const out = { name: base, author: '', version: (base.match(/[-_+](\d[\w.+-]*)$/) || [])[1] || '', icon: null };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const ents = entries(fd, size);
    let logo = '';
    const t = read(fd, ents.get('META-INF/mods.toml'));
    const f = read(fd, ents.get('fabric.mod.json'));
    if (t) {
      const s = t.toString('utf8');
      out.name = toml(s, 'displayName') || out.name; out.author = toml(s, 'authors'); logo = toml(s, 'logoFile');
      const v = toml(s, 'version');
      if (v && !v.includes('${')) out.version = v;
      else { const mf = read(fd, ents.get('META-INF/MANIFEST.MF')); const m = mf && mf.toString('utf8').match(/Implementation-Version:\s*(\S+)/); if (m) out.version = m[1]; }
    } else if (f) {
      const j = JSON.parse(f.toString('utf8'));
      out.name = j.name || out.name; out.version = j.version || out.version;
      const a = (j.authors || [])[0]; out.author = typeof a === 'string' ? a : (a && a.name) || '';
      logo = typeof j.icon === 'string' ? j.icon : '';
    }
    if (logo) {
      const img = read(fd, ents.get(logo.replace(/^\/+/, '')), 300000);
      if (img) out.icon = 'data:image/png;base64,' + img.toString('base64');
    }
  } catch { /* se queda con lo básico (nombre del archivo) */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  cache.set(key, out);
  return out;
}
module.exports = { info };
