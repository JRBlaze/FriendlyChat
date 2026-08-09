const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  fetchKickEmotes: (channel) => ipcRenderer.invoke('kick-fetch-emotes', channel),
  signInToYouTube: () => ipcRenderer.invoke('youtube-sign-in'),
  resolveYouTubeChannel: (query) => ipcRenderer.invoke('youtube-resolve-channel', query),
});
