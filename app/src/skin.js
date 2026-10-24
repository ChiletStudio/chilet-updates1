const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const cacheFile = () => path.join(paths.base(), 'skin-cache.json');
const MAX_AGE = 60 * 60 * 1000; // 1 hora (el servidor de sesión de Mojang limita las consultas)

function readCache() { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return null; } }
function writeCache(data) { try { fs.writeFileSync(cacheFile(), JSON.stringify(data)); } catch { /* no crítico */ } }

// Skin oficial de la cuenta (servidor de sesión de Mojang) como data URL PNG, o null.
async function download(uuid) {
  const clean = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) return null;
  const r = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${clean}`);
  if (!r.ok) throw new Error('sessionserver ' + r.status);
  const profile = await r.json();
  const prop = (profile.properties || []).find(p => p.name === 'textures');
  if (!prop) return null;
  const textures = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
  const url = textures?.textures?.SKIN?.url;
  if (!url) return null; // sin skin propia: se queda la inicial
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!/(^|\.)minecraft\.net$/.test(u.hostname)) return null; // solo texturas oficiales
  const img = await fetch(url);
  if (!img.ok) throw new Error('textures ' + img.status);
  const buf = Buffer.from(await img.arrayBuffer());
  if (buf.length > 512 * 1024) return null;
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function get(uuid) {
  const cached = readCache();
  const same = cached && cached.uuid === uuid;
  if (same && Date.now() - cached.at < MAX_AGE) return cached.dataUrl || null;
  try {
    const dataUrl = await download(uuid);
    writeCache({ uuid, at: Date.now(), dataUrl });
    return dataUrl;
  } catch {
    return same ? (cached.dataUrl || null) : null; // sin red o límite: usa la última conocida
  }
}

function clear() { try { fs.rmSync(cacheFile(), { force: true }); } catch { /* nada */ } }

module.exports = { get, clear };
