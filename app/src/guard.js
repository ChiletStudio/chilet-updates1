// Red de seguridad para que Jugar abra Minecraft en cualquier PC: revisiones previas, reparación automática y mensajes claros si algo falla.
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');

const GB = 1024 ** 3;

// RAM: nunca más del 60 % de la memoria de la PC (si no, Windows/Java se ahogan y Minecraft no abre).
function safeRam(wantedGb) {
  const cap = Math.max(1, Math.floor((os.totalmem() / GB) * 0.6));
  return { gb: Math.max(1, Math.min(Number(wantedGb) || 4, cap)), cap, total: Math.round(os.totalmem() / GB * 10) / 10 };
}

// Espacio en disco: Minecraft + Java + mods piden unos GB.
function preflight(log = () => {}) {
  try {
    const st = fs.statfsSync(paths.base());
    const free = st.bavail * st.bsize;
    if (free < 1.5 * GB) throw new Error(`Casi no queda espacio en el disco (${(free / GB).toFixed(1)} GB libres). Libera al menos 2 GB y vuelve a pulsar Jugar.`);
  } catch (e) { if (/espacio/.test(String(e.message))) throw e; /* statfs no disponible: se sigue */ }
  log('[revisión] espacio en disco OK');
}

// Borra lo que más suele quedar a medias o dañado, para que el reintento lo vuelva a bajar limpio.
function repair(profile, log = () => {}) {
  const rm = p => { try { fs.rmSync(p, { recursive: true, force: true }); log('[reparación] quitado ' + path.basename(p)); } catch { /* ignorar */ } };
  const root = paths.root();
  try { for (const f of fs.readdirSync(paths.cache())) if (/^forge-.*-installer\.jar$/.test(f)) rm(path.join(paths.cache(), f)); } catch { /* sin cache */ }
  try {
    for (const d of fs.readdirSync(path.join(root, 'versions'))) {
      if (d.includes('forge') && d.startsWith(profile.mc)) rm(path.join(root, 'versions', d));
      if (d.startsWith('fabric-loader-') && d.endsWith('-' + profile.mc)) rm(path.join(root, 'versions', d));
    }
  } catch { /* sin versiones */ }
  const jar = path.join(root, 'versions', profile.mc, profile.mc + '.jar');
  try { if (fs.existsSync(jar) && fs.statSync(jar).size < 1024 * 1024) rm(path.join(root, 'versions', profile.mc)); } catch { /* ignorar */ }
}

// ¿Hubo un informe de fallos escrito después de `since`? (algunos cierres por crash salen con código 0)
function recentCrash(instance, since) {
  try {
    const d = path.join(instance, 'crash-reports');
    return fs.readdirSync(d).map(f => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs })).filter(x => x.t >= (since || 0) - 2000).sort((a, b) => b.t - a.t)[0]?.f || null;
  } catch { return null; }
}

// Resumen legible del último informe de fallos: descripción, causa y archivo (para copiarlo y mandarlo).
function crashSummary(instance) {
  try {
    const d = path.join(instance, 'crash-reports');
    const last = fs.readdirSync(d).map(f => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (!last) return null;
    const txt = fs.readFileSync(path.join(d, last.f), 'utf8').slice(0, 300000);
    const desc = (txt.match(/^Description:\s*(.+)$/m) || [])[1] || '';
    const caused = [...txt.matchAll(/^Caused by:\s*(.+)$/gm)].map(m => m[1].trim()).slice(0, 3);
    const first = (txt.match(/^(?:java|net|org|com|cpw)[\w.$]*(?:Exception|Error)[^\r\n]*/m) || [])[0] || '';
    return { file: last.f, desc: desc.trim(), caused, first: first.trim() };
  } catch { return null; }
}

// Si Minecraft se cierra con error, lee el log y el último informe de fallos y dice la causa en cristiano.
// ¿La salida del juego indica que a Forge le faltan piezas (descarga incompleta / archivo dañado)?
const FORGE_LOAD_FAIL = /(NoClassDefFoundError|ClassNotFoundException|Could not find or load main class|NoSuchFileException|ZipException|Invalid or corrupt jarfile)[^\n]*(cpw[./]mods|modlauncher|bootstraplauncher|minecraftforge|zekerzhayard|forgewrapper|securejarhandler|libraries)|forgewrapper[^\n]*Main\.main/i;
const isForgeLoadFailure = text => FORGE_LOAD_FAIL.test(String(text || ''));

function walkJars(dir, out = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJars(p, out);
    else if (e.isFile() && e.name.endsWith('.jar')) out.push(p);
  }
  return out;
}

// Un .jar completo termina con la firma de "fin de directorio" de ZIP; si falta, la descarga quedó a medias.
function jarOk(p) {
  try {
    const st = fs.statSync(p); if (st.size < 22) return false;
    const n = Math.min(st.size, 65557), b = Buffer.alloc(n), fd = fs.openSync(p, 'r');
    fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd);
    return b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) !== -1;
  } catch { return false; }
}

// Reparación de Forge: borra las piezas de Forge (se vuelven a bajar solas al pulsar Jugar), los .jar dañados y el instalador guardado.
function repairForge(profile, log = () => {}) {
  const root = paths.root();
  const rm = p => { try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); log('[reparación] quitado ' + path.relative(root, p)); } } catch { /* ignorar */ } };
  for (const j of [...walkJars(path.join(root, 'libraries')), ...walkJars(path.join(root, 'versions'))]) if (!jarOk(j)) rm(j);
  for (const d of [['cpw'], ['net', 'minecraftforge'], ['io', 'github', 'zekerzhayard'], ['net', 'fabricmc']]) rm(path.join(root, 'libraries', ...d));
  try { for (const f of fs.readdirSync(paths.cache())) if (/^forge-.*-installer\.jar$/.test(f)) rm(path.join(paths.cache(), f)); } catch { /* sin cache */ }
  if (profile) repair(profile, () => {});
}

function diagnose(instance, code, extraText = '') {
  let text = String(extraText || '');
  try { const f = path.join(instance, 'logs', 'latest.log'); const st = fs.statSync(f); const fd = fs.openSync(f, 'r'); const n = Math.min(st.size, 300000); const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd); text += b.toString('utf8'); } catch { /* sin log */ }
  try {
    const d = path.join(instance, 'crash-reports');
    const recent = fs.readdirSync(d).map(f => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs })).filter(x => Date.now() - x.t < 5 * 60 * 1000).sort((a, b) => b.t - a.t)[0];
    if (recent) text += '\n' + fs.readFileSync(path.join(d, recent.f), 'utf8').slice(0, 200000);
  } catch { /* sin informes */ }
  if (/ModMismatchDisconnected|Mismatched mod channel|Incompatible FML modded server|Missing mods?:|mods? (?:are|is) missing/i.test(text)) return 'El servidor y tu modpack no tienen los mismos mods (o la misma versión de Forge). Pídele al dueño del servidor la lista de mods.';
  if (/Incompatible mod set|ModResolutionException|Mod resolution failed|net\.fabricmc\.loader[^\n]*FormattedException/i.test(text)) {
    const need = text.match(/(?:Mod|Mods?) '?([\w .-]+?)'? \(([\w-]+)\)[^\n]{0,40}requires[^\n]{3,120}/i) || text.match(/requires (?:any version of |version [^\n]{1,40} of )?(fabric-api|fabricloader|minecraft|[\w-]+)[^\n]{0,80}/i);
    return `Fabric no pudo cargar los mods: falta un mod necesario o hay uno de otra versión${need ? ' (' + need[0].trim().slice(0, 140) + ')' : ''}. Casi siempre es Fabric API o un mod hecho para otra versión de Minecraft. Revisa la Consola.`;
  }
  if (/(NoClassDefFoundError|ClassNotFoundException|Could not find or load main class|NoSuchFileException|ZipException|Invalid or corrupt jarfile)[^\n]*(net[./]fabricmc|knot)/i.test(text)) return 'A Fabric le faltan archivos o están dañados. Ve a Ajustes → "Reparar Minecraft" y pulsa Jugar otra vez.';
  if (extraText && /InvalidMixinException|Mixin apply failed/.test(extraText)) {
    const m = extraText.match(/Mixin apply failed ([\w-]+)\.mixins\.json/) || extraText.match(/Mixin \[([\w-]+)\.mixins\.json/);
    return `El mod "${m ? m[1] : 'desconocido'}" no pudo aplicarse a Minecraft (error de Mixin). Casi siempre es un mod de otra versión de Minecraft/Forge, o Forge mezclado con otra versión. Revisa la Consola.`;
  }
  if (extraText && isForgeLoadFailure(extraText)) return 'A Forge le faltan archivos o están dañados (descarga incompleta, antivirus o disco). Ve a Ajustes → "Reparar Minecraft" y pulsa Jugar otra vez.';
  const dep = text.match(/Mod \S+ (?:only supports|requires) [^\r\n]{3,120}/);
  if (dep) return `Falta un mod necesario o hay uno que no encaja: ${dep[0].trim()}.`;
  if (/Duplicate mods? found|Found duplicate mods|duplicate mod/i.test(text)) return 'Hay mods repetidos en la carpeta mods. Cierra y vuelve a pulsar Jugar (se limpian solos).';
  if (/OutOfMemoryError/.test(text)) return 'Minecraft se quedó sin memoria. Cierra otros programas o ajusta la RAM en Ajustes.';
  if (/UnsupportedClassVersionError|class file version/i.test(text)) return 'La versión de Java no es la correcta para este Minecraft. Borra la carpeta "java" del launcher y pulsa Jugar para bajarla de nuevo.';
  if (/GLFW error|Failed to create window|WGL|OpenGL|Pixel format/i.test(text)) return 'Tu tarjeta gráfica o sus controladores no son compatibles. Actualiza los drivers de video y vuelve a probar.';
  if (/Could not reserve enough space|Invalid maximum heap size/i.test(text)) return 'La RAM configurada no cabe en tu PC. Bájala en Ajustes.';
  const cs = crashSummary(instance);
  if (cs) {
    const parts = [cs.desc && `Qué pasó: ${cs.desc}`, (cs.caused[0] || cs.first) && `Causa: ${cs.caused[0] || cs.first}`].filter(Boolean).join(' · ');
    return `Minecraft se cerró con un error (código ${code}). ${parts} — Informe: crash-reports\\${cs.file} (botón Carpeta del modpack).`;
  }
  return `Minecraft se cerró con un error (código ${code}). Mira la pestaña Consola o el archivo logs\\latest.log del modpack.`;
}
module.exports = { safeRam, preflight, repair, repairForge, isForgeLoadFailure, diagnose, recentCrash, crashSummary };
