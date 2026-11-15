const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bookAPI', {
  openBook: () => ipcRenderer.invoke('open-book'),
  getStartupFile: () => ipcRenderer.invoke('get-startup-file'),
  readBook: filePath => ipcRenderer.invoke('read-book', filePath),
  parseDocument: filePath => ipcRenderer.invoke('parse-document', filePath)
});
