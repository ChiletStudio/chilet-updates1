const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const settings = require('./settings');
const crypto = require('crypto');

// Modpack "de fábrica" que viaja dentro de la app:  <app>/modpack/pack.json  +  <app>/modpack/files/...
// Al abrir el launcher, si la versión del pack cambió, se instalan sus mods/config en la carpeta del modpack.
// Los mundos (saves) y demás datos del jugador NUNCA se tocan.

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const MC = /^\d+\.\d+(\.\d+)?$/;
const FORGE = /^\d+(\.\d+){1,3}$/;
const SERVER = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;

const SHARE = ['mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks', 'icon.png', 'icon.jpg', 'icon.gif', 'icon.webp', 'icon.mp4', 'icon.webm', 'banner.png', 'banner.jpg', 'banner.gif', 'banner.webp', 'banner.mp4', 'banner.webm', 'logo.png', 'logo.jpg', 'logo.gif', 'logo.webp', 'options.txt'];
const KEEP_IF_EXISTS = new Set(['options.txt']); // ajustes del jugador: solo se copian la primera vez

function inside(root, target) {
  return path.resolve(target).startsWith(path.resolve(root) + path.sep);
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

function readPack(dir) {
  const f = path.join(dir, 'pack.json');
  if (!fs.existsSync(f)) return null;
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!ID.test(String(p.id || ''))) throw new Error('pack.json: id inválido.');
  const name = String(p.name || '').trim().slice(0, 40);
  if (!name) throw new Error('pack.json: falta el nombre.');
  if (!MC.test(String(p.mc))) throw new Error('pack.json: versión de Minecraft inválida.');
  const forge = String(p.forge || '');
  if (forge && !FORGE.test(forge)) throw new Error('pack.json: versión de Forge inválida.');
  const server = String(p.server || '');
  if (server && !SERVER.test(server)) throw new Error('pack.json: servidor inválido.');
  return { id: String(p.id), name, mc: String(p.mc), forge, server, version: Number(p.version) || 1 };
}

// Instala/actualiza el pack incluido. Devuelve true si cambió algo.
function sync(dir, log = () => {}) {
  const pack = readPack(dir);
  if (!pack) return false;
  const inst = paths.instance(pack.id);
  const stateFile = path.join(inst, '.chilet-pack.json');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* primera vez */ }
  // Si faltan archivos que debería haber instalado (borrados, antivirus, copia incompleta), se reinstala aunque la versión sea la misma.
  const missing = (st.files || []).filter(rel => !fs.existsSync(path.join(inst, rel)));
  if (st.version === pack.version && !missing.length) { log(`Modpack "${pack.name}" v${pack.version}: al día.`); return false; }
  if (missing.length) log(`Modpack: faltaban ${missing.length} archivos, se reinstalan.`);

  settings.upsertProfile(pack);
  fs.mkdirSync(path.join(inst, 'mods'), { recursive: true });

  // Quita lo que instaló la versión anterior del pack (así no quedan dos versiones del mismo mod).
  for (const rel of st.files || []) {
    const t = path.join(inst, rel);
    if (inside(inst, t)) fs.rmSync(t, { force: true });
  }

  const src = path.join(dir, 'files');
  const installed = [];
  if (fs.existsSync(src)) {
    for (const rel of walk(src)) {
      const dest = path.join(inst, rel);
      if (!inside(inst, dest)) continue;
      if (KEEP_IF_EXISTS.has(rel) && fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(src, rel), dest);
      if (!KEEP_IF_EXISTS.has(rel)) installed.push(rel);
    }
  }
  fs.writeFileSync(stateFile, JSON.stringify({ version: pack.version, files: installed }));
  log(`Modpack "${pack.name}" actualizado a la versión ${pack.version} (${installed.length} archivos).`);
  return true;
}

// Copia el modpack activo (mods, config, menús de FancyMenu...) a <app>/modpack para compartirlo.
function exportPack(dir, profile) {
  const inst = paths.instance(profile.id);
  if (!fs.existsSync(path.join(inst, 'mods'))) throw new Error('Este modpack no tiene carpeta mods todavía.');
  let version = 1;
  try { version = ((readPack(dir) || {}).version || 0) + 1; } catch { /* pack.json dañado: empieza en 1 */ }

  const out = path.join(dir, 'files');
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const included = [];
  for (const item of SHARE) {
    const s = path.join(inst, item);
    if (!fs.existsSync(s)) continue;
    fs.cpSync(s, path.join(out, item), { recursive: true });
    included.push(item);
  }
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    id: profile.id, name: profile.name, mc: profile.mc, forge: profile.forge || '', server: profile.server || '', version
  }, null, 2));
  return { version, included };
}

// Versión de JUGADOR: deja el menú (FancyMenu) y los mods EXACTAMENTE como los repartiste, en cada arranque.
// Repone lo que falte o esté cambiado y quita .jar de más (p. ej. otra versión de FancyMenu descargada a mano, que choca con la tuya).
function verify(dir, log = () => {}) {
  const pack = readPack(dir);
  const src = path.join(dir, 'files');
  if (!pack || !fs.existsSync(src)) return 0;
  const inst = paths.instance(pack.id);
  const sha = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
  const shipped = walk(src, src).map(r => r.split(path.sep).join('/'));
  const guarded = r => r.startsWith('mods/') || r.startsWith('config/fancymenu/customization/') || r.startsWith('config/fancymenu/assets/');
  let fixed = 0;
  for (const rel of shipped.filter(guarded)) {
    const a = path.join(src, rel), b = path.join(inst, rel);
    let same = false;
    try { same = fs.statSync(a).size === fs.statSync(b).size && (rel.endsWith('.jar') || sha(a) === sha(b)); } catch { /* falta */ }
    if (same) continue;
    fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b); fixed++;
    log(`[modpack] repuesto: ${rel}`);
  }
  const mine = new Set(shipped.filter(r => r.startsWith('mods/')).map(r => r.slice(5)));
  const md = path.join(inst, 'mods');
  for (const f of fs.existsSync(md) ? fs.readdirSync(md) : []) {
    if (f.toLowerCase().endsWith('.jar') && !mine.has(f)) { fs.rmSync(path.join(md, f), { force: true }); fixed++; log(`[modpack] quitado mod de más: ${f}`); }
  }
  return fixed;
}
module.exports = { verify, sync, exportPack };
