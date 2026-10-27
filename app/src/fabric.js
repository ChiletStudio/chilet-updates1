// Fabric dentro del launcher: baja el perfil oficial de meta.fabricmc.net y sus librerías, sin instaladores aparte.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

const META = 'https://meta.fabricmc.net/v2/versions/loader';
const HEAD = { 'User-Agent': 'ChiletStudio/1.3 (launcher)' };
const LIB = /^[\w.-]+:[\w.-]+:[\w.+-]+(:[\w.-]+)?$/;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Reintenta (3 veces) ante fallos de red o errores 5xx; un 4xx se devuelve tal cual.
async function retry(fn, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (e && e.fatal) break; if (i < tries) await sleep(800 * i); }
  }
  throw last;
}
async function jget(u) {
  return retry(async () => {
    const r = await fetch(u, { headers: HEAD, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw Object.assign(new Error(`Fabric: ${u.replace(META, '…')} respondió ${r.status}`), { fatal: r.status >= 400 && r.status < 500 });
    return r.json();
  });
}
// Última versión ESTABLE del cargador de Fabric para esa versión de Minecraft.
// Si no hay internet, se usa la última versión de Fabric que ya está instalada para ese Minecraft.
function installedLoader(mc) {
  try {
    const re = new RegExp(`^fabric-loader-(.+)-${mc.replace(/\./g, '\\.')}$`);
    const ids = fs.readdirSync(path.join(paths.root(), 'versions')).map(d => (re.exec(d) || [])[1]).filter(Boolean);
    return ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() || '';
  } catch { return ''; }
}
async function latestLoader(mc) {
  let list;
  try { list = await jget(`${META}/${encodeURIComponent(mc)}`); }
  catch (e) { const have = installedLoader(mc); if (have) return have; throw e; }
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
  try { if (fs.existsSync(jf)) { prof = JSON.parse(fs.readFileSync(jf, 'utf8')); if (!prof || !Array.isArray(prof.libraries) || !prof.mainClass) prof = null; } } catch { prof = null; }   // archivo dañado: se baja otra vez
  if (!prof) {
    log(`[fabric] descargando el perfil de Fabric ${fv} para Minecraft ${mc}…`);
    prof = await jget(`${META}/${encodeURIComponent(mc)}/${encodeURIComponent(fv)}/profile/json`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(jf, JSON.stringify(prof));
  }
  for (const lib of prof.libraries || []) {
    if (!LIB.test(String(lib.name))) continue;
    const rel = libPath(lib.name), dest = path.join(paths.root(), 'libraries', ...rel.split('/'));
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    const own = String(lib.url || 'https://maven.fabricmc.net/').replace(/\/?$/, '/');
    const bases = [own, 'https://maven.fabricmc.net/', 'https://repo1.maven.org/maven2/'].filter((b, i, a) => b.startsWith('https://') && a.indexOf(b) === i);
    log(`[fabric] descargando ${path.basename(rel)}…`);
    let buf = null, why = '';
    for (const base of bases) {
      try {
        buf = await retry(async () => {
          const r = await fetch(base + rel, { headers: HEAD, signal: AbortSignal.timeout(120000) });
          if (!r.ok) throw Object.assign(new Error(`respondió ${r.status}`), { fatal: r.status >= 400 && r.status < 500 });
          const b = Buffer.from(await r.arrayBuffer());
          if (lib.sha1 && crypto.createHash('sha1').update(b).digest('hex') !== lib.sha1) throw new Error('llegó dañado');
          return b;
        });
        break;
      } catch (e) { why = e?.message || String(e); }
    }
    if (!buf) throw new Error(`Fabric: no se pudo bajar ${path.basename(rel)} (${why}). Revisa tu internet y vuelve a pulsar Jugar.`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  return id;
}
module.exports = { latestLoader, ensure, versionId };
