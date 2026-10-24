const fs = require('fs');
const { safeStorage } = require('electron');
const msmc = require('msmc');
const { Auth, tokenUtils } = msmc;
const paths = require('./paths');
const settings = require('./settings');

const authManager = new Auth('select_account');
let cache = null; // { token, at }

function saveToken(token) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false; // nunca se guarda en texto plano
    fs.mkdirSync(paths.base(), { recursive: true });
    fs.writeFileSync(paths.authFile(), safeStorage.encryptString(JSON.stringify(token)));
    return true;
  } catch { return false; }
}

function loadToken() {
  try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(paths.authFile()))); }
  catch { return null; }
}

function remember(mc) {
  const token = mc.mclc(true); // con metadatos para poder refrescarlo
  cache = { token, at: Date.now() };
  saveToken(token);
  settings.setAccount({ name: token.name, uuid: token.uuid });
  return token;
}

// Escribe en la Consola todo el detalle posible del fallo (estado HTTP, cabeceras, versión de msmc).
function describe(e, log) {
  try {
    let ver = '?';
    try { ver = require('msmc/package.json').version; } catch { /* exports cerrados */ }
    log(`[login] msmc ${ver} | error bruto: ${typeof e === 'string' ? e : (e && e.message) || String(e)}`);
    const w = typeof msmc.wrapError === 'function' ? msmc.wrapError(e) : null;
    if (w) {
      log(`[login] msmc lo clasifica como: ${w.name} - ${w.message}`);
      const r = w.opt && w.opt.response;
      if (r) {
        let headers = '';
        try { headers = JSON.stringify(Object.fromEntries(r.headers.entries())); } catch { /* sin cabeceras */ }
        log(`[login] respuesta HTTP ${r.status} de ${r.url}\n[login] cabeceras: ${headers}`);
      }
    }
  } catch (err) { log('[login] no se pudo extraer más detalle: ' + err.message); }
}

function explain(e) {
  const msg = typeof e === 'string' ? e : (e && e.message) || String(e);
  if (/closed/i.test(msg)) return 'Cerraste la ventana de inicio de sesión.';
  if (/xsts|xbox/i.test(msg)) return 'Falló el paso de Xbox del inicio de sesión. Mira la pestaña Consola para el detalle. (' + msg + ')';
  if (/game|own|profile/i.test(msg)) return 'Esa cuenta Microsoft no parece tener Minecraft Java Edition. (' + msg + ')';
  return 'No se pudo iniciar sesión: ' + msg;
}

// mode: 'electron' (ventana de la app) | 'raw' (navegador del sistema)
async function login(log = () => {}, mode = 'electron') {
  try {
    const xbox = await authManager.launch(mode === 'raw' ? 'raw' : 'electron');
    const mc = await xbox.getMinecraft();
    return remember(mc);
  } catch (e) {
    describe(e, log);
    throw new Error(explain(e));
  }
}

// ¿Mojang acepta este token ahora mismo? true / false, o null si no se pudo comprobar (sin internet).
async function isValid(token) {
  try {
    const r = await fetch('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: 'Bearer ' + token.access_token }, signal: AbortSignal.timeout(8000)
    });
    return r.status === 200 ? true : (r.status === 401 || r.status === 403 ? false : null);
  } catch { return null; }
}

function jwtExp(t) { try { return Number(JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')).exp) || 0; } catch { return 0; } }

// Token listo para MCLC, o null si hay que iniciar sesión otra vez.
// Antes de jugar SIEMPRE se renueva (así dura ~24 h desde ahora) y se comprueba con Mojang: un token vencido es lo que da "Invalid session".
async function getAuthorization(log = () => {}) {
  let tok = cache && Date.now() - cache.at < 10 * 60 * 1000 ? cache.token : null;
  if (!tok) {
    const saved = loadToken();
    if (!saved) return null;
    const exp = jwtExp(saved.access_token);
    if (exp && exp * 1000 - Date.now() > 20 * 60 * 1000) { cache = { token: saved, at: Date.now() }; return saved; }   // aún vale >20 min: sin llamadas a internet
    try { tok = remember(await tokenUtils.fromMclcToken(authManager, saved, true)); }
    catch (e) { log('[cuenta] no se pudo renovar la sesión (' + ((e && e.message) || e) + '); se prueba con la guardada.'); tok = saved; }
  }
  const ok = await isValid(tok);
  if (ok === false) { log('[cuenta] Mojang no acepta la sesión guardada: hay que iniciar sesión otra vez.'); cache = null; return null; }
  if (ok === null) log('[cuenta] no se pudo comprobar la sesión con Mojang (¿sin internet?).');
  return tok;
}

function logout() {
  cache = null;
  fs.rmSync(paths.authFile(), { force: true });
  settings.setAccount(null);
}

function status() {
  const acc = settings.read().account;
  return acc && fs.existsSync(paths.authFile()) ? { loggedIn: true, name: acc.name } : { loggedIn: false };
}

module.exports = { login, getAuthorization, logout, status };
