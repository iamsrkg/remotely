const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  done: (report) => ipcRenderer.send('done', report),
  cursor: () => ipcRenderer.invoke('cursor'),
});
