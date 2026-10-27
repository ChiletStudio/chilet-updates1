const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const { download } = require('./download');

const API = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': 'ChiletStudio/0.6.5 (launcher personal)' };

// Mods que se instalan para personalizar menús y pantalla de carga.
// required:false -> si no existe versión para esa versión de Minecraft, se omite sin error.
const MENU_MODS = [
  { id: 'fancymenu', required: true },
  { id: 'drippy-loading-screen', required: true },
  { id: 'konkrete', required: false },
  { id: 'melody', required: false }
];

// Mods base de cada cargador (rendimiento + menú). Solo FancyMenu y Fabric API son obligatorios; el resto se omite si no existe para esa versión.
const STARTER = {
  forge: [{ id: 'fancymenu', required: true }, { id: 'drippy-loading-screen', required: false }, { id: 'embeddium', required: false }, { id: 'ferrite-core', required: false }, { id: 'modernfix', required: false }],
  fabric: [{ id: 'fabric-api', required: true }, { id: 'fancymenu', required: true }, { id: 'drippy-loading-screen', required: false }, { id: 'sodium', required: false }, { id: 'lithium', required: false }, { id: 'ferrite-core', required: false }, { id: 'modmenu', required: false }]
};

async function api(p) {
  const r = await fetch(API + p, { headers: HEADERS });
  if (!r.ok) throw new Error(`Modrinth respondió ${r.status} (${p})`);
  return r.json();
}

// Versión más reciente (preferiblemente "release") para ese Minecraft y loader.
async function pickVersion(id, mc, loader) {
  const q = `?loaders=${encodeURIComponent(JSON.stringify([loader]))}&game_versions=${encodeURIComponent(JSON.stringify([mc]))}`;
  const list = await api(`/project/${encodeURIComponent(id)}/version${q}`);
  if (!Array.isArray(list) || !list.length) return null;
  return list.find(v => v.version_type === 'release') || list[0];
}

function sha512(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// Descarga los mods de menú (y sus dependencias obligatorias) a instances/<id>/mods, verificando el hash sha512.
async function installMenuMods({ profileId, mc, loader = 'forge', starter = false, onLog = () => {}, onProgress = () => {} }) {
  const modsDir = path.join(paths.instance(profileId), 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  const queue = (starter ? STARTER[loader === 'fabric' ? 'fabric' : 'forge'] : [...(loader === 'fabric' ? [{ id: 'fabric-api', required: true }] : []), ...MENU_MODS]).map(m => ({ ...m }));   // Fabric necesita además Fabric API
  const seen = new Set();
  const installed = [];
  const skipped = [];

  while (queue.length) {
    const item = queue.shift();
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    onProgress(`Buscando ${item.id}…`, null);
    const v = await pickVersion(item.id, mc, loader);
    if (!v) {
      if (item.required) throw new Error(`"${item.id}" no tiene versión para ${loader} ${mc} en Modrinth.`);
      skipped.push(item.id);
      onLog(`[mods] ${item.id}: sin versión para ${mc}, se omite.`);
      continue;
    }

    const file = (v.files || []).find(f => f.primary) || (v.files || [])[0];
    if (!file) throw new Error(`"${item.id}" no trae archivos descargables.`);
    const name = path.basename(String(file.filename));
    if (!name.toLowerCase().endsWith('.jar')) throw new Error(`Archivo inesperado: ${name}`);
    let host = '';
    try { host = new URL(file.url).hostname; } catch { /* url inválida */ }
    if (host !== 'cdn.modrinth.com') throw new Error(`Descarga de origen no esperado: ${host || file.url}`);

    const dest = path.join(modsDir, name);
    const expected = file.hashes && file.hashes.sha512;
    if (fs.existsSync(dest) && expected && await sha512(dest) === expected) {
      onLog(`[mods] ${name}: ya estaba instalado.`);
    } else {
      onProgress(`Descargando ${name}…`, 0);
      await download(file.url, dest, (d, t) => onProgress(`Descargando ${name}…`, t ? Math.round((d / t) * 100) : null));
      if (expected && await sha512(dest) !== expected) {
        fs.rmSync(dest, { force: true });
        throw new Error(`El archivo ${name} llegó dañado (hash distinto). Intenta de nuevo.`);
      }
      onLog(`[mods] ${name}: instalado.`);
    }
    if (!installed.includes(name)) installed.push(name);

    for (const dep of v.dependencies || []) {
      if (dep.dependency_type === 'required' && dep.project_id) queue.push({ id: dep.project_id, required: true });
    }
  }
  return { installed, skipped };
}

// Fabric API: casi todos los mods de Fabric la piden. Si falta en la carpeta mods, se baja la de esa versión de Minecraft.
const hasFabricApi = profileId => { try { return fs.readdirSync(path.join(paths.instance(profileId), 'mods')).some(f => /^fabric-api.*\.jar$/i.test(f)); } catch { return false; } };
async function ensureFabricApi({ profileId, mc, onLog = () => {}, onProgress = () => {} }) {
  if (hasFabricApi(profileId)) return false;
  onLog('[fabric] falta Fabric API en la carpeta mods: se descarga sola.');
  const modsDir = path.join(paths.instance(profileId), 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const v = await pickVersion('fabric-api', mc, 'fabric');
  if (!v) throw new Error(`Fabric API todavía no existe para Minecraft ${mc}.`);
  const file = (v.files || []).find(f => f.primary) || (v.files || [])[0];
  const name = file && path.basename(String(file.filename));
  if (!name || !name.toLowerCase().endsWith('.jar')) throw new Error('Fabric API no trae un archivo descargable.');
  let host = ''; try { host = new URL(file.url).hostname; } catch { /* url inválida */ }
  if (host !== 'cdn.modrinth.com') throw new Error('Descarga de origen no esperado: ' + (host || file.url));
  const dest = path.join(modsDir, name);
  onProgress(`Descargando ${name}…`, 0);
  await download(file.url, dest, (d, t) => onProgress(`Descargando ${name}…`, t ? Math.round((d / t) * 100) : null));
  const expected = file.hashes && file.hashes.sha512;
  if (expected && await sha512(dest) !== expected) { fs.rmSync(dest, { force: true }); throw new Error(`${name} llegó dañado. Intenta de nuevo.`); }
  onLog(`[fabric] ${name}: instalado.`);
  return true;
}

module.exports = { installMenuMods, ensureFabricApi, hasFabricApi };
