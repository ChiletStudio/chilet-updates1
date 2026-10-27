const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('chilet', {
  getState: () => ipcRenderer.invoke('state:get'),
  updateSettings: patch => ipcRenderer.invoke('settings:update', patch),
  profileInfo: id => ipcRenderer.invoke('profile:info', id),
  profileMods: id => ipcRenderer.invoke('profile:mods', id),
  ownerStatus: () => ipcRenderer.invoke('owner:status'),
  ownerSetup: pw => ipcRenderer.invoke('owner:setup', pw),
  ownerUnlock: pw => ipcRenderer.invoke('owner:unlock', pw),
  ownerLock: () => ipcRenderer.invoke('owner:lock'),
  getVersions: () => ipcRenderer.invoke('versions:get'),
  createProfile: data => ipcRenderer.invoke('profile:create', data),
  updateProfile: data => ipcRenderer.invoke('profile:update', data),
  deleteProfile: id => ipcRenderer.invoke('profile:delete', id),
  openProfileFolder: id => ipcRenderer.invoke('profile:open', id),
  pubGet: () => ipcRenderer.invoke('pub:get'),
  pubSet: d => ipcRenderer.invoke('pub:set', d),
  onPublishProgress: cb => ipcRenderer.on('pub:progress', (_e, m) => cb(m)),
  publishPack: () => ipcRenderer.invoke('pack:publish'),
  exportPack: () => ipcRenderer.invoke('pack:export'),
  installMenuMods: starter => ipcRenderer.invoke('mods:menu', !!starter),
  faceGet: n => ipcRenderer.invoke('face:get', n),
  eventsList: () => ipcRenderer.invoke('events:list'),
  eventsSave: l => ipcRenderer.invoke('events:save', l),
  socialStatus: () => ipcRenderer.invoke('social:status'),
  socialSetUrl: u => ipcRenderer.invoke('social:setUrl', u),
  socialCall: (p, b) => ipcRenderer.invoke('social:call', p, b),
  profileMe: () => ipcRenderer.invoke('profile:me'),
  friendsList: () => ipcRenderer.invoke('friends:list'),
  friendsAdd: n => ipcRenderer.invoke('friends:add', n),
  friendsRemove: id => ipcRenderer.invoke('friends:remove', id),
  chooseBanner: id => ipcRenderer.invoke('profile:banner', id),
  chooseLogo: id => ipcRenderer.invoke('profile:logo', id),
  chooseIcon: id => ipcRenderer.invoke('profile:icon', id),
  openDataFolder: () => ipcRenderer.invoke('data:open'),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  appRestore: () => ipcRenderer.invoke('app:restore'),
  onAppUpdate: cb => on('app:update', cb),
  repair: () => ipcRenderer.invoke('repair:run'),
  getSkin: () => ipcRenderer.invoke('skin:get'),
  checkJava: () => ipcRenderer.invoke('java:check'),
  chooseJava: () => ipcRenderer.invoke('java:choose'),
  play: mode => ipcRenderer.invoke('play', mode),
  onProgress: cb => on('chilet:progress', cb),
  onLog: cb => on('chilet:log', cb),
  onRefresh: cb => on('chilet:refresh', cb),
  onClosed: cb => on('chilet:closed', cb)
});
