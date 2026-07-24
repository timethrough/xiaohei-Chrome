const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ops', Object.freeze({
  getInfo: () => ipcRenderer.invoke('system:info'),
  getProfileStorage: () => ipcRenderer.invoke('system:get-storage'),
  chooseProfileStorage: () => ipcRenderer.invoke('system:choose-storage'),
  resetProfileStorage: () => ipcRenderer.invoke('system:reset-storage'),
  openProfileStorage: () => ipcRenderer.invoke('system:open-storage'),
  copyText: (value) => ipcRenderer.invoke('system:copy-text', value),
  getApiInfo: () => ipcRenderer.invoke('api:info'),
  resetApiKey: () => ipcRenderer.invoke('api:reset-key'),
  setApiEnabled: (enabled) => ipcRenderer.invoke('api:set-enabled', enabled),
  openSkillFolder: () => ipcRenderer.invoke('api:open-skill'),
  syncProfiles: (profiles) => ipcRenderer.invoke('profiles:sync', profiles),
  deleteProfiles: (ids, deleteData) => ipcRenderer.invoke('profiles:delete', { ids, deleteData }),
  startProfile: (profile) => ipcRenderer.invoke('profiles:start', profile),
  stopProfile: (id) => ipcRenderer.invoke('profiles:stop', id),
  profileStatus: () => ipcRenderer.invoke('profiles:status'),
  testProfileProxy: (profile) => ipcRenderer.invoke('profiles:test-proxy', profile),
  checkProfileProxy: (profile) => ipcRenderer.invoke('profiles:check-proxy', profile),
  extensionList: () => ipcRenderer.invoke('extensions:list'),
  addExtensionFolder: () => ipcRenderer.invoke('extensions:add-folder'),
  addExtensionStore: (url, profileIds, restart) => ipcRenderer.invoke('extensions:add-store', { url, profileIds, restart }),
  assignExtension: (extensionId, profileIds, enabled) => ipcRenderer.invoke('extensions:assign', { extensionId, profileIds, enabled }),
  toggleExtensionAll: (extensionId, enabled) => ipcRenderer.invoke('extensions:toggle-all', { extensionId, enabled }),
  removeExtension: (id) => ipcRenderer.invoke('extensions:remove', id),
  syncSessions: () => ipcRenderer.invoke('sync:sessions'),
  setSyncSelection: (ids) => ipcRenderer.invoke('sync:selection', ids),
  getSyncState: () => ipcRenderer.invoke('sync:state'),
  getSyncSettings: () => ipcRenderer.invoke('sync:settings:get'),
  setSyncSettings: (settings) => ipcRenderer.invoke('sync:settings:set', settings),
  startSync: (ids) => ipcRenderer.invoke('sync:start', ids),
  stopSync: () => ipcRenderer.invoke('sync:stop'),
  restartSync: () => ipcRenderer.invoke('sync:restart'),
  windowAction: (ids, action) => ipcRenderer.invoke('sync:window', { ids, action }),
  textAction: (ids, action, text, delayMin, delayMax) => ipcRenderer.invoke('sync:text', { ids, action, text, delayMin, delayMax }),
  batchTextAction: (ids, texts, delayMin, delayMax) => ipcRenderer.invoke('sync:text-batch', { ids, texts, delayMin, delayMax }),
  tabAction: (ids, action, payload) => ipcRenderer.invoke('sync:tabs', { ids, action, payload }),
  onEvent: (callback) => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('engine:event', handler);
    return () => ipcRenderer.removeListener('engine:event', handler);
  }
}));
