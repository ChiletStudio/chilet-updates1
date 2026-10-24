const api = window.chilet;
const $ = sel => document.querySelector(sel);
let state = null;
let busy = false;

function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c);
  return n;
}

// ---------- logo: si no existe assets/logo.png se muestra el texto ----------
{ // logo grande del Inicio: si no existe assets/logo.png se ve solo el nombre
  const hl = $('#homeLogo');
  hl.addEventListener('load', () => hl.classList.add('ok')); hl.addEventListener('error', () => hl.classList.remove('ok'));
  if (hl.complete && hl.naturalWidth) hl.classList.add('ok');
}
const logo = $('#logo');
logo.addEventListener('error', () => { logo.classList.add('hidden'); $('#wordmark').classList.remove('hidden'); });
logo.addEventListener('load', () => { logo.classList.add('ok'); $('#wordmark').classList.add('hidden'); });
// Si la imagen ya terminó de cargar antes de que este script corriera, los eventos no se disparan: se revisa a mano.
if (logo.complete) {
  if (logo.naturalWidth > 0) { logo.classList.add('ok'); $('#wordmark').classList.add('hidden'); }
  else { logo.classList.add('hidden'); $('#wordmark').classList.remove('hidden'); }
}

// Logo de abajo: siempre visible; solo se oculta si el archivo no existe.
$('#logoBottom').addEventListener('error', e => e.target.classList.add('hidden'));

// ---------- utilidades de aspecto ----------
function hashOf(str) { let x = 0; for (const ch of str) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return x; }
const hueOf = p => (p.id === 'default' ? 355 : 345 + hashOf(p.id) % 25);
function initials(name) {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : name.trim().slice(0, 2)).toUpperCase() || '?';
}
const metaOf = p => `Minecraft ${p.mc} · ${p.forge ? 'Forge ' + p.forge : p.loader === 'fabric' ? 'Fabric' : 'Vanilla'}${p.server ? ' · ' + p.server : ''}`;
// Foto/portada: imagen, GIF animado o video (silencioso y en bucle).
function mediaEl(url, kind, cls = '') {
  if (kind === 'video') {
    const v = document.createElement('video');
    v.src = url; v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true; v.className = cls;
    v.play().catch(() => {});
    return v;
  }
  return h('img', { src: url, alt: '', class: cls });
}
const setStatus = t => { $('#status').textContent = t; };

function activeProfile() {
  return state.settings.profiles.find(p => p.id === state.settings.activeProfile);
}

// ---------- skin en el círculo de abajo ----------
let skinFor = null;      // nombre de la cuenta para la que se pidió la skin
let skinLoaded = false;
async function loadSkin(name) {
  skinFor = name; skinLoaded = false;
  try {
    const url = await api.getSkin();
    if (!url || skinFor !== name) return;
    const img = new Image();
    img.onload = () => {
      if (skinFor !== name) return;
      const canvas = $('#avatarSkin');
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, 8, 8);
      ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);   // cara
      ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);  // capa exterior (pelo, gorro)
      skinLoaded = true;
      canvas.classList.remove('hidden');
      $('#avatarLetter').classList.add('hidden');
    };
    img.src = url;
  } catch { /* se queda la inicial */ }
}

// ---------- panel superpuesto ----------
const SHEETS = { create: 'Crear modpack', edit: 'Editar modpack', console: 'Consola', settings: 'Ajustes y cuenta', unlock: 'Modo creador' };
function openSheet(name) {
  if (name === 'edit') paintGh();
  $('#sheet').classList.remove('hidden');
  $('#sheetTitle').textContent = SHEETS[name];
  for (const k of Object.keys(SHEETS)) $('#sheet-' + k).classList.toggle('hidden', k !== name);
}
function closeSheet() { $('#sheet').classList.add('hidden'); }
$('#btnCreate').addEventListener('click', () => { openSheet('create'); initCreate(); });
$('#btnConsole').addEventListener('click', () => openSheet('console'));
// Menú del avatar: como en la referencia, la barra lateral solo muestra Inicio, modpacks y avatar.
const avMenu = $('#avMenu');
const closeAv = () => avMenu.classList.add('hidden');
$('#btnSettings').addEventListener('click', e => {
  e.stopPropagation();
  if (!avMenu.classList.contains('hidden')) { closeAv(); return; }
  const acc = state && state.account, isPlayer = typeof owner !== 'undefined' && owner && owner.player;
  const go = (label, fn) => h('button', { class: 'av-item', type: 'button', onclick: () => { closeAv(); fn(); } }, label);
  avMenu.replaceChildren(
    h('div', { class: 'av-head' }, acc && acc.loggedIn ? 'Sesión: ' + acc.name : 'Sin sesión de Microsoft'),
    go('Perfil', () => $('#btnProfile').click()),
    go('Social: amigos y chat', () => $('#btnSocial').click()),
    go('Eventos', () => $('#btnEvents').click()),
    ...(isPlayer ? [] : [go('Crear modpack', () => $('#btnCreate').click())]),
    go('Consola', () => $('#btnConsole').click()),
    go('Ajustes', () => openSheet('settings')));
  avMenu.classList.remove('hidden');
});
document.addEventListener('click', e => { if (!e.target.closest('#avMenu')) closeAv(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAv(); });
$('#sheetClose').addEventListener('click', closeSheet);
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

// ---------- render ----------
// Portada grande de la página del modpack (si no hay, se arma con la foto difuminada y los colores del modpack).
function paintHero(p, icon) {
  const ban = state.banners && state.banners[p.id], hero = $('#heroMedia');
  if (ban) hero.replaceChildren(mediaEl(ban, state.bannerKinds[p.id]));
  else if (icon) {
    const bg = h('div', { class: 'hero-blur' }); bg.style.backgroundImage = `url("${icon}")`;
    hero.replaceChildren(state.iconKinds[p.id] === 'video' ? mediaEl(icon, 'video') : bg);
  } else hero.replaceChildren();
}
function packButton(p, active) {
  const icon = state.icons && state.icons[p.id];
  const b = h('button', { class: 'pack' + (active ? ' active' : '') + (icon ? ' has-icon' : ''), title: `${p.name}\n${metaOf(p)}` + '\nClic derecho: cambiar foto', onclick: () => choose(p.id), contextmenu: e => { e.preventDefault(); tryIcon(p.id); } },
    icon ? mediaEl(icon, state.iconKinds && state.iconKinds[p.id]) : initials(p.name));
  b.style.setProperty('--ph', hueOf(p));
  return b;
}

function render() {
  if (!state) return;
  const s = state.settings;
  const p = activeProfile();
  const acc = state.account;

  $('#stage').style.setProperty('--h', hueOf(p));
  $('#railPacks').replaceChildren(...s.profiles.map(x => packButton(x, x.id === s.activeProfile)));
  $('#topName').textContent = p.name;
  const logoUrl = state.logos && state.logos[p.id];
  $('#heroTitle').replaceChildren(...(logoUrl ? [h('img', { src: logoUrl, alt: p.name })] : []));
  $('#profileMeta').textContent = metaOf(p);

  $('#accountLine').textContent = acc.loggedIn ? 'Sesión: ' + acc.name : 'Sin sesión de Microsoft';
  $('#login').classList.toggle('hidden', acc.loggedIn);
  $('#avatarLetter').textContent = acc.loggedIn ? acc.name[0].toUpperCase() : '?';
  if (acc.loggedIn) {
    if (skinFor !== acc.name) loadSkin(acc.name);
  } else {
    skinFor = null; skinLoaded = false;
    $('#avatarSkin').classList.add('hidden');
    $('#avatarLetter').classList.remove('hidden');
  }

  $('#ram').value = s.ramMax;
  $('#fullscreen').checked = !!s.fullscreen;
  $('#alwaysOffline').checked = !!s.alwaysOffline;
  $('#ramValue').textContent = s.ramMax;
  $('#forgeMode').value = s.forgeMode;
  $('#loginMode').value = s.loginMode;
  $('#offlineName').value = s.offlineName;
  if (document.activeElement !== $('#offlineQuick')) $('#offlineQuick').value = s.offlineName;
  $('#accountInfo').textContent = acc.loggedIn ? 'Sesión iniciada: ' + acc.name : 'Sin sesión.';
  $('#javaInfo').textContent = s.javaPath ? 'Java fijado: ' + s.javaPath : 'Java: automático';
  $('#settingsLogin').classList.toggle('hidden', acc.loggedIn);
  $('#logout').classList.toggle('hidden', !acc.loggedIn);

  const icon = state.icons && state.icons[p.id];
  $('#packIcon').replaceChildren(icon ? mediaEl(icon, state.iconKinds && state.iconKinds[p.id]) : initials(p.name));
  paintHero(p, icon);
  paintRate();
  $('#installed').textContent = state.running ? 'En marcha' : 'Listo';
  paintInfo();
  renderHome();
  setBusy(state.running || busy);
}

function setBusy(flag) {
  $('#play').disabled = flag;
  $('#playOffline').disabled = flag;
  $('#play').textContent = flag ? 'En curso…' : 'Jugar';
}

async function choose(id) { state = await api.updateSettings({ activeProfile: id }); closeMods(); showView('pack'); render(); }

// ---------- inicio ----------
let currentView = 'home';
function showView(v) {
  currentView = v;
  for (const id of ['home', 'social', 'events', 'profile']) $('#' + id).classList.toggle('hidden', v !== id);
  for (const [b, id] of [['#btnHome', 'home'], ['#btnSocial', 'social'], ['#btnEvents', 'events'], ['#btnProfile', 'profile']]) $(b).classList.toggle('active', v === id);
}
// ---------- social: amigos ----------
function friendCard(f) {
  const face = f.avatar ? h('img', { src: f.avatar, alt: '' }) : (f.name[0] || '?').toUpperCase();
  return h('div', { class: 'friend' }, h('div', { class: 'friend-face' }, face),
    h('div', { class: 'friend-txt' }, h('div', { class: 'friend-name' }, f.name), h('div', { class: 'friend-sub' }, 'Agregado el ' + new Date(f.added).toLocaleDateString())),
    h('button', { class: 'chip', type: 'button', title: 'Copiar su nombre', onclick: () => { navigator.clipboard.writeText(f.name).then(() => paintFriendMsg(`Copiado: ${f.name}`)).catch(() => {}); } }, 'Copiar nombre'),
    h('button', { class: 'chip danger', type: 'button', title: 'Quitar de tu lista', onclick: async () => paintFriends(await api.friendsRemove(f.id)) }, 'Quitar'));
}
function paintFriendMsg(t, bad) { const m = $('#friendMsg'); m.textContent = t || ''; m.classList.toggle('bad', !!bad); }
function paintFriends(list) {
  social.local = list; paintHomeFriends();
  $('#friendCount').textContent = list.length ? `(${list.length})` : '';
  $('#friendList').replaceChildren(...(list.length ? list.map(friendCard) : [h('div', { class: 'empty' }, 'Todavía no tienes amigos. Escribe su nombre de Minecraft arriba y pulsa Agregar.')]));
}
async function openSocial() { closeMods(); showView('social'); paintFriendMsg(''); if (social.on) { await socialSync(); paintChat(); } else paintFriends(await api.friendsList()); }
async function addFriend() {
  const inp = $('#friendName'), btn = $('#friendAdd');
  if (!inp.value.trim()) return;
  btn.disabled = true; paintFriendMsg('Buscando jugador…');
  const r = await api.friendsAdd(inp.value);
  btn.disabled = false;
  if (r.ok) { inp.value = ''; paintFriends(r.friends); paintFriendMsg('¡Amigo agregado!'); } else paintFriendMsg(r.error, true);
}
$('#btnSocial').addEventListener('click', openSocial);
$('#friendAdd').addEventListener('click', addFriend);
$('#friendName').addEventListener('keydown', e => { if (e.key === 'Enter') addFriend(); });
$('#btnHome').addEventListener('click', () => { closeMods(); showView('home'); renderHome(); paintHomeFriends(); });
$('#homeSearch').addEventListener('input', renderHome);
function card(p) {
  const icon = state.icons && state.icons[p.id];
  const img = h('div', { class: 'card-img' });
  const ban = state.banners && state.banners[p.id];
  if (ban) img.append(mediaEl(ban, state.bannerKinds[p.id], 'card-pic cover'));                       // portada: llena la tarjeta
  else if (icon && state.iconKinds[p.id] === 'video') img.append(mediaEl(icon, 'video', 'card-pic cover'));
  else if (icon) {
    const bg = h('div', { class: 'card-bg' }); bg.style.backgroundImage = `url("${icon}")`;           // foto: entera sobre fondo difuminado
    img.append(bg, h('img', { class: 'card-pic', src: icon, alt: '' }));
  } else img.append(initials(p.name));
  img.append(h('span', { class: 'card-play' }, h('b', { onclick: e => { e.stopPropagation(); quickPlay(p.id); } }, 'Jugar')));   // solo el botón "Jugar" lanza el juego
  if (!owner.player) img.append(h('span', { class: 'card-edit', onclick: e => { e.stopPropagation(); tryIcon(p.id); } }, 'Cambiar foto'));
  const c = h('button', { class: 'card', type: 'button', onclick: () => choose(p.id), contextmenu: e => { e.preventDefault(); tryIcon(p.id); } }, img,
    h('div', { class: 'card-t' }, p.name),
    h('div', { class: 'card-m' }, h('span', { class: 'card-ld' }, ldLabel(p)),
      h('span', {}, `${(state.modCounts && state.modCounts[p.id]) || 0} mods · ${p.mc}`)));
  c.style.setProperty('--ph', hueOf(p));
  return c;
}
function renderHome() {
  if (!state) return;
  const q = $('#homeSearch').value.trim().toLowerCase();
  const list = state.settings.profiles.filter(p => p.name.toLowerCase().includes(q));
  $('#homeContinue').replaceChildren(card(activeProfile()));
  const add = h('button', { class: 'card add', type: 'button', onclick: () => ownerOnly(() => { openSheet('create'); initCreate(); }) },
    h('div', { class: 'card-img' }, '+'), h('div', { class: 'card-t' }, 'Crear modpack'));
  $('#homeAll').replaceChildren(...list.map(card), ...(owner.player ? [] : [add]));
  if (!list.length) $('#homeAll').prepend(h('div', { class: 'empty' }, 'Ningún modpack coincide.'));
}

// ---------- crear modpack: lista de versiones ----------
let verData = null, selMc = '1.20.1', loader = 'forge';
const forgeList = () => (verData && verData.forge[selMc]) || [];
function paintForge() {
  const vs = forgeList();
  $('#ldForge').disabled = !vs.length;
  if (!vs.length) loader = 'vanilla';
  $('#ldForge').classList.toggle('on', loader === 'forge');
  $('#ldVanilla').classList.toggle('on', loader === 'vanilla');
  $('#ldFabric').classList.toggle('on', loader === 'fabric');
  $('#forgeRow').classList.toggle('hidden', loader !== 'forge');
  $('#newForge').replaceChildren(...vs.map((v, i) => h('option', { value: v }, i === 0 ? v + ' (última)' : v)));
}
function paintMc() {
  if (!verData) return;
  const q = $('#mcSearch').value.trim();
  const list = verData.mc.filter(v => v.type === 'release' && v.id.includes(q));
  $('#mcCount').textContent = list.length ? '· ' + list.length + ' versiones' : '';
  const pills = list.map(v => h('button', { class: 'mc-pill' + (v.id === selMc ? ' on' : ''), type: 'button', onclick: () => { selMc = v.id; if (loader === 'vanilla' && forgeList().length) loader = 'forge'; paintForge(); paintMc(); } },
    v.id, (verData.forge[v.id] || []).length ? h('i', { class: 'dot' }) : null));
  $('#mcList').replaceChildren(...pills);
  if (!pills.length) $('#mcList').textContent = 'Sin resultados';
}
async function initCreate() {
  $('#createMsg').textContent = '';
  if (verData) return;
  $('#mcList').textContent = 'Cargando versiones…';
  verData = await api.getVersions();
  if (!verData.mc.some(v => v.id === selMc)) selMc = (verData.mc.find(v => v.type === 'release') || {}).id || selMc;
  paintForge(); paintMc();
  if (verData.offline) $('#createMsg').textContent = 'Sin internet: se muestra una lista corta.';
}
$('#mcSearch').addEventListener('input', paintMc);
$('#ldForge').addEventListener('click', () => { loader = 'forge'; paintForge(); });
$('#ldVanilla').addEventListener('click', () => { loader = 'vanilla'; paintForge(); });
$('#ldFabric').addEventListener('click', () => { loader = 'fabric'; paintForge(); });

// ---------- detalles del modpack ----------
const ago = ms => { if (!ms) return '—'; const d = Math.floor((Date.now() - ms) / 864e5); return d <= 0 ? 'hoy' : d === 1 ? 'ayer' : `hace ${d} días`; };
const row = (k, v, mono) => h('div', { class: 'irow' }, h('span', { class: 'ik' }, k), h('span', { class: 'iv' }, v));
// Fila MODS con flechita: al tocarla abre la página con la lista de mods.
function modsRows(mods) {
  const label = `MODS (${mods.length})`;
  if (!mods.length) return row(label, 'ninguno');
  return h('button', { class: 'irow mods-toggle', type: 'button', title: 'Ver mods', onclick: openMods },
    h('span', { class: 'ik' }, label), h('span', { class: 'iv' }, h('span', { class: 'chev' })));
}
async function openMods() {
  const p = activeProfile();
  const list = await api.profileMods(p.id);
  $('#modsTitle').textContent = `Mods (${list.length})`;
  $('#modsPanel').replaceChildren(...(list.length ? list.map(m => {
    const ico = h('div', { class: 'mod-ico' }, m.icon ? h('img', { src: m.icon, alt: '' }) : (m.name[0] || '?').toUpperCase());
    return h('div', { class: 'mod-item' }, ico,
      h('div', { class: 'mod-txt' },
        h('div', { class: 'mod-name' }, m.name, m.author ? h('span', { class: 'mod-by' }, ' por ' + m.author) : null),
        h('div', { class: 'mod-ver' }, m.version || m.file)),
      h('div', { class: 'mod-size' }, (m.size / 1048576).toFixed(1) + ' MB'));
  }) : [h('div', { class: 'empty' }, 'Este modpack no tiene mods todavía.')]));
  $('#modsPage').classList.remove('hidden'); $('#modsPage').scrollTop = 0;
}
const closeMods = () => $('#modsPage').classList.add('hidden');
$('#modsBack').addEventListener('click', closeMods);
async function paintInfo() {
  const p = activeProfile();
  const i = await api.profileInfo(p.id);
  if (!i || p.id !== activeProfile().id) return;
  $('#infoRows').replaceChildren(
    row('MC', p.mc), row('CARGADOR', p.forge ? 'FORGE ' + p.forge : p.loader === 'fabric' ? 'FABRIC' + (p.fabric ? ' ' + p.fabric : '') : 'VANILLA'), row('JAVA', 'Java ' + i.java),
    row('RAM CONFIG.', state.settings.ramMax + '.0 GB'), modsRows(i.mods),
    row('ACTUALIZADO', ago(i.updated)), row('CREADO', ago(i.created)));
}

// ---------- modo creador ----------
let owner = { hasPassword: false, unlocked: false };
const tryIcon = id => ownerOnly(() => changeIcon(id));
async function changeBanner(id) {
  const res = await api.chooseBanner(id);
  if (res.ok) { state = res.state; render(); setStatus('Portada actualizada.'); }
  else if (!res.canceled) setStatus(res.error);
}
$('#btnBanner').addEventListener('click', () => ownerOnly(() => changeBanner(state.settings.activeProfile)));
$('#heroBack').addEventListener('click', () => { showView('home'); renderHome(); });
async function changeLogo(id) {
  const res = await api.chooseLogo(id);
  if (res.ok) { state = res.state; render(); setStatus('Logo actualizado.'); }
  else if (!res.canceled) setStatus(res.error);
}
$('#btnLogo').addEventListener('click', () => ownerOnly(() => changeLogo(state.settings.activeProfile)));
async function changeIcon(id) {
  const res = await api.chooseIcon(id);
  if (res.ok) { state = res.state; render(); setStatus('Foto actualizada.'); }
  else if (!res.canceled) setStatus(res.error);
}
async function refreshOwner() {
  owner = await api.ownerStatus();
  document.body.classList.toggle('player', !!owner.player);
  document.body.classList.toggle('creator', !owner.player);
  $('#ownerInfo').textContent = !owner.hasPassword ? 'Aún no hay contraseña de creador. Crea una para que nadie más pueda cambiar los modpacks.' : owner.unlocked ? 'Modo creador activo: puedes editar. Bloquea al terminar.' : 'Bloqueado: solo el creador puede crear, editar o quitar modpacks, mods y fotos.';
  $('#ownerBtn').textContent = owner.hasPassword ? 'Desbloquear' : 'Crear contraseña';
  $('#ownerBtn').classList.toggle('hidden', owner.unlocked);
  $('#ownerPw').closest('label').classList.toggle('hidden', owner.unlocked);
  $('#ownerLock').classList.toggle('hidden', !owner.unlocked);
}
$('#ownerBtn').addEventListener('click', async () => {
  const pw = $('#ownerPw').value;
  const res = owner.hasPassword ? await api.ownerUnlock(pw) : await api.ownerSetup(pw);
  $('#ownerPw').value = '';
  await refreshOwner(); if (state) render();
  setStatus(res.ok ? 'Modo creador activo.' : res.error);
});
$('#ownerLock').addEventListener('click', async () => { await api.ownerLock(); await refreshOwner(); render(); setStatus('Modo creador bloqueado.'); });

// ---------- candado: pedir contraseña antes de cambiar nada ----------
let pendingOwner = null;
async function ownerOnly(fn) {
  await refreshOwner();
  if (owner.player) return setStatus('Solo el creador puede hacer esto.');
  if (owner.unlocked) return fn();
  pendingOwner = fn;
  $('#unlockMsg').textContent = owner.hasPassword ? 'Escribe la contraseña de creador para continuar.' : 'Aún no hay contraseña de creador. Crea una (mínimo 6 caracteres) para proteger los modpacks.';
  $('#unlockBtn').textContent = owner.hasPassword ? 'Desbloquear' : 'Crear contraseña';
  $('#unlockPw').value = '';
  openSheet('unlock');
  setTimeout(() => $('#unlockPw').focus(), 50);
}
async function submitUnlock() {
  const pw = $('#unlockPw').value;
  const res = owner.hasPassword ? await api.ownerUnlock(pw) : await api.ownerSetup(pw);
  $('#unlockPw').value = '';
  if (!res.ok) { $('#unlockMsg').textContent = res.error; return; }
  await refreshOwner(); closeSheet();
  const fn = pendingOwner; pendingOwner = null;
  setStatus('Modo creador activo.');
  if (fn) fn();
}
$('#unlockBtn').addEventListener('click', submitUnlock);
$('#unlockPw').addEventListener('keydown', e => { if (e.key === 'Enter') submitUnlock(); });
// Botones que piden contraseña: se intercepta el clic y, al desbloquear, se repite solo.
for (const id of ['#btnCreate', '#btnFolder', '#btnMods', '#btnEdit', '#btnRemove']) {
  $(id).addEventListener('click', e => {
    if (owner.unlocked) return;
    e.stopImmediatePropagation();
    ownerOnly(() => $(id).click());
  }, true);
}

// ---------- acciones ----------
$('#btnFolder').addEventListener('click', () => api.openProfileFolder(state.settings.activeProfile));
api.onPublishProgress(m => setStatus(m));
async function paintGh() { api.socialStatus().then(x => { $('#socialUrl').value = x.url || ''; }); const c = await api.pubGet(); $('#ghUser').value = c.user; $('#ghRepo').value = c.repo; $('#ghToken').value = ''; $('#ghToken').placeholder = c.broken ? 'El token guardado no se pudo leer: pega uno NUEVO' : c.hasToken ? '(guardado; pega uno nuevo solo si quieres cambiarlo)' : 'pega tu token'; }
$('#ghSave').addEventListener('click', async () => {
  const r = await api.pubSet({ user: $('#ghUser').value, repo: $('#ghRepo').value, token: $('#ghToken').value });
  setStatus(r.ok ? 'Conexión con GitHub guardada. ' + ((r.check && r.check.msg) || '') : r.error); if (r.ok) paintGh();
});
$('#cardPublish').addEventListener('click', () => ownerOnly(() => $('#publishPack').click()));
$('#publishPack').addEventListener('click', async () => {
  $('#publishPack').disabled = true;
  const r = await api.publishPack();
  $('#publishPack').disabled = false;
  setStatus(!r.ok ? r.error : r.manual ? `Listo: ${r.count} archivos en ${r.dir}. Conecta GitHub aquí abajo para que se suba solo.`
    : `Publicado: ${r.uploaded} de ${r.total} archivos subidos. Los jugadores lo reciben al abrir el launcher.`
      + (r.external && r.external.length ? ` (${r.external.length} mod(s) pesado(s) los bajan ellos desde Modrinth.)` : '')
      + (r.skipped && r.skipped.length ? ` OJO: no se subieron por pesar más de 95 MB: ${r.skipped.join(', ')}.` : ''));
});
$('#exportPack').addEventListener('click', async () => {
  setStatus('Preparando el modpack para compartir…');
  const r = await api.exportPack();
  setStatus(r.ok ? `Modpack listo (versión ${r.version}). Ahora usa Crear_EXE.bat.` : r.error);
});
$('#btnMods').addEventListener('click', async () => {
  busy = true; setBusy(true);
  $('#progressBox').classList.remove('hidden');
  const r = await api.installMenuMods();
  busy = false; state = await api.getState(); render();
  if (r.ok) setStatus('Mods de menú instalados: ' + r.installed.join(', '));
  else setStatus(r.error);
});
$('#btnEdit').addEventListener('click', () => {
  const p = activeProfile();
  $('#editName').value = p.name;
  $('#editServer').value = p.server || '';
  openSheet('edit');
});
$('#saveEdit').addEventListener('click', async () => {
  const r = await api.updateProfile({ id: state.settings.activeProfile, name: $('#editName').value, server: $('#editServer').value });
  if (r.ok) { state = r.state; render(); closeSheet(); setStatus('Modpack actualizado.'); } else setStatus(r.error);
});
$('#btnIcon').addEventListener('click', () => tryIcon(state.settings.activeProfile));
$('#btnRemove').addEventListener('click', async () => {
  const p = activeProfile();
  if (!confirm(`¿Quitar "${p.name}" de la lista?\nSu carpeta (mundos y mods) NO se borra.`)) return;
  const r = await api.deleteProfile(p.id);
  if (!r.ok) setStatus(r.error); else { state = r.state; render(); }
});

async function doLogin() {
  setStatus('Abriendo inicio de sesión de Microsoft…');
  const r = await api.login();
  if (r.ok) { state = r.state; render(); setStatus('Sesión iniciada.'); } else setStatus(r.error);
}

// Nombre de jugador no premium (3-16 letras, números o _). Devuelve true si quedó guardado.
async function saveOfflineName() {
  const box = $('#offlineQuick');
  const v = box.value.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(v)) {
    box.classList.add('bad');
    setStatus('Nombre inválido: 3-16 letras, números o _ (sin espacios ni tildes).');
    return false;
  }
  box.classList.remove('bad');
  if (v !== state.settings.offlineName) { state = await api.updateSettings({ offlineName: v }); render(); }
  return true;
}
$('#offlineQuick').addEventListener('change', async () => { if (await saveOfflineName()) setStatus('Nombre guardado: ' + $('#offlineQuick').value.trim()); });

// ---------- esquina inferior izquierda: descarga y "En marcha" ----------
function hudShow() { /* el progreso ahora solo se ve en la tarjeta de lanzamiento, abajo a la derecha */ }
// "Jugar" al pasar el cursor por una tarjeta del Inicio: elige ese modpack y lo lanza sin salir de la pantalla.
async function quickPlay(id) {
  if (busy || state.running) { setStatus('Ya hay una instancia en marcha.'); return; }
  state = await api.updateSettings({ activeProfile: id });
  render();
  play(state.account ? 'online' : 'offline');
}

async function play(mode) {
  if (mode === 'offline' && !(await saveOfflineName())) return;
  busy = true; setBusy(true);
  $('#progressBox').classList.remove('hidden');
  const r = await api.play(mode);
  busy = false;
  state = await api.getState();
  render();
  if (!r.ok) setStatus(r.error);
}

// ---------- eventos del proceso principal ----------
// Cronómetro de la tarjeta de lanzamiento (mm:ss desde que empieza a prepararse el juego)
let lcT0 = 0, lcTimer = null;
function lcTick() { const s = Math.floor((Date.now() - lcT0) / 1000); $('#lcTime').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
function lcRun(on) {
  if (on && !lcTimer) { lcT0 = Date.now(); lcTick(); lcTimer = setInterval(lcTick, 1000); }
  if (!on && lcTimer) { clearInterval(lcTimer); lcTimer = null; }
}
$('#btnDetails').addEventListener('click', () => document.querySelector('.page').classList.toggle('details-open'));
$('#btnMore').addEventListener('click', e => { e.stopPropagation(); document.querySelector('.page').classList.toggle('tools-open'); });
document.addEventListener('click', () => document.querySelector('.page').classList.remove('tools-open'));

api.onProgress(({ stage, message, percent }) => {
  lcRun(stage !== 'idle' && stage !== 'playing' && stage !== 'error');
  $('#launchCard').classList.toggle('launching', stage !== 'idle' && stage !== 'playing' && stage !== 'error');
  $('#progressBox').classList.toggle('hidden', stage === 'idle');
  $('#progressText').textContent = message;
  const bar = $('#progressBar');
  bar.classList.toggle('indeterminate', percent == null && stage !== 'playing' && stage !== 'error');
  bar.classList.toggle('error', stage === 'error');
  bar.style.width = stage === 'playing' ? '100%' : (percent == null ? '' : percent + '%');
  setStatus(message);
  hudShow(stage, message, percent);
});

const con = $('#console');
api.onLog(line => {
  con.append(line + '\n');
  while (con.childNodes.length > 800) con.removeChild(con.firstChild);
  con.scrollTop = con.scrollHeight;
});
// Cuando termina una actualización (boot o antes de jugar), se vuelve a leer el estado para ver portada, fotos, servidor y mods nuevos al instante.
api.onRefresh(async () => { try { state = await api.getState(); render(); socialInit(); } catch { /* se verá al reabrir */ } });
api.onClosed(async () => { state = await api.getState(); render(); });

// ---------- controles ----------
$('#play').addEventListener('click', () => play('online'));
$('#playOffline').addEventListener('click', () => play('offline'));
$('#login').addEventListener('click', doLogin);
$('#settingsLogin').addEventListener('click', doLogin);
$('#logout').addEventListener('click', async () => { state = await api.logout(); render(); setStatus('Sesión cerrada.'); });

$('#createPack').addEventListener('click', async () => {
  const r = await api.createProfile({ name: $('#newName').value.trim() || ('Minecraft ' + selMc), mc: selMc, forge: loader === 'forge' ? $('#newForge').value : '', loader: loader === 'fabric' ? 'fabric' : '', server: $('#newServer').value });
  if (r.ok) { state = r.state; $('#newName').value = ''; $('#newServer').value = ''; render(); closeSheet(); setStatus('Modpack creado.'); }
  else { setStatus(r.error); $('#createMsg').textContent = r.error; }
});

$('#ram').addEventListener('input', e => { $('#ramValue').textContent = e.target.value; });
$('#ram').addEventListener('change', async e => { state = await api.updateSettings({ ramMax: Number(e.target.value) }); render(); });
$('#alwaysOffline').addEventListener('change', async e => { state = await api.updateSettings({ alwaysOffline: e.target.checked }); render(); });
$('#fullscreen').addEventListener('change', async e => { state = await api.updateSettings({ fullscreen: e.target.checked }); render(); });
$('#loginMode').addEventListener('change', async e => { state = await api.updateSettings({ loginMode: e.target.value }); render(); });
$('#forgeMode').addEventListener('change', async e => { state = await api.updateSettings({ forgeMode: e.target.value }); render(); });
$('#offlineName').addEventListener('change', async e => {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(e.target.value)) setStatus('Nombre inválido: 3-16 letras, números o _.');
  state = await api.updateSettings({ offlineName: e.target.value }); render();
});
$('#javaChoose').addEventListener('click', async () => { const r = await api.chooseJava(); if (!r.canceled) { state = r.state; render(); } });
$('#javaAuto').addEventListener('click', async () => { state = await api.updateSettings({ javaPath: '' }); render(); });
$('#javaCheck').addEventListener('click', async () => {
  setStatus('Buscando Java…');
  const { need, found } = await api.checkJava();
  $('#javaInfo').textContent = found ? `Encontrado para el modpack activo (necesita Java ${need}): ${found.path}` : `No se encontró Java ${need}. Se descargará al pulsar JUGAR.`;
  setStatus('Listo.');
});
$('#openData').addEventListener('click', () => api.openDataFolder());
$('#restoreApp').addEventListener('click', async () => { const r = await api.appRestore(); if (r && !r.ok) setStatus(r.error); });
api.onAppUpdate(m => setStatus(m));
$('#repairMc').addEventListener('click', async () => {
  setStatus('Reparando…');
  const r = await api.repair();
  setStatus(r.ok ? 'Reparado. Pulsa Jugar: se volverán a bajar los archivos que faltaban.' : r.error);
});
$('#clearConsole').addEventListener('click', () => { con.textContent = ''; });

// ---------- pantalla de inicio ----------
const splash = $('#splash');
$('#splashLogo').addEventListener('error', e => e.target.classList.add('hidden'));
let splashGone = false;
function hideSplash() {
  if (splashGone) return; splashGone = true;
  splash.classList.add('out');
  setTimeout(() => splash.classList.add('hidden'), 700);
}
splash.addEventListener('click', hideSplash);

// Las pantallas de inicio y carga no se pueden seleccionar, copiar ni arrastrar.
for (const el of [$('#intro'), $('#splash')]) for (const ev of ['selectstart', 'dragstart', 'copy', 'cut', 'contextmenu']) el.addEventListener(ev, e => e.preventDefault());

// Pantalla de inicio: solo logo y nombre. Después pasa a la pantalla de carga (con barra).
const intro = $('#intro');
$('#introLogo').addEventListener('error', e => e.target.classList.add('hidden'));
let introGone = false;
function hideIntro() {
  if (introGone) return; introGone = true;
  splash.classList.remove('wait');
  intro.classList.add('out');
  setTimeout(() => intro.classList.add('hidden'), 700);
  setTimeout(hideSplash, 1700);
}
intro.addEventListener('click', hideIntro);
setTimeout(hideIntro, 2000);

(async () => {
  state = await api.getState(); await refreshOwner(); render();
  window.__chiletReady = true;   // boot.js lo comprueba: si una actualización no llega aquí, se descarta sola
})();

// =====================================================================================
// v2.0: social (chat), likes, perfil y eventos
// =====================================================================================
const social = { on: false, me: null, friends: [], incoming: [], msgs: [], seq: 0, first: true, active: null, unread: {}, ratings: {}, local: [], faces: new Map() };
const sc = (p, b) => api.socialCall(p, b);
const fmtTime = ms => ms < 3600000 ? Math.max(1, Math.round(ms / 60000)) + ' min' : (ms / 3600000).toFixed(1) + ' h';
function ldLabel(p) {
  const ld = p.forge ? 'Forge' : p.loader === 'fabric' ? 'Fabric' : 'Vanilla', r = social.ratings[p.id];
  return r && r.pct != null ? `${ld} · ${r.pct}%` : ld;
}
function faceInto(box, name) {
  box.textContent = (name[0] || '?').toUpperCase();
  const k = name.toLowerCase();
  if (!social.faces.has(k)) social.faces.set(k, api.faceGet(name));
  social.faces.get(k).then(url => { if (url) box.replaceChildren(h('img', { src: url, alt: '' })); }).catch(() => {});
}
async function socialInit() {
  const s = await api.socialStatus(), was = social.on;
  social.on = s.on;
  $('#socialLocal').classList.toggle('hidden', social.on); $('#socialChat').classList.toggle('hidden', !social.on);
  if (social.on && !was) { await socialSync(); ratingsLoad(); }
  if (state) { renderHome(); paintRate(); }
  paintHomeFriends();
}
async function socialSync() {
  if (!social.on || document.hidden) return;
  const r = await sc('/sync', { since: social.seq });
  if (r.error) { social.err = r.error; return; }
  social.err = ''; social.me = r.me; social.friends = r.friends; social.incoming = r.incoming;
  for (const m of r.msgs) if (!social.msgs.some(x => x.seq === m.seq)) {
    social.msgs.push(m);
    if (!social.first && m.to === r.me.id && !(currentView === 'social' && social.active === m.from)) social.unread[m.from] = (social.unread[m.from] || 0) + 1;
  }
  social.first = false; social.seq = r.seq;
  $('#btnSocial').classList.toggle('dot', Object.values(social.unread).some(n => n > 0) || social.incoming.length > 0);
  paintHomeFriends();
  if (currentView === 'social') paintChat();
}
function paintChat() {
  $('#cfReq').replaceChildren(...social.incoming.map(u => h('div', { class: 'req' }, h('span', {}, u.name + ' quiere ser tu amigo'),
    h('button', { class: 'chip', type: 'button', onclick: async () => { await sc('/friends/accept', { id: u.id }); socialSync(); } }, 'Aceptar'),
    h('button', { class: 'chip danger', type: 'button', onclick: async () => { await sc('/friends/decline', { id: u.id }); socialSync(); } }, 'Rechazar'))));
  $('#cfList').replaceChildren(...(social.friends.length ? social.friends.map(f => {
    const face = h('div', { class: 'friend-face sm' }); faceInto(face, f.name);
    const n = social.unread[f.id] || 0;
    return h('button', { class: 'cf' + (social.active === f.id ? ' on' : ''), type: 'button', onclick: () => openChat(f.id) }, face,
      h('span', { class: 'cf-name' }, f.name), h('i', { class: 'cf-dot' + (f.online ? ' online' : '') }), n ? h('b', { class: 'cf-n' }, String(n)) : null);
  }) : [h('div', { class: 'empty' }, 'Aún no tienes amigos. Agrega a alguien que también use el launcher.')]));
  paintLog();
}
function paintLog() {
  const f = social.friends.find(x => x.id === social.active), me = social.me;
  $('#chatInput').disabled = $('#chatSend').disabled = !f;
  $('#chatHead').textContent = f ? `${f.name} · ${f.online ? 'En línea' : 'Desconectado'}` : 'Elige un amigo para chatear';
  if (!f || !me) { $('#chatLog').replaceChildren(); return; }
  const log = $('#chatLog'), atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const list = social.msgs.filter(m => m.from === f.id || m.to === f.id).sort((a, b) => a.seq - b.seq);
  log.replaceChildren(...(list.length ? list.map(m => h('div', { class: 'msg' + (m.from === me.id ? ' mine' : '') }, h('div', { class: 'bub' }, m.text), h('span', { class: 'msg-t' }, new Date(m.t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })))) : [h('div', { class: 'empty' }, 'Escríbele el primer mensaje.')]));
  if (atEnd) log.scrollTop = log.scrollHeight;
}
async function openChat(id) {
  social.active = id; social.unread[id] = 0;
  const hst = await sc('/history', { with: id });
  for (const m of hst.msgs || []) if (!social.msgs.some(x => x.seq === m.seq)) social.msgs.push(m);
  paintChat(); $('#chatLog').scrollTop = $('#chatLog').scrollHeight; $('#chatInput').focus();
  $('#btnSocial').classList.toggle('dot', Object.values(social.unread).some(n => n > 0) || social.incoming.length > 0);
}
async function sendChat() {
  const inp = $('#chatInput'), text = inp.value.trim();
  if (!text || !social.active) return;
  inp.value = '';
  const r = await sc('/send', { to: social.active, text });
  if (r.error) { setStatus(r.error); inp.value = text; return; }
  await socialSync(); $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}
async function addServerFriend() {
  const inp = $('#cfName'); if (!inp.value.trim()) return;
  const r = await sc('/friends/request', { name: inp.value.trim() });
  const m = $('#cfMsg'); m.classList.toggle('bad', !!r.error);
  m.textContent = r.error ? r.error : r.friends ? '¡Ya son amigos!' : 'Solicitud enviada.';
  if (!r.error) inp.value = '';
  socialSync();
}
$('#cfAdd').addEventListener('click', addServerFriend);
$('#cfName').addEventListener('keydown', e => { if (e.key === 'Enter') addServerFriend(); });
$('#chatSend').addEventListener('click', sendChat);
$('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

// --- franja de amigos arriba del Inicio ---
function paintHomeFriends() {
  const box = $('#homeFriends'); if (!box) return;
  const list = social.on ? social.friends : social.local;
  const add = h('button', { class: 'hf add', type: 'button', onclick: openSocial }, h('div', { class: 'hf-face' }, '+'), h('span', {}, 'Agregar'));
  box.replaceChildren(add, ...list.slice(0, 14).map(f => {
    const face = h('div', { class: 'hf-face' });
    if (f.avatar) face.append(h('img', { src: f.avatar, alt: '' })); else faceInto(face, f.name);
    if (social.on && f.online) face.append(h('i', { class: 'cf-dot online' }));
    return h('button', { class: 'hf', type: 'button', title: f.name, onclick: async () => { await openSocial(); if (social.on) openChat(f.id); } }, face, h('span', {}, f.name));
  }));
}

// --- likes y puntuación ---
async function ratingsLoad() {
  if (!social.on || !state) return;
  const r = await sc('/ratings', { packs: state.settings.profiles.map(p => p.id) });
  if (r.ratings) { social.ratings = r.ratings; renderHome(); paintRate(); }
}
function paintRate() {
  const box = $('#rate'); if (!box || !state) return;
  box.classList.toggle('hidden', !social.on);
  if (!social.on) return;
  const r = social.ratings[activeProfile().id] || { up: 0, down: 0, pct: null, mine: 0 };
  $('#ratePct').textContent = r.pct == null ? 'Sin votos' : `${r.pct}%  (${r.up + r.down})`;
  $('#likeUp').classList.toggle('on', r.mine === 1); $('#likeDown').classList.toggle('on', r.mine === -1);
}
async function vote(v) {
  const id = activeProfile().id, mine = (social.ratings[id] || {}).mine || 0;
  const r = await sc('/like', { pack: id, v: mine === v ? 0 : v });
  if (r.error) setStatus(r.error);
  ratingsLoad();
}
$('#likeUp').addEventListener('click', () => vote(1));
$('#likeDown').addEventListener('click', () => vote(-1));

// --- perfil ---
async function openProfile() {
  closeMods(); showView('profile');
  const d = await api.profileMe();
  $('#profName').textContent = d.name; $('#profSub').textContent = d.premium ? 'Cuenta de Microsoft' : 'Jugador no premium';
  $('#profFace').replaceChildren(d.avatar ? h('img', { src: d.avatar, alt: '' }) : (d.name[0] || '?').toUpperCase());
  $('#statHours').textContent = d.totalMs ? fmtTime(d.totalMs) : '0 min'; $('#statPlays').textContent = d.plays; $('#statPacks').textContent = d.packs.length;
  $('#statFriends').textContent = social.on ? social.friends.length : social.local.length;
  $('#profGames').replaceChildren(...(d.packs.length ? d.packs.map(g => h('div', { class: 'game' }, h('div', { class: 'game-ico' }, initials(g.name)),
    h('div', { class: 'game-txt' }, h('div', { class: 'game-name' }, g.name), h('div', { class: 'game-sub' }, `${g.loader} ${g.mc} · ${g.plays} partida${g.plays === 1 ? '' : 's'} · ${fmtTime(g.ms)}`)),
    h('div', { class: 'game-last' }, 'Última vez: ' + new Date(g.last).toLocaleDateString()))) : [h('div', { class: 'empty' }, 'Todavía no has jugado nada. ¡Pulsa Jugar en un modpack!')]));
}
$('#btnProfile').addEventListener('click', openProfile);

// --- eventos ---
let evList = [];
const whenText = iso => { const diff = Date.parse(iso) - Date.now(); if (diff < 0) return 'Ya pasó'; const d = Math.floor(diff / 864e5); return d >= 2 ? `En ${d} días` : d === 1 ? 'Mañana' : diff >= 36e5 ? `En ${Math.floor(diff / 36e5)} h` : 'Muy pronto'; };
function paintEvents() {
  const now = Date.now(), sorted = [...evList].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const up = sorted.filter(e => Date.parse(e.date) >= now), past = sorted.filter(e => Date.parse(e.date) < now).reverse();
  const row = e => {
    const d = new Date(e.date);
    const el = h('div', { class: 'ev' + (Date.parse(e.date) < now ? ' past' : '') }, h('div', { class: 'ev-date' }, h('b', {}, String(d.getDate())), h('span', {}, d.toLocaleString('es', { month: 'short' }).toUpperCase())),
      h('div', { class: 'ev-txt' }, h('div', { class: 'ev-title' }, e.title), h('div', { class: 'ev-when' }, d.toLocaleString('es', { weekday: 'long', hour: '2-digit', minute: '2-digit' }) + ' · ' + whenText(e.date)), e.desc ? h('div', { class: 'ev-desc' }, e.desc) : null));
    if (!owner.player) el.append(h('button', { class: 'chip danger', type: 'button', onclick: () => ownerOnly(async () => { const r = await api.eventsSave(evList.filter(x => x.id !== e.id)); if (r.ok) { evList = r.events; paintEvents(); } else setStatus(r.error); }) }, 'Quitar'));
    return el;
  };
  $('#evList').replaceChildren(...(up.length ? up.map(row) : [h('div', { class: 'empty' }, 'No hay eventos próximos.')]), ...(past.length ? [h('div', { class: 'home-sec' }, 'ANTERIORES'), ...past.map(row)] : []));
}
async function openEvents() { closeMods(); showView('events'); await refreshOwner(); evList = await api.eventsList(); $('#evNew').classList.toggle('hidden', !!owner.player); paintEvents(); }
$('#btnEvents').addEventListener('click', openEvents);
$('#evNew').addEventListener('click', () => ownerOnly(() => $('#evForm').classList.toggle('hidden')));
$('#evCancel').addEventListener('click', () => $('#evForm').classList.add('hidden'));
$('#evSave').addEventListener('click', async () => {
  const title = $('#evTitle').value.trim(), date = $('#evDate').value;
  if (!title || !date) { setStatus('Pon un título y una fecha para el evento.'); return; }
  const r = await api.eventsSave([...evList, { title, date: new Date(date).toISOString(), desc: $('#evDesc').value }]);
  if (!r.ok) { setStatus(r.error); return; }
  evList = r.events; paintEvents(); $('#evForm').classList.add('hidden'); $('#evTitle').value = $('#evDesc').value = ''; setStatus('Evento guardado. Pulsa "Publicar actualización" para que les llegue a todos.');
});
$('#socialSave').addEventListener('click', async () => {
  const r = await api.socialSetUrl($('#socialUrl').value);
  setStatus(r.ok ? 'Servidor social guardado.' : r.error); if (r.ok) socialInit();
});

socialInit(); setInterval(socialSync, 4000); setInterval(ratingsLoad, 60000);
