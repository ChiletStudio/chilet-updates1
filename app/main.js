const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, safeStorage, protocol } = require('electron');
// chilet://media/<modpack>/<archivo>: sirve las fotos, GIF y videos del modpack a la interfaz (con soporte de rangos para que los videos se repitan bien).
protocol.registerSchemesAsPrivileged([{ scheme: 'chilet', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Authenticator } = require('minecraft-launcher-core');

const paths = require('./src/paths');
const settings = require('./src/settings');
const javaMod = require('./src/java');
const forgeMod = require('./src/forge');
const fabricMod = require('./src/fabric');
const guardMod = require('./src/guard');
const socialMod = require('./src/social');
const playlog = require('./src/playlog');
const authMod = require('./src/auth');
const skinMod = require('./src/skin');
const appUpdateMod = require('./src/appupdate');
const launcher = require('./src/launcher');
const modsMod = require('./src/mods');
const packMod = require('./src/pack');
const remoteMod = require('./src/remote');

let win = null;
let running = false;
let installing = false;
const packDir = () => path.join(app.getAppPath(), 'modpack');

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const log = line => send('chilet:log', String(line));
const progress = (stage, message, percent = null) => send('chilet:progress', { stage, message, percent });

function createWindow() {
  const iconFile = path.join(__dirname, 'renderer', 'assets', 'icon.png');
  win = new BrowserWindow({
    width: 1200, height: 760, minWidth: 900, minHeight: 600,
    backgroundColor: '#07040f', autoHideMenuBar: true, title: 'Chilet Studio',
    ...(fs.existsSync(iconFile) ? { icon: iconFile } : {}),
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Icono del modpack: instances/<id>/icon.gif|webp|png (animado si es GIF/WEBP, máx. 6 MB) -> data URL para la barra lateral.
const MEDIA_MIME = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' };
const MEDIA_FILE = /^(icon|banner|logo)\.(png|jpg|gif|webp|mp4|webm)$/;
// Busca icon.* o banner.* del modpack y devuelve su dirección chilet:// y si es video o imagen.
function mediaOf(id, base) {
  for (const ext of Object.keys(MEDIA_MIME)) {
    try {
      const st = fs.statSync(path.join(paths.instance(id), `${base}.${ext}`));
      if (st.isFile()) return { url: `chilet://media/${id}/${base}.${ext}?v=${Math.floor(st.mtimeMs)}`, kind: /^(mp4|webm)$/.test(ext) ? 'video' : 'image' };
    } catch { /* no existe */ }
  }
  return null;
}

function snapshot() {
  const s = settings.read();
  const icons = {}, iconKinds = {}, banners = {}, bannerKinds = {}, logos = {};
  for (const p of s.profiles) {
    const i = mediaOf(p.id, 'icon'); if (i) { icons[p.id] = i.url; iconKinds[p.id] = i.kind; }
    const b = mediaOf(p.id, 'banner'); if (b) { banners[p.id] = b.url; bannerKinds[p.id] = b.kind; }
    const lg = mediaOf(p.id, 'logo'); if (lg && lg.kind === 'image') logos[p.id] = lg.url;
  }
  const modCounts = {};
  for (const p of s.profiles) { try { modCounts[p.id] = fs.readdirSync(path.join(paths.instance(p.id), 'mods')).filter(f => f.toLowerCase().endsWith('.jar')).length; } catch { modCounts[p.id] = 0; } }
  return { settings: s, account: authMod.status(), running, dataDir: paths.base(), icons, iconKinds, banners, bannerKinds, logos, modCounts };
}

const VALID_MC = /^\d+\.\d+(\.\d+)?$/;
const VALID_FORGE = /^\d+(\.\d+){1,3}$/;
const VALID_SERVER = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/; // host o host:puerto (vacío = sin servidor directo)

// ---------- Estado y ajustes ----------
ipcMain.handle('state:get', () => snapshot());
ipcMain.handle('settings:update', (_e, patch) => { settings.update(patch || {}); return snapshot(); });

// Acciones que solo puede hacer el creador (Modo creador desbloqueado). Jugar, iniciar sesión y ajustes personales quedan libres.
const DENIED = { ok: false, locked: true, error: 'Bloqueado: solo el creador puede hacer esto (Modo creador).' };

// ---------- Amigos (lista local: nombre de Minecraft + cara; no hay servidor de chat ni estado en línea) ----------
const friendsFile = () => path.join(app.getPath('userData'), 'friends.json');
const faceFile = id => path.join(app.getPath('userData'), 'friends-cache', id + '.png');
const readFriends = () => { try { const l = JSON.parse(fs.readFileSync(friendsFile(), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; } };
const withFace = f => { let avatar = ''; try { avatar = 'data:image/png;base64,' + fs.readFileSync(faceFile(f.id)).toString('base64'); } catch { /* sin cara guardada */ } return { ...f, avatar }; };
ipcMain.handle('friends:list', () => readFriends().map(withFace));
ipcMain.handle('friends:add', async (_e, raw) => {
  const name = String(raw || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return { ok: false, error: 'Escribe un nombre de Minecraft válido (3 a 16 letras, números o _).' };
  const list = readFriends();
  if (list.length >= 100) return { ok: false, error: 'Llegaste al máximo de 100 amigos.' };
  try {
    const r = await fetch('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name), { signal: AbortSignal.timeout(8000) });
    if (r.status === 404 || r.status === 204) return { ok: false, error: `No existe ningún jugador de Minecraft llamado "${name}".` };
    if (!r.ok) return { ok: false, error: 'Mojang no respondió, inténtalo en un momento.' };
    const j = await r.json();
    if (!/^[0-9a-f]{32}$/i.test(String(j.id))) return { ok: false, error: 'Respuesta de Mojang no válida.' };
    if (list.some(f => f.id === j.id)) return { ok: false, error: `${j.name} ya está en tu lista.` };
    try {
      const a = await fetch(`https://minotar.net/helm/${encodeURIComponent(j.name)}/64.png`, { signal: AbortSignal.timeout(8000) });
      if (a.ok) { fs.mkdirSync(path.dirname(faceFile(j.id)), { recursive: true }); fs.writeFileSync(faceFile(j.id), Buffer.from(await a.arrayBuffer())); }
    } catch { /* se queda sin cara; el nombre se guarda igual */ }
    list.push({ id: j.id, name: j.name, added: Date.now() });
    fs.mkdirSync(path.dirname(friendsFile()), { recursive: true }); fs.writeFileSync(friendsFile(), JSON.stringify(list));
    return { ok: true, friends: list.map(withFace) };
  } catch { return { ok: false, error: 'No hay internet para comprobar ese nombre.' }; }
});
ipcMain.handle('friends:remove', (_e, id) => {
  const list = readFriends().filter(f => f.id !== id);
  fs.writeFileSync(friendsFile(), JSON.stringify(list));
  try { fs.unlinkSync(faceFile(String(id))); } catch { /* no había */ }
  return list.map(withFace);
});

// ---------- Eventos (los crea el creador; llegan a todos junto a las actualizaciones) ----------
const eventsFile = () => path.join(app.getPath('userData'), 'events.json');
const cleanEvents = l => (Array.isArray(l) ? l : []).slice(0, 100).map(e => ({ id: String(e.id || crypto.randomBytes(4).toString('hex')).slice(0, 20), title: String(e.title || '').trim().slice(0, 80), date: String(e.date || '').slice(0, 40), desc: String(e.desc || '').trim().slice(0, 400) })).filter(e => e.title && !isNaN(Date.parse(e.date)));
const readEvents = () => { try { return cleanEvents(JSON.parse(fs.readFileSync(eventsFile(), 'utf8'))); } catch { return []; } };
ipcMain.handle('events:list', () => readEvents());
ipcMain.handle('events:save', (_e, list) => {
  if (!ownerUnlocked) return DENIED;
  const clean = cleanEvents(list); fs.mkdirSync(path.dirname(eventsFile()), { recursive: true }); fs.writeFileSync(eventsFile(), JSON.stringify(clean));
  return { ok: true, events: clean };
});

// ---------- Social: chat, amigos y likes en el servidor social ----------
const SOCIAL_PATHS = new Set(['/friends/request', '/friends/accept', '/friends/decline', '/friends/remove', '/sync', '/send', '/history', '/like', '/ratings']);
ipcMain.handle('social:status', () => ({ on: !!socialMod.url(), url: socialMod.url() }));
ipcMain.handle('social:setUrl', (_e, u) => { if (!ownerUnlocked) return DENIED; try { socialMod.setUrl(String(u || '').trim()); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('social:call', async (_e, p, body) => {
  if (!SOCIAL_PATHS.has(p)) return { error: 'No permitido.' };
  try { return await socialMod.call(p, body, () => authMod.getAuthorization(), settings.read().offlineName); }
  catch (e) { return { error: e?.message || 'Error', nourl: e?.code === 'nourl' }; }
});

ipcMain.handle('face:get', async (_e, name) => {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(String(name))) return '';
  try {
    const f = path.join(app.getPath('userData'), 'friends-cache', 'n-' + name.toLowerCase() + '.png');
    if (!fs.existsSync(f)) { const a = await fetch(`https://minotar.net/helm/${encodeURIComponent(name)}/64.png`, { signal: AbortSignal.timeout(6000) }); if (!a.ok) return ''; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(await a.arrayBuffer())); }
    return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  } catch { return ''; }
});

// ---------- Perfil ----------
ipcMain.handle('profile:me', async () => {
  const acc = authMod.status(), name = (acc && acc.name) || settings.read().offlineName || 'Jugador';
  let avatar = '';
  try {
    const f = path.join(app.getPath('userData'), 'friends-cache', 'me-' + name.replace(/\W/g, '') + '.png');
    if (!fs.existsSync(f)) { const a = await fetch(`https://minotar.net/helm/${encodeURIComponent(name)}/96.png`, { signal: AbortSignal.timeout(6000) }); if (a.ok) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(await a.arrayBuffer())); } }
    avatar = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  } catch { /* sin cara */ }
  return { name, premium: !!acc, avatar, ...playlog.summary() };
});

// ---------- Modpacks ----------
ipcMain.handle('profile:create', (_e, data) => {
  if (!ownerUnlocked) return DENIED;
  const name = String(data?.name || '').trim().slice(0, 40);
  const mc = String(data?.mc || '').trim();
  const loader = data?.loader === 'fabric' ? 'fabric' : '';
  const forge = loader ? '' : String(data?.forge || '').trim();
  const server = String(data?.server || '').trim();
  if (!name) return { ok: false, error: 'Ponle un nombre al modpack.' };
  if (!VALID_MC.test(mc)) return { ok: false, error: 'Versión de Minecraft inválida (ej: 1.20.1).' };
  if (forge && !VALID_FORGE.test(forge)) return { ok: false, error: 'Versión de Forge inválida (ej: 47.4.20). Déjala vacía para vanilla.' };
  if (server && !VALID_SERVER.test(server)) return { ok: false, error: 'Servidor inválido (ej: play.miservidor.com o 1.2.3.4:25565).' };
  const id = settings.addProfile({ name, mc, forge, server, loader });
  fs.mkdirSync(path.join(paths.instance(id), 'mods'), { recursive: true });
  return { ok: true, state: snapshot() };
});
ipcMain.handle('profile:update', (_e, data) => {
  if (!ownerUnlocked) return DENIED;
  const id = String(data?.id || '');
  const name = String(data?.name || '').trim().slice(0, 40);
  const server = String(data?.server || '').trim();
  if (!name) return { ok: false, error: 'Ponle un nombre al modpack.' };
  if (server && !VALID_SERVER.test(server)) return { ok: false, error: 'Servidor inválido (ej: play.miservidor.com o 1.2.3.4:25565).' };
  const ok = settings.updateProfile(id, { name, server });
  return ok ? { ok: true, state: snapshot() } : { ok: false, error: 'Modpack desconocido.' };
});
ipcMain.handle('profile:delete', (_e, id) => {
  if (!ownerUnlocked) return DENIED;
  // Solo quita el modpack de la lista; la carpeta (mundos, mods) NO se borra.
  const ok = settings.removeProfile(String(id));
  return { ok, error: ok ? undefined : 'Debe quedar al menos un modpack.', state: snapshot() };
});
ipcMain.handle('profile:open', async (_e, id) => {
  if (!ownerUnlocked) return DENIED;
  const s = settings.read();
  if (!s.profiles.some(p => p.id === id)) return { ok: false };
  const dir = paths.instance(id);
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  await shell.openPath(dir);
  return { ok: true };
});
// Elegir foto (icon) o portada (banner). Imágenes se reducen; GIF/WEBP animados y videos MP4/WEBM se copian tal cual.
async function pickMedia(id, base) {
  if (!ownerUnlocked) return DENIED;
  const s = settings.read();
  if (!s.profiles.some(p => p.id === id)) return { ok: false, error: 'Modpack desconocido.' };
  const r = await dialog.showOpenDialog(win, {
    title: base === 'banner' ? 'Elige la portada del modpack' : base === 'logo' ? 'Elige el logo del modpack (PNG con fondo transparente)' : 'Elige la foto del modpack',
    properties: ['openFile'], filters: [{ name: 'Imágenes y videos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'mp4', 'webm'] }]
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  try {
    const src = r.filePaths[0], inst = paths.instance(id);
    const ext = path.extname(src).slice(1).toLowerCase();
    fs.mkdirSync(inst, { recursive: true });
    const clear = () => { for (const e of Object.keys(MEDIA_MIME)) { try { fs.unlinkSync(path.join(inst, `${base}.${e}`)); } catch { /* no estaba */ } } };
    if (['gif', 'webp', 'mp4', 'webm'].includes(ext)) {
      const max = (ext === 'mp4' || ext === 'webm' ? 40 : base === 'banner' ? 30 : 15) * 1024 * 1024;
      if (fs.statSync(src).size > max) return { ok: false, error: `El archivo pesa más de ${Math.round(max / 1048576)} MB. Usa uno más ligero (se baja en cada PC).` };
      clear(); fs.copyFileSync(src, path.join(inst, `${base}.${ext}`));
      return { ok: true, state: snapshot() };
    }
    let img = nativeImage.createFromPath(src);
    if (img.isEmpty()) return { ok: false, error: 'No se pudo leer ese archivo.' };
    const { width, height } = img.getSize();
    const limit = base === 'banner' ? 1920 : base === 'logo' ? 1400 : 640, k = Math.min(1, limit / Math.max(width, height));
    if (k < 1) img = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' });
    clear();
    if (base === 'banner') fs.writeFileSync(path.join(inst, 'banner.jpg'), img.toJPEG(90));
    else fs.writeFileSync(path.join(inst, base === 'logo' ? 'logo.png' : 'icon.png'), img.toPNG());
  } catch (e) { return { ok: false, error: 'No se pudo guardar: ' + e.message }; }
  return { ok: true, state: snapshot() };
}
ipcMain.handle('profile:icon', (_e, id) => pickMedia(id, 'icon'));
ipcMain.handle('profile:banner', (_e, id) => pickMedia(id, 'banner'));
ipcMain.handle('profile:logo', (_e, id) => pickMedia(id, 'logo'));
ipcMain.handle('data:open', async () => { await shell.openPath(paths.base()); return { ok: true }; });

// ---------- Mods de menú (FancyMenu + Drippy + librerías) ----------
ipcMain.handle('mods:menu', async () => {
  if (!ownerUnlocked) return DENIED;
  if (running || installing) return { ok: false, error: 'Espera a que termine lo que está en marcha.' };
  const s = settings.read();
  const p = s.profiles.find(x => x.id === s.activeProfile);
  if (p.loader === 'fabric') return { ok: false, error: 'Este modpack usa Fabric: los mods de menú automáticos son solo de Forge. Pon los mods de Fabric a mano en la carpeta mods.' };
  if (!p.forge) return { ok: false, error: 'Este modpack es vanilla: los mods de menú necesitan Forge.' };
  installing = true;
  try {
    const r = await modsMod.installMenuMods({
      profileId: p.id, mc: p.mc, onLog: log,
      onProgress: (msg, pct) => progress('mods', msg, pct)
    });
    progress('idle', `Mods de menú listos (${r.installed.length} archivos).`);
    return { ok: true, ...r };
  } catch (e) {
    const msg = e?.message || String(e);
    log('[mods] error: ' + msg);
    progress('error', msg);
    return { ok: false, error: msg };
  } finally { installing = false; }
});

// ---------- Compartir el modpack ----------
// Conexión con tu GitHub (solo creador). El token se guarda cifrado con el sistema (DPAPI en Windows) en tu carpeta de datos.
const pubFile = () => path.join(app.getPath('userData'), 'publish.json');
const readPub = () => {
  let c;
  try { c = JSON.parse(fs.readFileSync(pubFile(), 'utf8')); } catch { return { user: '', repo: '', branch: '', token: '', broken: false }; }
  let token = '', broken = false;
  try { token = c.tokenEnc ? safeStorage.decryptString(Buffer.from(c.tokenEnc, 'base64')) : (c.token || ''); }
  catch { broken = true; }   // el token guardado no se puede descifrar (otro usuario de Windows, reinstalación…): se conserva usuario y repositorio, solo falta pegar un token nuevo
  return { user: c.user || '', repo: c.repo || '', branch: c.branch || '', token, broken };
};
const writePub = c => {
  const o = { user: c.user, repo: c.repo, branch: c.branch || '' };
  if (c.token) { if (safeStorage.isEncryptionAvailable()) o.tokenEnc = safeStorage.encryptString(c.token).toString('base64'); else o.token = c.token; }
  fs.mkdirSync(path.dirname(pubFile()), { recursive: true }); fs.writeFileSync(pubFile(), JSON.stringify(o, null, 1));
};
ipcMain.handle('pub:get', () => { const c = readPub(); return { user: c.user, repo: c.repo, hasToken: !!c.token, broken: !!c.broken }; });
ipcMain.handle('pub:set', async (_e, d) => {
  if (!ownerUnlocked) return DENIED;
  const user = String(d.user || '').trim(), repo = String(d.repo || '').trim(), old = readPub();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(user) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return { ok: false, error: 'Usuario o repositorio no válido.' };
  const token = String(d.token || '').trim() || old.token;
  if (!token) return { ok: false, error: 'Falta el token de GitHub.' };
  writePub({ user, repo, token, branch: old.user === user && old.repo === repo ? old.branch : '' });
  const check = await remoteMod.verifyGithub({ user, repo, token });   // se guarda siempre; además se comprueba contra GitHub para avisar de inmediato si no sirve
  return { ok: true, check };
});
ipcMain.handle('pack:publish', async () => {
  if (!ownerUnlocked) return DENIED;
  const s = settings.read();
  const p = s.profiles.find(x => x.id === s.activeProfile);
  const outDir = path.join(app.getPath('documents'), 'ChiletStudio-Publicar');
  const say = m => { try { win.webContents.send('pub:progress', m); } catch { /* ventana cerrada */ } };
  try {
    say('Preparando archivos…');
    let appB = null;
    try { appB = appUpdateMod.buildBundle(app.getAppPath(), SHELL); say(appB.changed ? 'Código del launcher: hay cambios, se publica y firma.' : 'Código del launcher: sin cambios.'); }
    catch (e) { say('Aviso: el launcher no se publicó (' + (e?.message || e) + ').'); }
    const r = remoteMod.publish(p, outDir, { events: readEvents(), social: socialMod.url(), app: appB });
    say('Comprobando mods pesados en Modrinth…');
    await remoteMod.verifyExternal(r.external);
    const cfg = readPub();
    if (!cfg.user || !cfg.repo || !cfg.token) { shell.openPath(outDir); return { ok: true, manual: true, dir: outDir, ...r }; }
    const u = await remoteMod.upload(cfg, outDir, say);
    if (u.branch !== cfg.branch) writePub({ ...cfg, branch: u.branch });
    return { ok: true, manual: false, external: r.external.map(e => e.filename), skipped: r.skipped, ...u };
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
});
ipcMain.handle('pack:export', () => {
  if (!ownerUnlocked) return DENIED;
  if (running || installing) return { ok: false, error: 'Espera a que termine lo que está en marcha.' };
  const s = settings.read();
  const p = s.profiles.find(x => x.id === s.activeProfile);
  try { return { ok: true, ...packMod.exportPack(packDir(), p) }; }
  catch (e) { return { ok: false, error: e?.message || String(e) }; }
});

// ---------- Cuenta ----------
ipcMain.handle('auth:login', async () => {
  try { await authMod.login(log, settings.read().loginMode); return { ok: true, state: snapshot() }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('auth:logout', () => { authMod.logout(); skinMod.clear(); return snapshot(); });
ipcMain.handle('skin:get', async () => {
  const acc = settings.read().account;
  return acc && acc.uuid ? skinMod.get(acc.uuid) : null;
});

// ---------- Modo creador (solo tú puedes cambiar los iconos) ----------
// La contraseña se guarda como hash (scrypt) en owner.json, dentro de la carpeta de la app. Se empaqueta con Crear_EXE.bat.
// Dos sitios: (1) la carpeta de la app, que es el candado que viaja con lo que repartes (Program Files NO deja escribir ahí),
// y (2) la carpeta de datos del usuario, que siempre se puede escribir. Se lee primero (1) y luego (2).
const ownerAppFile = () => path.join(app.getAppPath(), 'owner.json');
const ownerUserFile = () => path.join(app.getPath('userData'), 'owner.json');
let ownerUnlocked = false;
// Versión de JUGADOR: la crea Crear_Instalador_Jugadores.bat (pone un archivo player.flag). Nunca se puede desbloquear ni editar nada.
const IS_PLAYER = fs.existsSync(path.join(app.getAppPath(), 'player.flag'));
const updateUrl = () => { try { return (fs.readFileSync(path.join(app.getAppPath(), 'update-url.txt'), 'utf8').match(/^https:\/\/(?!raw\.githubusercontent\.com\/TU_USUARIO)\S+/m) || [''])[0]; } catch { return ''; } };
// Ventana pequeña "Actualizando…" (sin bordes, siempre encima). updWindow(null) la cierra.
let updWin = null;
const UPD_HTML = `<!doctype html><meta charset="utf-8"><title>Actualizando</title><body style="margin:0;background:#101013;color:#fff;font-family:'Segoe UI',Arial,sans-serif;height:100vh;box-sizing:border-box;border:1px solid #2a2a31;display:flex;flex-direction:column;justify-content:center;padding:0 28px;user-select:none">
<div style="font-size:11px;letter-spacing:.38em;color:#9a9aa5"><b style="color:#fff">CHILET</b> STUDIO</div>
<div style="font-size:22px;font-weight:800;margin:10px 0 4px">Actualizando…</div>
<div id="m" style="font-size:12px;color:#b5b5be;min-height:16px;overflow-wrap:anywhere"></div>
<div style="height:6px;background:#2b2b31;margin-top:14px;overflow:hidden"><i id="f" style="display:block;height:100%;width:35%;background:#e11d2e"></i></div>
<style>@keyframes s{from{margin-left:0}to{margin-left:65%}}</style>
<script>function set(m,p){document.getElementById('m').textContent=m;var f=document.getElementById('f');if(p==null){f.style.width='35%';f.style.animation='s 1.1s ease-in-out infinite alternate'}else{f.style.animation='none';f.style.marginLeft='0';f.style.width=p+'%'}}</script>`;
function updWindow(msg, pct) {
  if (msg === null) { if (updWin && !updWin.isDestroyed()) updWin.close(); updWin = null; return; }
  if (!updWin || updWin.isDestroyed()) {
    updWin = new BrowserWindow({ width: 380, height: 170, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, center: true, show: false, backgroundColor: '#101013',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    updWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(UPD_HTML));
    updWin.once('ready-to-show', () => { if (updWin && !updWin.isDestroyed()) updWin.show(); });
  }
  const js = `set(${JSON.stringify(String(msg))}, ${pct == null ? 'null' : Math.round(pct)})`;
  const run = () => { try { updWin.webContents.executeJavaScript(js).catch(() => {}); } catch { /* ventana cerrada */ } };
  if (updWin.webContents.isLoading()) updWin.webContents.once('did-finish-load', run); else run();
}
let remoteBusy = null;
async function remoteSync(log, onProg) {
  const u = IS_PLAYER ? updateUrl() : '';
  if (!u) return;
  if (remoteBusy) { log('[actualización] esperando a que termine la descarga que ya está en curso…'); await remoteBusy.catch(() => {}); }
  remoteBusy = remoteMod.sync(u, log, onProg, x => {
    if (x.social) { try { socialMod.setUrl(x.social); } catch { /* dirección no válida */ } }
    if (Array.isArray(x.events)) { try { fs.mkdirSync(path.dirname(eventsFile()), { recursive: true }); fs.writeFileSync(eventsFile(), JSON.stringify(cleanEvents(x.events))); } catch { /* ignorar */ } }
  });
  try { await remoteBusy; } catch (e) { log('[actualización] no se pudo comprobar (' + (e?.message || e) + '). Se usa lo que ya tienes.'); }
  finally { remoteBusy = null; updWindow(null); }
}
const modsProgress = (d, t) => {
  progress('mods', t ? `Descargando mods ${d}/${t}` : 'Comprobando mods…', t ? Math.round((d / t) * 100) : null);
  if (t && IS_PLAYER) updWindow(`Mods y configuración: ${d} de ${t} archivos`, (d / t) * 100);   // solo si de verdad hay cambios que bajar
};
const readOwner = () => {
  for (const f of [ownerAppFile(), ownerUserFile()]) {
    try { const o = JSON.parse(fs.readFileSync(f, 'utf8')); if (o && o.salt && o.hash) return o; } catch { /* siguiente */ }
  }
  return null;
};
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32);
ipcMain.handle('owner:status', () => ({ hasPassword: !!readOwner(), unlocked: ownerUnlocked, player: IS_PLAYER }));
ipcMain.handle('owner:setup', (_e, pw) => {
  if (IS_PLAYER) return { ok: false, error: 'Esta versión es solo para jugadores.' };
  if (readOwner()) return { ok: false, error: 'Ya hay una contraseña de creador.' };
  pw = String(pw || '');
  if (pw.length < 6) return { ok: false, error: 'Usa al menos 6 caracteres.' };
  const salt = crypto.randomBytes(16).toString('hex');
  const data = JSON.stringify({ salt, hash: hashPw(pw, salt).toString('hex') });
  try {
    fs.mkdirSync(path.dirname(ownerUserFile()), { recursive: true });
    fs.writeFileSync(ownerUserFile(), data);
    try { fs.writeFileSync(ownerAppFile(), data); } catch { /* instalado en Program Files: no hace falta */ }
  }
  catch (e) { return { ok: false, error: 'No se pudo guardar la contraseña: ' + (e?.message || e) }; }
  ownerUnlocked = true;
  return { ok: true };
});
ipcMain.handle('owner:unlock', async (_e, pw) => {
  if (IS_PLAYER) return { ok: false, error: 'Esta versión es solo para jugadores.' };
  const o = readOwner();
  if (!o) return { ok: false, error: 'Primero crea la contraseña.' };
  const a = hashPw(pw, o.salt), b = Buffer.from(o.hash, 'hex');
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) { ownerUnlocked = true; return { ok: true }; }
  await new Promise(r => setTimeout(r, 700)); // frena los intentos seguidos
  return { ok: false, error: 'Contraseña incorrecta.' };
});
ipcMain.handle('owner:lock', () => { ownerUnlocked = false; return { ok: true }; });

// ---------- Datos del modpack para la pantalla de detalles ----------
ipcMain.handle('profile:mods', (_e, id) => {
  if (!settings.read().profiles.some(x => x.id === id)) return [];
  const md = path.join(paths.instance(id), 'mods');
  try {
    return fs.readdirSync(md).filter(f => f.toLowerCase().endsWith('.jar')).map(f => {
      const fp = path.join(md, f), st = fs.statSync(fp);
      return { file: f, size: st.size, ...require('./src/jarinfo').info(fp, st.size, st.mtimeMs) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
});
ipcMain.handle('profile:info', (_e, id) => {
  const p = settings.read().profiles.find(x => x.id === id);
  if (!p) return null;
  const dir = paths.instance(id);
  const info = { mods: [], created: 0, updated: 0, java: javaMod.requiredJava(p.mc) };
  try { const st = fs.statSync(dir); info.created = st.birthtimeMs || st.ctimeMs; info.updated = st.mtimeMs; } catch { /* aún sin carpeta */ }
  try {
    const md = path.join(dir, 'mods');
    info.mods = fs.readdirSync(md).filter(f => f.toLowerCase().endsWith('.jar')).map(f => ({ name: f, size: fs.statSync(path.join(md, f)).size }));
  } catch { /* sin mods */ }
  return info;
});

// ---------- Versiones disponibles (Mojang + Forge) ----------
let versionsCache = null;
ipcMain.handle('versions:get', async () => {
  if (versionsCache) return versionsCache;
  const out = { mc: [], forge: {}, offline: false };
  try {
    const r = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    if (!r.ok) throw new Error(String(r.status));
    out.mc = (await r.json()).versions.map(v => ({ id: v.id, type: v.type }));
  } catch {
    out.offline = true;
    out.mc = ['1.21.4', '1.21.1', '1.20.4', '1.20.1', '1.19.4', '1.19.2', '1.18.2', '1.16.5', '1.12.2'].map(id => ({ id, type: 'release' }));
    out.forge = { '1.20.1': ['47.4.20'], '1.19.2': ['43.4.0'], '1.18.2': ['40.3.0'], '1.16.5': ['36.2.42'], '1.12.2': ['14.23.5.2860'] };
  }
  if (!out.offline) {
    try {
      const r = await fetch('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
      if (!r.ok) throw new Error(String(r.status));
      for (const [, v] of (await r.text()).matchAll(/<version>([^<]+)<\/version>/g)) {
        const i = v.indexOf('-');
        const mc = v.slice(0, i), fv = v.slice(i + 1);
        if (i > 0 && VALID_FORGE.test(fv)) (out.forge[mc] = out.forge[mc] || []).push(fv);
      }
      for (const k of Object.keys(out.forge)) out.forge[k].reverse(); // la más nueva primero
    } catch { /* sin lista de Forge */ }
    versionsCache = out;
  }
  return out;
});

// ---------- Java ----------
ipcMain.handle('java:check', async () => {
  const s = settings.read();
  const p = s.profiles.find(x => x.id === s.activeProfile);
  const need = javaMod.requiredJava(p.mc);
  return { need, found: await javaMod.find(s.javaPath, need) };
});
ipcMain.handle('java:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Selecciona java.exe (Java 17)', properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  settings.update({ javaPath: r.filePaths[0] });
  return { canceled: false, state: snapshot() };
});

// ---------- JUGAR ----------
ipcMain.handle('play', async (_e, mode) => {
  if (!IS_PLAYER) return { ok: false, error: 'La versión de creador no abre Minecraft: sirve para editar y publicar. Para jugar usa la versión de jugadores.' };
  if (running) return { ok: false, error: 'Ya hay una instancia en marcha.' };
  running = true;
  const T0 = Date.now(), lap = n => log(`[tiempo] ${n}: ${((Date.now() - T0) / 1000).toFixed(1)} s desde que pulsaste Jugar`);
  try {
    const s = settings.read();
    const profile = s.profiles.find(p => p.id === s.activeProfile);
    if (!profile || !VALID_MC.test(profile.mc) || (profile.forge && !VALID_FORGE.test(profile.forge)) || (profile.server && !VALID_SERVER.test(profile.server))) {
      throw new Error('El modpack activo tiene datos inválidos.');
    }

    guardMod.preflight(log);

    // 0) El modpack incluido en la app: se repara/actualiza justo antes de jugar y se deja un diagnóstico en la Consola.
    try { packMod.sync(packDir(), log); } catch (e) { log('[modpack] error: ' + (e?.message || e)); }
    const syncP = remoteSync(log, modsProgress);   // se descarga mientras se comprueba la cuenta y Java (no uno detrás del otro)
    // 1) Cuenta
    let auth;
    if (mode === 'offline' || s.alwaysOffline) {
      auth = await Authenticator.getAuth(s.offlineName);
      log(`Jugador no premium como "${s.offlineName}".`);
      if (profile.server) log('[aviso] Entras como no premium: solo podrás unirte a servidores que lo permitan (si el servidor exige cuenta premium verás "Invalid session").');
    } else {
      try {
        progress('auth', 'Comprobando sesión de Microsoft…');
        auth = await authMod.getAuthorization(log);
        if (!auth) { progress('auth', 'Inicia sesión en la ventana de Microsoft…'); auth = await authMod.login(log, s.loginMode); }
      } catch (e) {
        // Sin sesión de Microsoft válida se entra como jugador no premium (sirve en servidores que lo permiten y en mundos locales).
        log(`[cuenta] no se pudo usar la sesión de Microsoft (${e?.message || e}). Se abre como jugador no premium "${s.offlineName}".`);
        progress('auth', profile.server ? 'Sin sesión de Microsoft: entrando como no premium (si el servidor exige cuenta premium te rechazará)…' : 'Sin sesión de Microsoft: entrando como jugador no premium…');
        auth = await Authenticator.getAuth(s.offlineName);
      }
    }

    lap('cuenta');
    // 2) Java (la versión depende de la versión de Minecraft)
    const need = javaMod.requiredJava(profile.mc);
    progress('java', `Buscando Java ${need}…`);
    if (s.javaPath) log(`Nota: si el Java fijado en Ajustes es anterior a Java ${need}, se ignora.`);
    let java = await javaMod.find(s.javaPath, need);
    if (!java) {
      progress('java', `Descargando Java ${need}…`, 0);
      java = await javaMod.installManaged(need, p => progress('java', `Descargando Java ${need}…`, p == null ? null : Math.round(p * 100)));
    }
    log(`Java: ${java.path} (v${java.major})`); lap('Java');

    await syncP; lap('mods al día');
    send('chilet:refresh');
    if (IS_PLAYER && !updateUrl()) { try { packMod.verify(packDir(), log); } catch (e) { log('[modpack] error al verificar: ' + (e?.message || e)); } }
    try {
      const inst = paths.instance(profile.id);
      const jars = fs.existsSync(path.join(inst, 'mods')) ? fs.readdirSync(path.join(inst, 'mods')).filter(f => f.endsWith('.jar')) : [];
      const layout = fs.existsSync(path.join(inst, 'config', 'fancymenu', 'customization', 'title_screen_layout.txt'));
      log(`[diagnóstico] mods: ${jars.length} (${jars.map(j => j.split('_')[0]).join(', ') || 'ninguno'}) · menú personalizado: ${layout ? 'SÍ' : 'NO'} · carpeta del modpack de fábrica: ${fs.existsSync(path.join(packDir(), 'pack.json')) ? 'SÍ' : 'NO'}`);
    } catch { /* solo diagnóstico */ }


    const ram = guardMod.safeRam(s.ramMax);
    if (ram.gb !== Number(s.ramMax)) log(`[revisión] RAM ajustada de ${s.ramMax} GB a ${ram.gb} GB (tu PC tiene ${ram.total} GB).`);
    let startedAt = 0;
    const tail = [];            // últimas líneas que escribió el juego (para entender por qué se cerró)
    let autoRepaired = false;   // la reparación automática se intenta una sola vez por cada pulsación de Jugar
    const startGame = async () => {
      // 3) Forge
      let forge = { mode: 'none' };
      if (profile.forge) {
        progress('forge', 'Descargando Forge…', 0);
        const installer = await forgeMod.ensureInstaller(profile.mc, profile.forge,
          p => progress('forge', 'Descargando Forge…', p == null ? null : Math.round(p * 100)));
        if (s.forgeMode === 'installer') {
          if (!forgeMod.isInstalled(profile.mc, profile.forge)) {
            progress('forge', 'Instalando Forge (puede tardar unos minutos)…');
            await forgeMod.runInstaller({ installer, javaPath: java.path, onLog: log });
          }
          forge = { mode: 'installer', id: forgeMod.versionId(profile.mc, profile.forge) };
        } else {
          forge = { mode: 'mclc', installer };
        }
      }

      if (!profile.forge && profile.loader === 'fabric') {
        progress('forge', 'Preparando Fabric…', 0);
        const fv = profile.fabric || await fabricMod.latestLoader(profile.mc);
        const id = await fabricMod.ensure(profile.mc, fv, log);
        if (!profile.fabric) settings.upsertProfile({ ...profile, fabric: fv });   // se fija la versión para que todos usen la misma
        forge = { mode: 'installer', id };   // misma vía que Forge ya instalado: versión "custom" con inheritsFrom
      }

      // 4) Minecraft
      lap('listo para lanzar'); progress('mc', 'Preparando Minecraft…');
      await launcher.run({
        profile, auth, javaPath: java.path, ramMax: ram.gb, forge,
        server: profile.server || '', fullscreen: !!s.fullscreen,
        onProgress: p => progress(p.stage, p.message, p.percent),
        onLog: l => { log(l); tail.push(String(l)); if (tail.length > 300) tail.shift(); },
        onClose: code => {
          const inst = paths.instance(profile.id), crashed = guardMod.recentCrash(inst, startedAt);
          const out = IS_PLAYER ? '' : tail.join('\n');   // solo versión de creador
          if (!IS_PLAYER && code !== 0 && code !== null && !autoRepaired && guardMod.isForgeLoadFailure(out)) {
            autoRepaired = true;
            log('[reparación] A Forge le faltan archivos o están dañados. Se reparan solos y se reintenta una vez…');
            progress('mc', 'Reparando Forge y reintentando…');
            guardMod.repairForge(profile, log);
            tail.length = 0;
            startGame()
              .then(() => { startedAt = Date.now(); progress('playing', 'Minecraft en marcha.'); })
              .catch(e => { running = false; const m = e?.message || String(e); log('[error] ' + m); progress('error', m); send('chilet:closed', code); });
            return;
          }
          running = false;
          if ((code === 0 || code === null) && !crashed) progress('idle', `Minecraft se cerró (código ${code}).`);
          else {
            const why = guardMod.diagnose(inst, code, out); log('[diagnóstico del cierre] ' + why); progress('error', why);
            const cs = guardMod.crashSummary(inst);
            if (cs) log(`[informe de fallo] ${cs.file}\n  ${cs.desc}\n  ${cs.caused.join('\n  ') || cs.first}`);
          }
          if (startedAt) { try { playlog.add(profile, Date.now() - startedAt); } catch { /* sin registro */ } startedAt = 0; }
        send('chilet:closed', code);
        }
      });
    };
    try { await startGame(); }
    catch (e1) {
      log('[reparación] falló el arranque (' + (e1?.message || e1) + '). Se limpian descargas posiblemente dañadas y se reintenta una vez…');
      progress('mc', 'Reparando archivos y reintentando…');
      guardMod.repair(profile, log);
      await startGame();
    }

    startedAt = Date.now();
    lap('Java abierto (ahora cargan Forge y los mods)'); progress('playing', 'Minecraft en marcha.');
    return { ok: true };
  } catch (e) {
    running = false;
    const msg = e?.message || String(e);
    log('[error] ' + msg);
    progress('error', msg);
    return { ok: false, error: msg };
  }
});

// Reparación manual (SOLO versión de creador): borra piezas dañadas de Minecraft/Forge; se vuelven a bajar al pulsar Jugar.
ipcMain.handle('repair:run', () => {
  if (IS_PLAYER) return { ok: false, error: 'Solo está disponible en la versión de creador.' };
  if (running) return { ok: false, error: 'Cierra Minecraft antes de reparar.' };
  const s = settings.read(), profile = s.profiles.find(p => p.id === s.activeProfile) || s.profiles[0];
  const lines = []; guardMod.repairForge(profile, m => { lines.push(m); log(m); });
  return { ok: true, count: lines.length };
});

// ---------- actualizaciones del launcher (sin reinstalar) ----------
let SHELL = 1; try { SHELL = Number(JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).shellLevel) || 1; } catch { /* valor por defecto */ }
const appSay = m => { try { win.webContents.send('app:update', m); } catch { /* ventana cerrada */ } };
let launcherBusy = false;
async function launcherUpdate() {
  if (!IS_PLAYER || launcherBusy) return;
  const url = updateUrl(); if (!url) return;
  launcherBusy = true;
  try {
    const r = await appUpdateMod.check({ url, appDir: app.getAppPath(), shell: SHELL, log, onStage: (m, p) => { if (!running && !installing) updWindow(m, p); } });
    if (r.updated) {
      if (running || installing) { updWindow(null); appSay('Hay una actualización del launcher: se aplicará la próxima vez que abras Chilet Studio.'); }
      else { updWindow('Listo. Reiniciando el launcher…', 100); appSay('Actualizando el launcher… se reiniciará solo.'); setTimeout(() => { if (!running && !installing) { app.relaunch(); app.exit(0); } else updWindow(null); }, 2500); }
    } else if (r.needInstaller) appSay('Hay una versión nueva del launcher que necesita un instalador nuevo. Pídeselo al creador.');
    else if (r.bad) log('[launcher] actualización ignorada: ' + r.bad);
  } catch (e) { updWindow(null); log('[launcher] no se pudo revisar actualizaciones: ' + (e?.message || e)); }
  launcherBusy = false;
}
ipcMain.handle('app:restore', () => {
  if (!IS_PLAYER) return { ok: false, error: 'Solo está disponible en la versión de jugadores.' };
  if (running || installing) return { ok: false, error: 'Cierra Minecraft antes de restaurar.' };
  appUpdateMod.restoreOriginal(); app.relaunch({ args: process.argv.slice(1).concat('--original') }); app.exit(0);
  return { ok: true };
});

app.whenReady().then(() => {
  protocol.handle('chilet', req => {
    try {
      const u = new URL(req.url);
      const [id, file] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (u.hostname !== 'media' || !/^[A-Za-z0-9_-]{1,40}$/.test(id || '') || !MEDIA_FILE.test(file || '')) return new Response('no', { status: 404 });
      const buf = fs.readFileSync(path.join(paths.instance(id), file)), total = buf.length;
      const type = MEDIA_MIME[path.extname(file).slice(1)];
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
      if (m && (m[1] || m[2])) {
        let a = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2])), z = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (a > z || a >= total) return new Response('rango no válido', { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
        return new Response(buf.subarray(a, z + 1), { status: 206, headers: { 'Content-Type': type, 'Content-Range': `bytes ${a}-${z}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(z - a + 1) } });
      }
      return new Response(buf, { headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(total) } });
    } catch { return new Response('no', { status: 404 }); }
  });
  // Modpack incluido en la app: se instala/actualiza solo antes de abrir la ventana.
  const bootLog = [];
  try { packMod.sync(packDir(), m => bootLog.push(m)); } catch (e) { bootLog.push('[modpack] error: ' + (e?.message || e)); }
  // Al abrir el launcher ya se bajan los mods nuevos en segundo plano: así, al pulsar Jugar normalmente ya está todo listo.
  remoteSync(m => bootLog.push(m), (d, t) => { if (!running) modsProgress(d, t); }).finally(() => { if (!running) progress('idle', ''); send('chilet:refresh'); });   // avisa a la interfaz: ya hay fotos, portada, mods y servidor nuevos
  if (IS_PLAYER && !updateUrl()) { try { packMod.verify(packDir(), m => bootLog.push(m)); } catch { /* se reintenta al jugar */ } }
  createWindow();
  if (IS_PLAYER) {
    setTimeout(launcherUpdate, 5000); setInterval(launcherUpdate, 30 * 60 * 1000);
    setInterval(() => { if (!running && !installing) remoteSync(m => log(m), (d, t) => { if (!running) modsProgress(d, t); }).finally(() => { if (!running) progress('idle', ''); send('chilet:refresh'); }); }, 30 * 60 * 1000);
  } else appUpdateMod.ensureKeys();
  win.webContents.once('did-finish-load', () => bootLog.forEach(l => log(l)));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
