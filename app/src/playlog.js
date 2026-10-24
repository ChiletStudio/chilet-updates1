// Historial local de lo que has jugado desde el launcher (para tu perfil).
const fs = require('fs'), path = require('path');
const { app } = require('electron');
const file = () => path.join(app.getPath('userData'), 'playlog.json');
const read = () => { try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); return { packs: j.packs || {}, recent: j.recent || [] }; } catch { return { packs: {}, recent: [] }; } };
function add(profile, ms) {
  if (!(ms > 15000)) return;   // aperturas fallidas (menos de 15 s) no cuentan
  const d = read(), p = d.packs[profile.id] || { plays: 0, ms: 0 };
  d.packs[profile.id] = { name: profile.name, mc: profile.mc, loader: profile.forge ? 'Forge' : profile.loader === 'fabric' ? 'Fabric' : 'Vanilla', plays: p.plays + 1, ms: p.ms + ms, last: Date.now() };
  d.recent = [{ id: profile.id, name: profile.name, start: Date.now() - ms, ms }, ...d.recent].slice(0, 20);
  fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(d));
}
function summary() {
  const d = read(), list = Object.entries(d.packs).map(([id, p]) => ({ id, ...p })).sort((a, b) => b.last - a.last);
  return { totalMs: list.reduce((s, p) => s + p.ms, 0), plays: list.reduce((s, p) => s + p.plays, 0), packs: list, recent: d.recent };
}
module.exports = { add, summary };
