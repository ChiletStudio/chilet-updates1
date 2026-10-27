const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const paths = require('./paths');
const { download } = require('./download');

const isWin = process.platform === 'win32';
const exe = isWin ? 'java.exe' : 'java';

// Java que exige cada versión de Minecraft (1.x y el nuevo formato por año 26.x).
function requiredJava(mc) {
  const [a, b = 0, c = 0] = String(mc).split('.').map(Number);
  if (a >= 26) return 25;                       // 26.1+ exige Java 25
  if (b >= 21 || (b === 20 && c >= 5)) return 21; // 1.20.5 a 1.21.x
  if (b >= 17) return 17;                       // 1.17 a 1.20.4
  return 8;                                     // 1.16 y anteriores
}

function major(bin) {
  return new Promise(resolve => {
    execFile(bin, ['-version'], { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stderr || ''}${stdout || ''}`;
      const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
      if (!m) return resolve(0);
      resolve(m[1] === '1' ? Number(m[2] || 0) : Number(m[1]));
    });
  });
}

function scan(dir, depth, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === exe && path.basename(dir) === 'bin') out.push(p);
    else if (e.isDirectory() && depth > 0) scan(p, depth - 1, out);
  }
  return out;
}

function candidates() {
  const list = [...scan(paths.runtime(), 4)];
  if (process.env.JAVA_HOME) list.push(path.join(process.env.JAVA_HOME, 'bin', exe));
  if (isWin) {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const appdata = process.env.APPDATA || '';
    const local = process.env.LOCALAPPDATA || '';
    for (const vendor of ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru']) {
      list.push(...scan(path.join(pf, vendor), 2));
    }
    // Java que trae el launcher oficial de Minecraft
    if (appdata) list.push(...scan(path.join(appdata, '.minecraft', 'runtime'), 4));
    if (local) {
      try {
        const pk = path.join(local, 'Packages');
        for (const d of fs.readdirSync(pk)) {
          if (d.startsWith('Microsoft.4297127D64EC6')) list.push(...scan(path.join(pk, d, 'LocalCache', 'Local', 'runtime'), 4));
        }
      } catch { /* sin Store */ }
    }
  }
  list.push(exe === 'java.exe' ? 'java' : 'java'); // el que haya en el PATH
  return list;
}

// ¿Sirve este Java para esa versión de Minecraft? Java 8 solo para 1.16 y anteriores (Forge viejo no arranca con otro);
// desde 1.17 se aceptan el Java que pide el juego y los 4 siguientes (p. ej. con Java 17 como mínimo, valen 17 a 21).
const compatible = (m, required) => required <= 8 ? m === 8 : (m >= required && m <= required + 4);

// Devuelve { path, major } o null. La ruta fijada por el usuario se respeta si su versión sirve.
const cacheFile = () => path.join(paths.base(), 'java-cache.json');
function cacheGet(required) {
  try {
    const h = (JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) || {})[required];
    const m = Number(h && h.major) || required;
    if (h && compatible(m, required) && fs.statSync(h.path).mtimeMs === h.t) return { path: h.path, major: m };
  } catch { /* sin caché */ }
  return null;
}
function cacheSet(required, p, m) {
  try {
    if (!path.isAbsolute(p)) return;
    let c = {}; try { c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) || {}; } catch { /* nuevo */ }
    c[required] = { path: p, major: m, t: fs.statSync(p).mtimeMs };
    fs.mkdirSync(paths.base(), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(c));
  } catch { /* no crítico */ }
}
// Mira TODOS los Java instalados a la vez y devuelve [{ path, major }] (sin repetidos).
async function installed() {
  const seen = new Set();
  const list = candidates().filter(c => (c === 'java' || fs.existsSync(c)) && !seen.has(c) && seen.add(c));
  const res = await Promise.all(list.map(async c => ({ path: c, major: await major(c) })));
  return res.filter(r => r.major > 0);
}
// Prefiere el Java exacto que pide el juego; si no hay, el compatible más bajo (así no hace falta instalar nada).
async function find(custom, required = 17) {
  if (custom && fs.existsSync(custom)) {
    const m = await major(custom);
    if (m >= required) return { path: custom, major: m };   // lo fijado a mano se respeta aunque sea más nuevo
  }
  const hit = cacheGet(required); if (hit) return hit;
  const all = await installed();
  const pick = all.find(x => x.major === required) || all.filter(x => compatible(x.major, required)).sort((a, b) => a.major - b.major)[0];
  if (pick) { cacheSet(required, pick.path, pick.major); return pick; }
  return null;
}
// Último recurso (si no se pudo descargar nada): cualquier Java igual o más nuevo que el pedido.
async function findAny(required) {
  const all = (await installed()).filter(x => required <= 8 ? x.major >= 8 : x.major >= required).sort((a, b) => a.major - b.major);
  return all[0] || null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 * 16 }, (err, _o, stderr) => {
      if (err) reject(new Error(`${cmd} falló: ${stderr || err.message}`));
      else resolve();
    });
  });
}
async function extract(archive, dir) {
  try { await run('tar', ['-xf', archive, '-C', dir]); return; }   // tar (bsdtar) viene en Windows 10+
  catch (e) {
    if (!isWin || !/\.zip$/i.test(archive)) throw e;
    // PCs sin tar: PowerShell sabe abrir .zip
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`]);
  }
}

// De dónde se puede bajar un Java si no hay ninguno que sirva. Si una fuente falla, se prueba la siguiente.
function sources(required) {
  const osName = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const ext = isWin ? 'zip' : 'tar.gz';
  const list = [
    { name: 'Adoptium', url: async () => `https://api.adoptium.net/v3/binary/latest/${required}/ga/${osName}/${arch}/jre/hotspot/normal/eclipse` },
    { name: 'Azul Zulu', url: async () => {
      const q = `https://api.azul.com/metadata/v1/zulu/packages/?java_version=${required}&os=${osName === 'mac' ? 'macos' : osName}&arch=${arch === 'x64' ? 'x86' : 'arm'}&hw_bitness=64&archive_type=${ext}&java_package_type=jre&javafx_bundled=false&latest=true&release_status=ga&availability_types=CA&page_size=1`;
      const r = await fetch(q, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('Azul respondió ' + r.status);
      const j = await r.json(); const u = Array.isArray(j) && j[0] && j[0].download_url;
      if (!u) throw new Error('Azul no tiene Java ' + required + ' para este sistema');
      return u;
    } }
  ];
  if ([17, 21, 25].includes(required)) list.push({ name: 'Microsoft OpenJDK', url: async () => `https://aka.ms/download-jdk/microsoft-jdk-${required}-${osName === 'mac' ? 'macOS' : osName}-${arch}.${ext}` });
  return { list, osName, ext };
}

// Descarga un Java <required> dentro de la carpeta de la app (una carpeta por versión). Prueba varias fuentes y reintenta.
async function installManaged(required, onProgress, log = () => {}) {
  const { list, osName, ext } = sources(required);
  if (!osName) throw new Error('Sistema no soportado para descarga automática de Java.');
  const archive = path.join(paths.cache(), `java${required}.${ext}`);
  const dir = path.join(paths.runtime(), `java${required}`);
  const errors = [];
  for (const src of list) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        log(`[java] descargando Java ${required} (${src.name}${attempt > 1 ? ', reintento' : ''})…`);
        await download(await src.url(), archive, (d, t) => onProgress && onProgress(t ? d / t : null));
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        await extract(archive, dir);
        fs.rmSync(archive, { force: true });
        for (const bin of scan(dir, 5)) {
          const m = await major(bin);
          if (m === required) { cacheSet(required, bin, m); return { path: bin, major: m }; }
        }
        throw new Error('se descargó pero no se encontró el ejecutable');
      } catch (e) { errors.push(`${src.name}: ${e?.message || e}`); log(`[java] ${src.name} falló: ${e?.message || e}`); fs.rmSync(archive, { force: true }); }
    }
  }
  throw new Error(`No se pudo conseguir Java ${required} (${errors.slice(-3).join(' | ')}). Revisa tu internet o el antivirus y vuelve a pulsar Jugar.`);
}

// Todo en uno para Jugar: usa el Java que ya tengas si sirve; si no, lo baja solo; si no se puede bajar, usa cualquier Java más nuevo antes que fallar.
async function ensure(custom, required, onProgress, log = () => {}) {
  const have = await find(custom, required);
  if (have) { if (have.major !== required) log(`[java] se usa el Java ${have.major} que ya tienes instalado (el juego pide ${required}).`); return have; }
  try { return await installManaged(required, onProgress, log); }
  catch (e) {
    const any = await findAny(required);
    if (any) { log(`[java] no se pudo bajar Java ${required} (${e?.message || e}). Se prueba con el Java ${any.major} que ya tienes.`); return any; }
    throw e;
  }
}

module.exports = { find, findAny, installManaged, ensure, requiredJava, compatible };
