const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  state: () => ipcRenderer.invoke('state'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  resetIdentity: () => ipcRenderer.invoke('config:reset'),
  listScreens: () => ipcRenderer.invoke('screens:list'),
  selectScreen: (id) => ipcRenderer.invoke('screens:select', id),
  cursor: (displayId) => ipcRenderer.invoke('cursor', displayId),
  input: (msg) => ipcRenderer.send('input', msg),
  releaseInput: () => ipcRenderer.send('input:release'),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  setActiveSessions: (n) => ipcRenderer.send('sessions:active', n),
  requestPermission: (kind) => ipcRenderer.invoke('perm:request', kind),
  onStateChanged: (fn) => ipcRenderer.on('state-changed', () => fn()),
});
