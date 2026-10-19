const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexus', {
  getLocalInfo: () => ipcRenderer.invoke('get-local-info'),
  scanNetwork: (opts) => ipcRenderer.invoke('scan-network', opts),
  scanPorts: (opts) => ipcRenderer.invoke('scan-ports', opts),
  onProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('scan-progress', h);
    return () => ipcRenderer.removeListener('scan-progress', h);
  }
});
