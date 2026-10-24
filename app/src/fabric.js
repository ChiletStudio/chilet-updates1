// Fabric dentro del launcher: baja el perfil oficial de meta.fabricmc.net y sus librerías, sin instaladores aparte.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

const META = 'https://meta.fabricmc.net/v2/versions/loader';
const HEAD = { 'User-Agent': 'ChiletStudio/1.3 (launcher)' };
const LIB = /^[\w.-]+:[\w.-]+:[\w.+-]+(:[\w.-]+)?$/;

async function jget(u) {
  const r = await fetch(u, { headers: HEAD, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Fabric: ${u.replace(META, '…')} respondió ${r.status}`);
  return r.json();
}
// Última versión ESTABLE del cargador de Fabric para esa versión de Minecraft.
async function latestLoader(mc) {
  const list = await jget(`${META}/${encodeURIComponent(mc)}`);
  const pick = list.find(x => x.loader && x.loader.stable) || list[0];
  if (!pick) throw new Error(`Fabric todavía no tiene soporte para Minecraft ${mc}.`);
  return pick.loader.version;
}
const versionId = (mc, fv) => `fabric-loader-${fv}-${mc}`;
const libPath = name => { const [g, a, v, c] = name.split(':'); return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${c ? '-' + c : ''}.jar`; };

// Deja listo versions/<id>/<id>.json y todas sus librerías en libraries/. Devuelve el id para usarlo como versión "custom".
async function ensure(mc, fv, log = () => {}) {
  if (!/^[\w.+-]{1,30}$/.test(fv)) throw new Error('Versión de Fabric no válida.');
  const id = versionId(mc, fv), dir = path.join(paths.root(), 'versions', id), jf = path.join(dir, id + '.json');
  let prof;
  if (fs.existsSync(jf)) prof = JSON.parse(fs.readFileSync(jf, 'utf8'));
  else {
    log(`[fabric] descargando el perfil de Fabric ${fv} para Minecraft ${mc}…`);
    prof = await jget(`${META}/${encodeURIComponent(mc)}/${encodeURIComponent(fv)}/profile/json`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(jf, JSON.stringify(prof));
  }
  for (const lib of prof.libraries || []) {
    if (!LIB.test(String(lib.name))) continue;
    const rel = libPath(lib.name), dest = path.join(paths.root(), 'libraries', ...rel.split('/'));
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    const base = String(lib.url || 'https://maven.fabricmc.net/').replace(/\/?$/, '/');
    if (!base.startsWith('https://')) continue;
    log(`[fabric] descargando ${path.basename(rel)}…`);
    const r = await fetch(base + rel, { headers: HEAD, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`Fabric: ${path.basename(rel)} respondió ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (lib.sha1 && crypto.createHash('sha1').update(buf).digest('hex') !== lib.sha1) throw new Error(`Fabric: ${path.basename(rel)} llegó dañado, vuelve a intentarlo.`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  return id;
}
module.exports = { latestLoader, ensure, versionId };
