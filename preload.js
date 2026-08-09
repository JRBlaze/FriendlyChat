const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  fetchKickEmotes: (channel) => ipcRenderer.invoke('kick-fetch-emotes', channel),
  signInToYouTube: () => ipcRenderer.invoke('youtube-sign-in'),
  resolveYouTubeChannel: (query) => ipcRenderer.invoke('youtube-resolve-channel', query),

  // Updates
  getUpdateEnvironment: () => ipcRenderer.invoke('update-environment'),
  downloadUpdate: (asset) => ipcRenderer.invoke('update-download', asset),
  installUpdate: (filePath) => ipcRenderer.invoke('update-install', filePath),
  // Returns an unsubscribe function so the renderer never leaks listeners.
  onUpdateProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('update-download-progress', handler);
    return () => ipcRenderer.removeListener('update-download-progress', handler);
  },
});
