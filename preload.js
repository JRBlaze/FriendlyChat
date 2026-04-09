const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  fetchKickEmotes: (channel) => ipcRenderer.invoke('kick-fetch-emotes', channel),
  logDebug: (line) => ipcRenderer.send('renderer-debug-log', line),
});
