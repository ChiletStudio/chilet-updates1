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

// Devuelve { path, major } o null. La ruta fijada por el usuario se respeta solo si su versión alcanza.
const cacheFile = () => path.join(paths.base(), 'java-cache.json');
function cacheGet(required) {
  try { const h = (JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) || {})[required]; if (h && fs.statSync(h.path).mtimeMs === h.t) return { path: h.path, major: required }; } catch { /* sin caché */ }
  return null;
}
function cacheSet(required, p) {
  try { if (!path.isAbsolute(p)) return; let c = {}; try { c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) || {}; } catch { /* nuevo */ } c[required] = { path: p, t: fs.statSync(p).mtimeMs }; fs.mkdirSync(paths.base(), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(c)); } catch { /* no crítico */ }
}
async function find(custom, required = 17) {
  if (custom && fs.existsSync(custom)) {
    const m = await major(custom);
    if (m >= required) return { path: custom, major: m };
  }
  const hit = cacheGet(required); if (hit) return hit;
  for (const c of candidates()) {
    if (c !== 'java' && !fs.existsSync(c)) continue;
    if (await major(c) === required) { cacheSet(required, c); return { path: c, major: required }; }
  }
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 * 16 }, (err, _o, stderr) => {
      if (err) reject(new Error(`${cmd} falló: ${stderr || err.message}`));
      else resolve();
    });
  });
}

// Descarga Temurin JRE <required> (Adoptium) dentro de la carpeta de la app (una carpeta por versión).
async function installManaged(required, onProgress) {
  const osName = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  if (!osName) throw new Error('Sistema no soportado para descarga automática de Java.');
  const url = `https://api.adoptium.net/v3/binary/latest/${required}/ga/${osName}/${arch}/jre/hotspot/normal/eclipse`;
  const archive = path.join(paths.cache(), isWin ? `java${required}.zip` : `java${required}.tar.gz`);
  await download(url, archive, (d, t) => onProgress && onProgress(t ? d / t : null));
  const dir = path.join(paths.runtime(), `java${required}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await run('tar', ['-xf', archive, '-C', dir]); // tar (bsdtar) viene en Windows 10+
  fs.rmSync(archive, { force: true });
  for (const bin of scan(dir, 4)) {
    if (await major(bin) === required) return { path: bin, major: required };
  }
  throw new Error(`Se descargó Java ${required} pero no se encontró el ejecutable.`);
}

module.exports = { find, installManaged, requiredJava };
