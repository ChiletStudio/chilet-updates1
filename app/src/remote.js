// Actualizaciones remotas del modpack. El creador PUBLICA una carpeta (latest.json + files/...) en cualquier hosting https
// (por ejemplo un repositorio de GitHub). Las versiones de jugador la comparan al abrir y antes de jugar y descargan solo lo que cambió.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const settings = require('./settings');

const DIRS = ['mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks'];
const ICONS = ['icon.png', 'icon.jpg', 'icon.gif', 'icon.webp', 'icon.mp4', 'icon.webm', 'banner.png', 'banner.jpg', 'banner.gif', 'banner.webp', 'banner.mp4', 'banner.webm', 'logo.png', 'logo.jpg', 'logo.gif', 'logo.webp'];
const ID = /^[A-Za-z0-9_-]{1,40}$/, MC = /^\d+\.\d+(\.\d+)?$/, FORGE = /^\d+(\.\d+){1,3}$/, SERVER = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;
// Mods muy pesados con licencia que no permite repartirlos fuera de Modrinth/CurseForge (WaterMedia y sus binarios, 137 MB):
// NO se suben a GitHub; el manifiesto guarda su sha1 y cada jugador los baja directo de Modrinth.
const EXTERNAL = /^(watermedia|waterbinaries)/i;
const MAX_FILE = 95 * 1024 * 1024;
const MR = 'https://api.modrinth.com/v2';
const MR_HEADERS = { 'User-Agent': 'ChiletStudio/1.2 (launcher)' };
const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');
const okRel = rel => typeof rel === 'string' && !rel.includes('..') && !path.isAbsolute(rel) && !rel.includes('\\') && (ICONS.includes(rel) || DIRS.includes(rel.split('/')[0]) && rel.includes('/'));
const inside = (root, p) => { const r = path.relative(root, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

function walk(dir, base, out = []) {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

// CREADOR: huella de lo que se publicaría (mods, config, iconos y datos del modpack). Si no cambió desde la última publicación, no hay nada que subir.
// Mods y archivos grandes: nombre + tamaño + fecha. Config pequeña: contenido (así no cuenta que el juego la reescriba igual).
function fingerprint(profile, extra = '') {
  const inst = paths.instance(profile.id);
  const rels = [...DIRS.flatMap(d => walk(path.join(inst, d), inst)), ...ICONS.filter(i => fs.existsSync(path.join(inst, i)))].filter(r => okRel(r) && !/\.(db|log)$/i.test(r)).sort();
  const h = crypto.createHash('sha1');
  h.update(JSON.stringify([profile.name, profile.mc, profile.forge || '', profile.server || '', profile.loader || '', profile.fabric || '', extra]));
  for (const rel of rels) {
    const abs = path.join(inst, rel);
    try {
      const st = fs.statSync(abs);
      if (rel.startsWith('mods/') || st.size > 2 * 1024 * 1024) h.update(`${rel}|${st.size}|${Math.floor(st.mtimeMs)}\n`);
      else h.update(`${rel}|${st.size}|${sha1(fs.readFileSync(abs))}\n`);
    } catch { /* el archivo cambió mientras se leía: la próxima vez */ }
  }
  return h.digest('hex');
}

// CREADOR: genera outDir/latest.json + outDir/files/... a partir del modpack activo.
function publish(profile, outDir, extras = {}) {
  const inst = paths.instance(profile.id);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'files'), { recursive: true });
  const rels = [...DIRS.flatMap(d => walk(path.join(inst, d), inst)), ...ICONS.filter(i => fs.existsSync(path.join(inst, i)))].filter(r => okRel(r) && !/\.(db|log)$/i.test(r));
  const external = [], skipped = [];
  const files = rels.filter(rel => {
    const abs = path.join(inst, rel), name = rel.split('/').pop();
    if (rel.startsWith('mods/') && EXTERNAL.test(name)) {
      external.push({ filename: name, size: fs.statSync(abs).size, sha1: crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex') });
      return false;
    }
    if (fs.statSync(abs).size > MAX_FILE) { skipped.push(rel); return false; }
    return true;
  }).map(rel => {
    const buf = fs.readFileSync(path.join(inst, rel));
    const dest = path.join(outDir, 'files', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf);
    return { p: rel, size: buf.length, sha1: sha1(buf) };
  });
  const manifest = { version: Math.floor(Date.now() / 1000), profile: { id: profile.id, name: profile.name, mc: profile.mc, forge: profile.forge || '', server: profile.server || '', loader: profile.loader || '', fabric: profile.fabric || '' }, files, external, social: extras.social || '' };
  if (extras.app) {   // código del launcher firmado: viaja junto al modpack (ver appupdate.js)
    for (const f of extras.app.files) { const dest = path.join(outDir, 'app', ...f.p.split('/')); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(f.abs, dest); }
    manifest.app = extras.app.a;
  }
  fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(extras.events || []));
  fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(manifest, null, 1));
  return { count: files.length, external, skipped };
}

// CREADOR: comprueba que cada mod "externo" exista en Modrinth (si no, los jugadores no podrían bajarlo).
async function verifyExternal(external) {
  for (const e of external) {
    const r = await fetch(`${MR}/version_file/${e.sha1}?algorithm=sha1`, { headers: MR_HEADERS, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) throw new Error(`${e.filename} no está en Modrinth (¿lo bajaste de CurseForge?). Bájalo de Modrinth para poder repartirlo.`);
    if (!r.ok) throw new Error(`Modrinth respondió ${r.status}; inténtalo de nuevo.`);
  }
}

// JUGADOR: compara con el latest.json remoto y descarga lo que falte o haya cambiado. Devuelve cuántos cambios hizo.
// Descarga varios archivos a la vez (rápido) y avisa del avance.
async function pool(tasks, n, onStep) {
  let i = 0, done = 0, failed = null;
  const worker = async () => {
    while (!failed && i < tasks.length) {
      const t = tasks[i++];
      try { await t(); if (onStep) onStep(++done, tasks.length); } catch (e) { failed = e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  if (failed) throw failed;
}

async function sync(url, log = () => {}, onProgress = null, onExtras = null) {
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { signal: AbortSignal.timeout(10000), cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const m = await res.json();
  const pr = m && m.profile;
  if (!pr || !ID.test(String(pr.id)) || !MC.test(String(pr.mc)) || (pr.forge && !FORGE.test(String(pr.forge))) || (pr.server && !SERVER.test(String(pr.server))) || (pr.loader && pr.loader !== 'fabric') || (pr.fabric && !/^[\w.+-]{1,30}$/.test(String(pr.fabric))) || !Array.isArray(m.files)) throw new Error('latest.json inválido');
  if (onExtras) {   // eventos y servidor social viajan junto al modpack
    try {
      const x = { social: /^https:\/\/[^\s]+$/.test(String(m.social || '')) ? m.social : '' };
      const er = await fetch(new URL('events.json', url) + '?t=' + Date.now(), { signal: AbortSignal.timeout(8000), cache: 'no-store' });
      if (er.ok) x.events = await er.json();
      onExtras(x);
    } catch { /* sin eventos nuevos */ }
  }
  const inst = paths.instance(pr.id), stateFile = path.join(inst, '.chilet-remote.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* primera vez */ }
  const cache = st.cache || {};           // rel -> [tamaño, fecha, sha1]: así no se vuelve a calcular el hash de archivos que no cambiaron
  let changes = 0, cacheDirty = false;
  const wanted = new Set(), tasks = [];
  const isSame = (rel, dest, size, hash) => {
    try {
      const s = fs.statSync(dest);
      if (s.size !== size) return false;
      const c = cache[rel];
      if (c && c[0] === s.size && c[1] === s.mtimeMs && c[2] === hash) return true;
      if (sha1(fs.readFileSync(dest)) !== hash) return false;
      cache[rel] = [s.size, s.mtimeMs, hash]; cacheDirty = true; return true;
    } catch { return false; }
  };
  const store = (rel, dest, buf, hash) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf);
    const s = fs.statSync(dest); cache[rel] = [s.size, s.mtimeMs, hash]; cacheDirty = true; changes++;
  };
  for (const f of m.files) {
    if (!okRel(f.p) || !/^[0-9a-f]{40}$/.test(String(f.sha1))) continue;
    wanted.add(f.p);
    const dest = path.join(inst, f.p);
    if (!inside(inst, dest) || isSame(f.p, dest, f.size, f.sha1)) continue;
    tasks.push(async () => {
      log(`[actualización] descargando ${f.p}…`);
      const r = await fetch(new URL('files/' + f.p.split('/').map(encodeURIComponent).join('/'), url), { signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error(`${f.p}: HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (sha1(buf) !== f.sha1) throw new Error(`${f.p}: archivo dañado, se reintentará.`);
      store(f.p, dest, buf, f.sha1);
    });
  }
  // Mods pesados: se bajan de Modrinth (comprobando el sha1 que publicó el creador).
  for (const e of Array.isArray(m.external) ? m.external : []) {
    if (!/^[A-Za-z0-9._+-]+\.jar$/.test(String(e.filename)) || !/^[0-9a-f]{40}$/.test(String(e.sha1))) continue;
    const rel = 'mods/' + e.filename, dest = path.join(inst, rel);
    wanted.add(rel);
    if (isSame(rel, dest, e.size, e.sha1)) continue;
    tasks.push(async () => {
      log(`[actualización] descargando ${e.filename} desde Modrinth (${Math.round(e.size / 1048576)} MB, solo la primera vez)…`);
      const vr = await fetch(`${MR}/version_file/${e.sha1}?algorithm=sha1`, { headers: MR_HEADERS, signal: AbortSignal.timeout(15000) });
      if (!vr.ok) throw new Error(`${e.filename}: Modrinth respondió ${vr.status}`);
      const file = ((await vr.json()).files || []).find(f => f.hashes && f.hashes.sha1 === e.sha1);
      const u = file && new URL(file.url);
      if (!u || u.protocol !== 'https:' || !/(^|\.)modrinth\.com$/.test(u.hostname)) throw new Error(`${e.filename}: dirección de descarga no válida`);
      const dr = await fetch(u, { headers: MR_HEADERS, signal: AbortSignal.timeout(900000) });
      if (!dr.ok) throw new Error(`${e.filename}: HTTP ${dr.status}`);
      const buf = Buffer.from(await dr.arrayBuffer());
      if (sha1(buf) !== e.sha1) throw new Error(`${e.filename}: descarga dañada, se reintentará.`);
      store(rel, dest, buf, e.sha1);
    });
  }
  if (tasks.length && onProgress) onProgress(0, tasks.length);
  await pool(tasks, 6, onProgress ? (d, t) => onProgress(d, t) : null);   // 6 descargas a la vez
  // Lo que ya no está publicado se quita (y los .jar sueltos de mods, para que todos tengan exactamente los mismos mods).
  const stale = [...(st.files || []), ...ICONS.filter(i => fs.existsSync(path.join(inst, i))), ...walk(path.join(inst, 'mods'), inst).filter(r => r.endsWith('.jar'))].filter(r => okRel(r) && !wanted.has(r));
  for (const rel of new Set(stale)) { const t = path.join(inst, rel); if (inside(inst, t) && fs.existsSync(t)) { fs.rmSync(t, { force: true }); changes++; log(`[actualización] quitado ${rel}`); } }
  if (changes || cacheDirty || st.version !== m.version) {
    settings.upsertProfile({ id: pr.id, name: String(pr.name).slice(0, 40), mc: pr.mc, forge: pr.forge || '', server: pr.server || '', loader: pr.loader || '', fabric: pr.fabric || '' });
    fs.mkdirSync(inst, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ version: m.version, files: [...wanted], cache }));
  }
  log(changes ? `[actualización] listo: ${changes} cambios (v${m.version}).` : '[actualización] ya tienes lo último.');
  return changes;
}
// CREADOR: sube la carpeta publicada a tu repositorio de GitHub (solo lo que cambió). cfg = { user, repo, token }
const API = process.env.CHILET_GH_API || 'https://api.github.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gitSha = buf => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');   // el "sha" que GitHub guarda para cada archivo
async function gh(cfg, method, p, body) {
  let r;
  try {
    r = await fetch(`${API}/repos/${cfg.user}/${cfg.repo}${p}`, {
      method, signal: AbortSignal.timeout(600000), body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'User-Agent': 'ChiletStudio', 'X-GitHub-Api-Version': '2022-11-28' }
    });
  } catch (e) { throw Object.assign(new Error('No se pudo hablar con GitHub (' + (e?.cause?.code || e?.message || e) + ').'), { status: 0 }); }
  if (r.status === 404 && method === 'GET') return null;
  if (!r.ok) { let t = ''; try { t = (await r.json()).message; } catch { /* sin detalle */ } throw Object.assign(new Error(`GitHub ${r.status}${r.status === 401 ? ' (token inválido)' : r.status === 403 || r.status === 404 ? ' (revisa usuario, repositorio y permisos del token)' : ''}: ${t}`), { status: r.status }); }
  return r.json();
}
// Comprueba un token SIN subir nada: ¿GitHub lo acepta y puede escribir en el repositorio?
async function verifyGithub(cfg) {
  try {
    const r = await fetch(`${API}/repos/${encodeURIComponent(cfg.user)}/${encodeURIComponent(cfg.repo)}`, { signal: AbortSignal.timeout(12000),
      headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'User-Agent': 'ChiletStudio', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (r.status === 401) return { ok: false, msg: 'GitHub no acepta ese token (está mal copiado, incompleto o venció). Crea uno nuevo y pégalo completo.' };
    if (r.status === 404) return { ok: false, msg: `Ese token no ve el repositorio ${cfg.user}/${cfg.repo}. Al crearlo, en "Repository access" elige ese repositorio; o revisa que usuario y nombre estén bien escritos.` };
    if (r.status === 403) return { ok: false, msg: 'GitHub rechazó el token (permisos o límite de uso). Espera un momento o crea uno nuevo.' };
    if (!r.ok) return { ok: false, msg: 'GitHub respondió ' + r.status + '.' };
    const j = await r.json();
    if (j.permissions && j.permissions.push === false) return { ok: false, msg: 'El token solo puede leer. Créalo con Permissions → Contents → Read and write.' };
    return { ok: true, msg: `Funciona: puede publicar en ${cfg.user}/${cfg.repo}.` };
  } catch { return { ok: null, msg: 'Guardado, pero no pude comprobarlo ahora (¿sin internet?).' }; }
}
const enc = rel => rel.split('/').map(encodeURIComponent).join('/');
async function upload(cfg, outDir, log = () => {}) {
  const info = await gh(cfg, 'GET', '');
  if (!info) throw new Error('No puedo ver ese repositorio. Revisa usuario y nombre, y que tu token tenga acceso a él (Contents: Read and write).');
  const branch = info.default_branch || 'main';
  const getFileOnce = async rel => gh(cfg, 'GET', `/contents/${enc(rel)}?ref=${encodeURIComponent(branch)}`);
  const getFile = async rel => { for (let i = 0; ; i++) { try { return await getFileOnce(rel); } catch (e) { if (i >= 3 || !(e.status === 0 || e.status >= 500)) throw e; await sleep(2500 * (i + 1)); } } };
  // Sube un archivo. Si GitHub tarda demasiado (504) o falla un momento, reintenta; si el archivo ya quedó guardado (aunque GitHub contestara con error), lo detecta y sigue.
  const put = async (rel, buf, msg) => {
    const want = gitSha(buf); let last;
    for (let i = 0; i < 4; i++) {
      try {
        const old = await getFile(rel);
        if (old && old.sha === want) return;   // ya está igual en GitHub: no se vuelve a subir
        await gh(cfg, 'PUT', `/contents/${enc(rel)}`, { message: msg, content: buf.toString('base64'), branch, ...(old && old.sha ? { sha: old.sha } : {}) });
        return;
      } catch (e) {
        last = e;
        if (i === 3 || !(e.status === 0 || e.status >= 500 || e.status === 409 || e.status === 422)) break;
        log(`GitHub no respondió bien con ${rel} (${e.status || 'sin conexión'}). Reintentando ${i + 2}/4…`);
        await sleep(4000 * (i + 1));
      }
    }
    const mb = buf.length / 1048576;
    throw new Error(`${rel}: ${last.message}` + (mb > 20 ? ` (este archivo pesa ${mb.toFixed(0)} MB y GitHub se ahoga con archivos grandes; vuelve a pulsar Publicar o usa uno más ligero)` : ' Vuelve a pulsar Publicar actualización: continúa donde se quedó.'));
  };
  let prev = new Map(), prevApp = new Map();
  const pm = await getFile('latest.json');
  if (pm && pm.content) { try { for (const f of JSON.parse(Buffer.from(pm.content, 'base64').toString('utf8')).files) prev.set(f.p, f.sha1); } catch { /* manifiesto viejo roto */ } try { for (const f of (JSON.parse(Buffer.from(pm.content, 'base64').toString('utf8')).app || {}).files || []) prevApp.set(f.p, f.sha256); } catch { /* sin launcher previo */ } }
  const manifestRaw = fs.readFileSync(path.join(outDir, 'latest.json'));
  const files = JSON.parse(manifestRaw.toString('utf8')).files;
  const todo = files.filter(f => prev.get(f.p) !== f.sha1);
  let i = 0;
  for (const f of todo) {
    log(`Subiendo ${++i}/${todo.length}: ${f.p} (${(f.size / 1048576).toFixed(1)} MB)`);
    await put('files/' + f.p, fs.readFileSync(path.join(outDir, 'files', f.p)), 'Actualización: ' + f.p);
  }
  const appFiles = (JSON.parse(manifestRaw.toString('utf8')).app || {}).files || [];
  const appTodo = appFiles.filter(f => prevApp.get(f.p) !== f.sha256);
  let j = 0;
  for (const f of appTodo) {
    log(`Subiendo launcher ${++j}/${appTodo.length}: ${f.p}`);
    await put('app/' + f.p, fs.readFileSync(path.join(outDir, 'app', ...f.p.split('/'))), 'Launcher: ' + f.p);
  }
  await put('events.json', fs.readFileSync(path.join(outDir, 'events.json')), 'Eventos');
  log('Publicando la lista de cambios…');
  await put('latest.json', manifestRaw, 'Nueva versión del modpack');   // al final: así nadie ve la lista antes de que estén los archivos
  return { uploaded: todo.length, total: files.length, appUploaded: appTodo.length, branch };
}
module.exports = { fingerprint, publish, sync, upload, verifyExternal, verifyGithub };
