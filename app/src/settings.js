const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const DEFAULTS = () => ({
  ramMax: 4,
  alwaysOffline: false,         // entrar siempre como jugador no premium (sin abrir el login de Microsoft)
  fullscreen: false,            // abrir Minecraft en pantalla completa
  javaPath: '',
  autoPublish: true,            // creador: al cerrar Minecraft, publica solo los cambios de mods/config para todos
  offlineName: 'Jugador',
  loginMode: 'electron',        // 'electron' (ventana de la app) | 'raw' (navegador del sistema)
  forgeMode: 'mclc',            // 'mclc' (ForgeWrapper de la librería) | 'installer' (instalador oficial de Forge)
  activeProfile: 'default',
  account: null,                // { name, uuid } - el token va cifrado aparte
  profiles: [{ id: 'default', name: 'Mi primer modpack', mc: '1.20.1', forge: '47.4.20' }]
});

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(paths.settings(), 'utf8'));
    const s = { ...DEFAULTS(), ...data };
    if (!Array.isArray(s.profiles) || !s.profiles.length) s.profiles = DEFAULTS().profiles;
    if (!s.profiles.some(p => p.id === s.activeProfile)) s.activeProfile = s.profiles[0].id;
    return s;
  } catch {
    return DEFAULTS();
  }
}

function write(s) {
  const file = paths.settings();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return s;
}

function update(patch) {
  const s = read();
  if (Number.isFinite(patch.ramMax)) s.ramMax = Math.min(32, Math.max(1, Math.round(patch.ramMax)));
  if (typeof patch.fullscreen === 'boolean') s.fullscreen = patch.fullscreen;
  if (typeof patch.alwaysOffline === 'boolean') s.alwaysOffline = patch.alwaysOffline;
  if (typeof patch.autoPublish === 'boolean') s.autoPublish = patch.autoPublish;
  if (typeof patch.javaPath === 'string') s.javaPath = patch.javaPath.trim();
  if (typeof patch.offlineName === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(patch.offlineName)) s.offlineName = patch.offlineName;
  if (patch.loginMode === 'electron' || patch.loginMode === 'raw') s.loginMode = patch.loginMode;
  if (patch.forgeMode === 'mclc' || patch.forgeMode === 'installer') s.forgeMode = patch.forgeMode;
  if (typeof patch.activeProfile === 'string' && s.profiles.some(p => p.id === patch.activeProfile)) s.activeProfile = patch.activeProfile;
  return write(s);
}

function setAccount(account) {
  const s = read();
  s.account = account;
  return write(s);
}

function addProfile({ name, mc, forge, server = '', loader = '' }) {
  const s = read();
  const id = 'p' + Date.now().toString(36);
  s.profiles.push({ id, name, mc, forge, server, ...(loader ? { loader } : {}) });
  s.activeProfile = id;
  write(s);
  return id;
}

function upsertProfile({ id, name, mc, forge, server = '', loader, fabric }) {
  const s = read();
  const i = s.profiles.findIndex(p => p.id === id);
  const extra = loader !== undefined ? { loader: loader || undefined, fabric: fabric || undefined } : (fabric ? { fabric } : {});
  if (i >= 0) s.profiles[i] = { ...s.profiles[i], name, mc, forge, server, ...extra };
  else { s.profiles.push({ id, name, mc, forge, server, ...extra }); s.activeProfile = id; }
  write(s);
}

function updateProfile(id, { name, server }) {
  const s = read();
  const p = s.profiles.find(x => x.id === id);
  if (!p) return false;
  p.name = name;
  p.server = server;
  write(s);
  return true;
}

function removeProfile(id) {
  const s = read();
  if (s.profiles.length <= 1) return false;
  s.profiles = s.profiles.filter(p => p.id !== id);
  if (s.activeProfile === id) s.activeProfile = s.profiles[0].id;
  write(s);
  return true;
}

module.exports = { read, update, setAccount, addProfile, updateProfile, upsertProfile, removeProfile };
