// Preload script - secure bridge, currently empty but ready for future IPC
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('mangaStudio', {
  version: '1.3.12',
  isElectron: true,
  platform: process.platform
});
