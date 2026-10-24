const { app } = require('electron');
const path = require('path');

const base = () => app.getPath('userData');

module.exports = {
  base,
  settings: () => path.join(base(), 'settings.json'),
  authFile: () => path.join(base(), 'auth.bin'),
  root: () => path.join(base(), 'minecraft'),          // versiones, librerías, assets (compartido)
  instances: () => path.join(base(), 'instances'),     // una carpeta por modpack (mods, mundos, config)
  instance: (id) => path.join(base(), 'instances', id),
  runtime: () => path.join(base(), 'runtime'),         // Java 17 descargado por la app
  cache: () => path.join(base(), 'cache')              // instaladores descargados
};
