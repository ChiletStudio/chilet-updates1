// Conexión del launcher con el servidor social (amigos, chat, likes). La dirección llega por GitHub (latest.json) o la pone el creador.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { app } = require('electron');
const file = () => path.join(app.getPath('userData'), 'social.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; } };
const write = o => { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(o)); };
let session = null;
const url = () => read().url || '';
function setUrl(u) {
  if (u && !/^https?:\/\/[^\s]+$/.test(u)) throw new Error('La dirección del servidor social debe empezar por https://');
  const s = read(); if ((s.url || '') !== u) { s.url = u; write(s); session = null; }
}
async function post(p, body, token) {
  const r = await fetch(url().replace(/\/$/, '') + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Error ' + r.status), { status: r.status });
  return j;
}
async function connect(getAuth, offlineName) {
  const auth = await Promise.resolve().then(getAuth).catch(() => null);
  if (auth && auth.access_token && auth.uuid) {      // Microsoft: se prueba la cuenta con Mojang sin enviar el token al servidor social
    try {
      const { serverId } = await post('/challenge');
      const j = await fetch('https://sessionserver.mojang.com/session/minecraft/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: auth.access_token, selectedProfile: String(auth.uuid).replace(/-/g, ''), serverId }), signal: AbortSignal.timeout(10000) });
      if (j.status === 204) return (session = await post('/login', { name: auth.name, serverId }));
    } catch { /* se entra como jugador no premium */ }
  }
  const st = read(); if (!st.guestSecret) { st.guestSecret = crypto.randomBytes(24).toString('hex'); write(st); }
  return (session = await post('/login', { name: offlineName, secret: st.guestSecret }));
}
async function call(p, body, getAuth, offlineName) {
  if (!url()) throw Object.assign(new Error('Falta el servidor social.'), { code: 'nourl' });
  for (let i = 0; i < 2; i++) {
    if (!session) await connect(getAuth, offlineName);
    try { return await post(p, body, session.token); }
    catch (e) { if (e.status === 401 && i === 0) { session = null; continue; } throw e; }
  }
}
module.exports = { url, setUrl, call };
