// Parte PURA (sin Electron) de las actualizaciones del launcher: rutas permitidas, hashes, firma y comprobación de lo ya descargado.
// La usan boot.js (al arrancar), appupdate.js (descargar) y el creador (firmar). Ed25519 viene incluido en Node: sin dependencias.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Solo se actualiza el CÓDIGO del launcher. Nunca boot.js, node_modules, Electron, owner.json ni player.flag.
const REL = /^(?:main\.js|preload\.js|src\/[A-Za-z0-9_.-]+\.js|renderer\/[A-Za-z0-9_.@\/-]+\.(?:js|html|css|png|jpe?g|gif|webp|svg|mp4|webm|json|txt|woff2?|ttf|ico))$/;
const okRel = p => typeof p === 'string' && REL.test(p) && !p.includes('..') && !p.includes('//');
const MAX_FILE = 60 * 1024 * 1024;
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const canon = a => JSON.stringify({ v: a.v, shell: a.shell, files: a.files.map(f => [f.p, f.sha256, f.size]) });
const sign = (a, privateKey) => crypto.sign(null, Buffer.from(canon(a)), privateKey).toString('base64');
function verify(a, pubPem) {
  try { return crypto.verify(null, Buffer.from(canon(a)), crypto.createPublicKey(pubPem), Buffer.from(String(a.sig), 'base64')); } catch { return false; }
}
function validShape(a) {
  return !!a && Number.isInteger(a.v) && a.v > 0 && Number.isInteger(a.shell) && Array.isArray(a.files) && a.files.length > 0 && a.files.length < 2000 &&
    a.files.every(f => f && okRel(f.p) && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isInteger(f.size) && f.size >= 0 && f.size <= MAX_FILE) &&
    new Set(a.files.map(f => f.p)).size === a.files.length && a.files.some(f => f.p === 'main.js') && a.files.some(f => f.p === 'renderer/index.html');
}
const rel2abs = (dir, p) => path.join(dir, ...p.split('/'));

function walk(dir, base, out = []) {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
// Archivos de código del launcher que viajan en una actualización.
function collect(appDir) {
  const rels = ['main.js', 'preload.js', ...walk(path.join(appDir, 'src'), appDir), ...walk(path.join(appDir, 'renderer'), appDir)].filter(okRel);
  return rels.filter(p => fs.existsSync(rel2abs(appDir, p))).sort().map(p => {
    const abs = rel2abs(appDir, p), buf = fs.readFileSync(abs);
    return { p, abs, size: buf.length, sha256: sha256(buf) };
  }).filter(f => f.size <= MAX_FILE);
}

// ¿Esta carpeta descargada está completa, es la firmada y no la tocó nadie?
function dirOk(dir, pubPem, shell) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (!validShape(a) || !verify(a, pubPem) || a.shell > shell) return null;
    for (const f of a.files) {
      const b = fs.readFileSync(rel2abs(dir, f.p));
      if (b.length !== f.size || sha256(b) !== f.sha256) return null;
    }
    return a;
  } catch { return null; }
}

// ----- estado en disco (carpeta app-code dentro de los datos del usuario) -----
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const files = root => ({ cur: path.join(root, 'current.json'), bad: path.join(root, 'bad.json'), pending: path.join(root, 'pending.json') });
const badList = root => readJson(files(root).bad, { list: [] }).list || [];
function markBad(root, v) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(files(root).bad, JSON.stringify({ list: [...new Set([...badList(root), v])].slice(-20) }));
  fs.rmSync(files(root).cur, { force: true }); fs.rmSync(files(root).pending, { force: true });
}
const current = root => { const c = readJson(files(root).cur, null); return c && Number.isInteger(c.v) ? c : null; };

// Decide al arrancar qué código usar. Devuelve { v, dir, main } si hay una actualización buena, o null (se usa lo instalado).
function pickHot({ root, appDir, shell }) {
  const f = files(root), c = current(root);
  if (!c) { fs.rmSync(f.pending, { force: true }); return null; }
  if (fs.existsSync(f.pending)) { markBad(root, c.v); return null; }          // el arranque anterior con esta versión no llegó a terminar: se descarta
  if (badList(root).includes(c.v)) { fs.rmSync(f.cur, { force: true }); return null; }
  const pubFile = path.join(appDir, 'update-key.pub');
  if (!fs.existsSync(pubFile)) return null;
  const dir = path.join(root, String(c.v));
  if (!dirOk(dir, fs.readFileSync(pubFile, 'utf8'), shell)) { markBad(root, c.v); return null; }
  fs.writeFileSync(f.pending, JSON.stringify({ v: c.v, t: Date.now() }));
  return { v: c.v, dir, main: path.join(dir, 'main.js') };
}

module.exports = { okRel, sha256, canon, sign, verify, validShape, rel2abs, collect, dirOk, files, markBad, badList, current, pickHot, readJson };
