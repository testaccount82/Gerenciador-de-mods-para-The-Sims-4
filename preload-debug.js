'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('debugApi', {
  getLog:      ()         => ipcRenderer.invoke('debug:get-log'),
  clearLog:    ()         => ipcRenderer.invoke('debug:clear-log'),
  openLogFile: ()         => ipcRenderer.invoke('debug:open-log-file'),
  getStatus:   ()         => ipcRenderer.invoke('debug:get-status'),

  // Real-time new log lines pushed from main process
  onLine: (cb) => {
    const listener = (_e, line) => cb(line);
    ipcRenderer.on('debug:line', listener);
    return () => ipcRenderer.off('debug:line', listener);
  }
});
