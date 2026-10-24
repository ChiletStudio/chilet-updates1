// Actualizaciones del PROPIO launcher (código de la app) sin reinstalar.
//  · CREADOR: al publicar, firma el código con una clave que solo existe en su PC y lo sube junto al modpack.
//  · JUGADOR: al abrir (y cada 30 min) mira si hay código nuevo; solo lo aplica si la firma es del creador (clave pública dentro de la app).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const core = require('./updcore');

const ud = () => app.getPath('userData');
const root = () => path.join(ud(), 'app-code');
const keyFile = () => path.join(ud(), 'update-key.json');
const pubFile = () => path.join(ud(), 'update-key.pub');

// ---------- CREADOR: clave de firma (la privada queda cifrada con el sistema; la pública se copia dentro del instalador de jugadores) ----------
function ensureKeys() {
  try {
    if (fs.existsSync(keyFile()) && fs.existsSync(pubFile())) return true;
    if (!safeStorage.isEncryptionAvailable()) return false;
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(ud(), { recursive: true });
    fs.writeFileSync(keyFile(), safeStorage.encryptString(privateKey.export({ type: 'pkcs8', format: 'pem' })));
    fs.writeFileSync(pubFile(), publicKey.export({ type: 'spki', format: 'pem' }));
    return true;
  } catch { return false; }
}
const privateKey = () => crypto.createPrivateKey(safeStorage.decryptString(fs.readFileSync(keyFile())));

// Prepara lo que se publica. Si el código no cambió desde la última vez, repite la MISMA versión: así publicar solo el modpack no reinicia a nadie.
function buildBundle(appDir, shell) {
  if (!ensureKeys()) throw new Error('No se pudo crear la clave de firma (el sistema no ofrece cifrado).');
  const fl = core.collect(appDir);
  const body = { shell, files: fl.map(({ p, size, sha256 }) => ({ p, size, sha256 })) };
  const lastFile = path.join(ud(), 'app-publish.json'), last = core.readJson(lastFile, null);
  const same = last && last.shell === shell && JSON.stringify(last.files) === JSON.stringify(body.files);
  const a = { v: same ? last.v : Math.floor(Date.now() / 1000), ...body };
  if (!core.validShape(a)) throw new Error('El código del launcher no tiene el formato esperado (falta main.js o renderer/index.html).');
  a.sig = core.sign(a, privateKey());
  fs.writeFileSync(lastFile, JSON.stringify({ v: a.v, shell, files: body.files }));
  return { a, files: fl, changed: !same };
}

// ---------- JUGADOR ----------
// Devuelve { updated, v } | { upToDate } | { needInstaller } | { off } | { none } | { bad }. `fetchFn` se puede cambiar para probar.
async function check({ url, appDir, shell, log = () => {}, fetchFn = fetch, onStage = () => {} }) {
  const pubPath = path.join(appDir, 'update-key.pub');
  if (!fs.existsSync(pubPath)) return { off: 'este instalador no trae la clave de actualizaciones' };
  const pub = fs.readFileSync(pubPath, 'utf8');
  const res = await fetchFn(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { signal: AbortSignal.timeout(10000), cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const m = await res.json(), a = m && m.app;
  if (!a) return { none: true };
  if (!core.validShape(a)) return { bad: 'lista de archivos no válida' };
  if (!core.verify(a, pub)) return { bad: 'la firma no es del creador' };
  const have = (core.current(root()) || {}).v || 0;
  if (a.v <= have) return { upToDate: true, v: have };
  if (core.badList(root()).includes(a.v)) return { bad: 'esa versión ya falló en este PC' };
  if (a.shell > shell) return { needInstaller: true };

  const dir = path.join(root(), String(a.v)), tmp = dir + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  const sources = [have ? path.join(root(), String(have)) : null, appDir].filter(Boolean);   // lo que no cambió se copia de lo que ya hay
  let downloaded = 0;
  let n = 0;
  for (const f of a.files) {
    onStage(`Launcher: ${++n} de ${a.files.length} archivos`, (n / a.files.length) * 100);
    let buf = null;
    for (const s of sources) { try { const b = fs.readFileSync(core.rel2abs(s, f.p)); if (b.length === f.size && core.sha256(b) === f.sha256) { buf = b; break; } } catch { /* no está */ } }
    if (!buf) {
      const r = await fetchFn(new URL('app/' + f.p.split('/').map(encodeURIComponent).join('/'), url).toString() + '?t=' + a.v, { signal: AbortSignal.timeout(60000), cache: 'no-store' });
      if (!r.ok) throw new Error(`No se pudo bajar ${f.p} (HTTP ${r.status}).`);
      buf = Buffer.from(await r.arrayBuffer());
      if (buf.length !== f.size || core.sha256(buf) !== f.sha256) throw new Error(`${f.p} no coincide con lo firmado.`);
      downloaded++;
    }
    const dest = core.rel2abs(tmp, f.p); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf);
  }
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(a));
  if (!core.dirOk(tmp, pub, shell)) throw new Error('La actualización descargada no pasó la comprobación.');
  fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(tmp, dir);
  fs.writeFileSync(path.join(root(), 'current.json'), JSON.stringify({ v: a.v, prev: have }));
  for (const d of fs.readdirSync(root())) if (/^\d+(\.tmp)?$/.test(d) && d !== String(a.v) && d !== String(have)) fs.rmSync(path.join(root(), d), { recursive: true, force: true });
  log(`[launcher] actualización ${a.v} lista (${downloaded} archivo(s) descargados).`);
  return { updated: true, v: a.v };
}

// Vuelve al código instalado (borra lo descargado).
function restoreOriginal() { fs.rmSync(root(), { recursive: true, force: true }); }

module.exports = { ensureKeys, buildBundle, check, restoreOriginal, root };
