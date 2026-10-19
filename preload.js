const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexus', {
  getLocalInfo: () => ipcRenderer.invoke('get-local-info'),
  scanNetwork: (opts) => ipcRenderer.invoke('scan-network', opts),
  scanPorts: (opts) => ipcRenderer.invoke('scan-ports', opts),
  monitorStart: (opts) => ipcRenderer.invoke('monitor-start', opts),
  monitorStop: () => ipcRenderer.invoke('monitor-stop'),
  loadState: () => ipcRenderer.invoke('load-state'),
  saveState: (state) => ipcRenderer.invoke('save-state', state),
  exportData: (opts) => ipcRenderer.invoke('export-data', opts),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onProgress: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('scan-progress', h);
    return () => ipcRenderer.removeListener('scan-progress', h);
  },
  onMonitor: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('monitor-update', h);
    return () => ipcRenderer.removeListener('monitor-update', h);
  }
});
