const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  fetchKickEmotes: (channel) => ipcRenderer.invoke('kick-fetch-emotes', channel),
});
