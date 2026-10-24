const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const { download } = require('./download');

const installerName = (mc, forge) => `forge-${mc}-${forge}-installer.jar`;
const versionId = (mc, forge) => `${mc}-forge-${forge}`;

// Descarga el instalador oficial de Forge (se reutiliza en ambos modos).
async function ensureInstaller(mc, forge, onProgress) {
  const dest = path.join(paths.cache(), installerName(mc, forge));
  if (fs.existsSync(dest)) return dest;
  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${forge}/${installerName(mc, forge)}`;
  await download(url, dest, (d, t) => onProgress && onProgress(t ? d / t : null));
  return dest;
}

function isInstalled(mc, forge) {
  const id = versionId(mc, forge);
  return fs.existsSync(path.join(paths.root(), 'versions', id, `${id}.json`));
}

// Modo 'installer': ejecuta el instalador oficial en modo cliente dentro de nuestra carpeta.
function runInstaller({ installer, javaPath, onLog }) {
  const root = paths.root();
  fs.mkdirSync(root, { recursive: true });
  const lp = path.join(root, 'launcher_profiles.json'); // el instalador lo exige
  if (!fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ profiles: {}, version: 3 }));
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, ['-jar', installer, '--installClient', root], { cwd: paths.cache(), windowsHide: true });
    const tail = [];
    const feed = buf => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line); if (tail.length > 15) tail.shift();
        if (onLog) onLog('[forge] ' + line);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve()
      : reject(new Error(`El instalador de Forge terminó con error (${code}):\n${tail.join('\n')}`)));
  });
}

module.exports = { ensureInstaller, isInstalled, runInstaller, versionId };
