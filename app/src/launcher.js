const fs = require('fs');
const path = require('path');
const { Client } = require('minecraft-launcher-core');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const paths = require('./paths');

// forge: { mode: 'none' } | { mode: 'mclc', installer } | { mode: 'installer', id }
// 1.20+ usa quickPlay 'multiplayer'; antes de 1.20 solo existe 'legacy'.
const supportsQuickPlay = mc => { const [a, b = 0] = String(mc).split('.').map(Number); return a >= 26 || b >= 20; };

// Argumentos de Java que trae el JSON de Forge moderno (1.17+): ruta de módulos (-p), --add-modules, --add-opens, etc.
// MCLC NO los aplica en modo "custom"; sin ellos Forge cae con
// "module java.base does not opens java.lang.invoke to unnamed module". Aquí se leen del JSON y se pasan a mano.
function forgeJvmArgs(root, id) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(root, 'versions', id, id + '.json'), 'utf8'));
    const list = (json.arguments && json.arguments.jvm) || [];
    const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const lib = path.join(root, 'libraries');
    const allowed = rules => {
      if (!rules || !rules.length) return true;
      let ok = false;
      for (const r of rules) { if (r.features) continue; if (!r.os || !r.os.name || r.os.name === os) ok = r.action === 'allow'; }
      return ok;
    };
    const flat = [];
    for (const a of list) {
      if (typeof a === 'string') flat.push(a);
      else if (a && allowed(a.rules)) flat.push(...[].concat(a.value || []));
    }
    const out = [];
    for (let i = 0; i < flat.length; i++) {
      if (/^-(cp|classpath)$/.test(flat[i])) { i++; continue; }   // el classpath lo arma MCLC
      const v = String(flat[i]).replace(/\$\{library_directory\}/g, lib).replace(/\$\{classpath_separator\}/g, path.delimiter).replace(/\$\{version_name\}/g, id);
      if (v.includes('${')) continue;                              // placeholders que MCLC ya resuelve por su cuenta
      out.push(v);
    }
    return out;
  } catch { return []; }
}

// MCLC guarda el JSON de Forge en <root>/forge/<versión de MINECRAFT>/version.json y lo REUTILIZA aunque cambie la versión de FORGE.
// Si el modpack sube de Forge 47.4.20 a 47.4.26, el arranque mezclaba piezas de las dos versiones y el juego caía (p. ej. mixin de Iceberg: "tooltipStack").
function dropStaleForgeCache(root, mc, forgeVersion, onLog) {
  try {
    const f = path.join(root, 'forge', String(mc), 'version.json');
    if (!fs.existsSync(f)) return false;
    const txt = fs.readFileSync(f, 'utf8');
    if (txt.includes(`${mc}-${forgeVersion}`) || txt.includes(`-forge-${forgeVersion}`)) return false;   // es de esta versión: se queda
    fs.rmSync(f, { force: true });
    onLog(`[reparación] Había datos de OTRA versión de Forge guardados; se regeneran para Forge ${forgeVersion}.`);
    return true;
  } catch { return false; }
}

// La librería recalcula la huella (sha1) de TODOS los archivos del juego (sonidos, recursos, librerías: miles) cada vez que se abre Minecraft.
// Aquí se recuerda lo ya comprobado (mismo archivo, tamaño y fecha = mismo contenido) y solo se recalcula lo nuevo o modificado.
let hashCache = null, hashDirty = false, hashPatched = false;
const hashFile = () => path.join(paths.base(), 'hash-cache.json');
function speedUpHashing() {
  if (hashPatched) return; hashPatched = true;
  try {
    const Handler = require('minecraft-launcher-core/components/handler');
    const orig = Handler.prototype.checkSum;
    hashCache = readJson(hashFile(), {});
    Handler.prototype.checkSum = function (hash, f) {
      let st; try { st = fs.statSync(f); } catch { return orig.call(this, hash, f); }
      const key = path.relative(paths.root(), f), c = hashCache[key];
      if (c && c.s === st.size && c.t === Math.floor(st.mtimeMs) && c.h === hash) return Promise.resolve(true);
      return orig.call(this, hash, f).then(ok => { if (ok) { hashCache[key] = { s: st.size, t: Math.floor(st.mtimeMs), h: hash }; hashDirty = true; } return ok; });
    };
  } catch { /* si la librería cambia de estructura, se usa el método normal */ }
}
function flushHashCache() { try { if (hashDirty && hashCache) { fs.mkdirSync(paths.base(), { recursive: true }); fs.writeFileSync(hashFile(), JSON.stringify(hashCache)); hashDirty = false; } } catch { /* no crítico */ } }

// El token de sesión sale en la línea de arranque: se oculta para que nadie lo copie sin querer al pegar el registro.
const hideSecrets = s => String(s).replace(/(--accessToken\s+)\S+/g, '$1[oculto]');

async function run({ profile, auth, javaPath, ramMax, forge, server, fullscreen, onProgress, onLog, onClose }) {
  const instance = paths.instance(profile.id);
  fs.mkdirSync(path.join(instance, 'mods'), { recursive: true });

  speedUpHashing();
  const client = new Client();
  const opts = {
    authorization: auth,
    root: paths.root(),
    javaPath: (process.platform === 'win32' && /java\.exe$/i.test(String(javaPath)) && fs.existsSync(String(javaPath).replace(/java\.exe$/i, 'javaw.exe'))) ? String(javaPath).replace(/java\.exe$/i, 'javaw.exe') : javaPath,
    version: { number: profile.mc, type: 'release' },
    memory: { max: `${ramMax}G`, min: '1G' },
    overrides: { gameDirectory: instance, detached: false }
  };
  if (fullscreen) opts.window = { fullscreen: true };
  if (server) {
    opts.quickPlay = { type: supportsQuickPlay(profile.mc) ? 'multiplayer' : 'legacy', identifier: server };
    onLog(`Entrando directo al servidor ${server}`);
  }
  if (forge.mode === 'mclc') { opts.forge = forge.installer; dropStaleForgeCache(paths.root(), profile.mc, profile.forge, onLog); }
  if (forge.mode === 'installer') {
    opts.version.custom = forge.id;
    if (/-forge-/.test(forge.id)) {
      const extra = forgeJvmArgs(paths.root(), forge.id);
      if (extra.length) { opts.customArgs = extra; onLog(`Forge: se añadieron ${extra.length} argumentos de Java del instalador oficial (ruta de módulos y permisos).`); }
      else onLog('[aviso] No se pudieron leer los argumentos de Java de Forge; puede que no arranque. Prueba el método Automático en Ajustes.');
    }
  }

  client.on('debug', m => onLog(hideSecrets(m)));
  client.on('data', m => onLog(hideSecrets(String(m).trimEnd())));
  client.on('progress', e => {
    if (e && e.total) onProgress({ stage: 'mc', message: `Preparando ${e.type}…`, percent: Math.round((e.task / e.total) * 100) });
  });
  client.on('download-status', e => {
    if (e && e.total) onProgress({ stage: 'mc', message: `Descargando ${e.type}: ${e.name}`, percent: Math.round((e.current / e.total) * 100) });
  });
  client.on('close', code => onClose(code));

  const proc = await client.launch(opts);
  flushHashCache();
  if (!proc) throw new Error('No se pudo iniciar Minecraft. Revisa la pestaña Consola.');
  return proc;
}

module.exports = { run, forgeJvmArgs, hideSecrets, dropStaleForgeCache, speedUpHashing, flushHashCache };
