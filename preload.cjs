const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('archiveLogin', Object.freeze({
  get: () => ipcRenderer.invoke('saved-login:get'),
  save: credentials => ipcRenderer.invoke('saved-login:save', credentials),
  clear: () => ipcRenderer.invoke('saved-login:clear'),
  getUsernames: () => ipcRenderer.invoke('saved-usernames:get'),
  rememberUsername: username => ipcRenderer.invoke('saved-usernames:add', username)
}));

contextBridge.exposeInMainWorld('archiveBackup', Object.freeze({
  chooseExternalFolder: () => ipcRenderer.invoke('backup:choose-external-folder')
}));
