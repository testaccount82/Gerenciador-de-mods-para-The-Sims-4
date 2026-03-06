'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (config) => ipcRenderer.invoke('config:set', config),

  // Mod scanning
  scanMods: (modsFolder) => ipcRenderer.invoke('mods:scan', modsFolder),
  scanTray: (trayFolder) => ipcRenderer.invoke('tray:scan', trayFolder),

  // Mod operations
  toggleMod: (filePath) => ipcRenderer.invoke('mods:toggle', filePath),
  toggleFolder: (folderPath, modsFolder) => ipcRenderer.invoke('mods:toggle-folder', folderPath, modsFolder),
  deleteMods: (filePaths) => ipcRenderer.invoke('mods:delete', filePaths),
  moveMod: (from, to) => ipcRenderer.invoke('mods:move', from, to),
  importFiles: (filePaths, modsFolder, trayFolder) =>
    ipcRenderer.invoke('mods:import', filePaths, modsFolder, trayFolder),

  // Undo-able mod deletion (moves to internal trash)
  trashModsBatch: (filePaths) => ipcRenderer.invoke('mods:trash-batch', filePaths),
  restoreModFromTrash: (trashPath, originalPath) => ipcRenderer.invoke('mods:restore-from-trash', trashPath, originalPath),

  // Conflict detection
  scanConflicts: (modsFolder) => ipcRenderer.invoke('conflicts:scan', modsFolder),
  cancelConflictScan: () => ipcRenderer.send('conflicts:cancel'),
  conflictMoveToTrash: (filePath) => ipcRenderer.invoke('conflicts:move-to-trash', filePath),
  conflictRestoreFromTrash: (trashPath, originalPath) => ipcRenderer.invoke('conflicts:restore-from-trash', trashPath, originalPath),
  onConflictProgress: (cb) => {
    ipcRenderer.on('conflicts:progress', (_e, data) => cb(data));
    return () => ipcRenderer.removeAllListeners('conflicts:progress');
  },

  // Auto-organizer
  scanMisplaced: (modsFolder, trayFolder) => ipcRenderer.invoke('organize:scan', modsFolder, trayFolder),
  fixMisplaced: (items) => ipcRenderer.invoke('organize:fix', items),
  scanScatteredGroups: (modsFolder) => ipcRenderer.invoke('organize:scan-scattered', modsFolder),
  fixOneMisplaced: (item) => ipcRenderer.invoke('organize:fix-one', item),
  scanEmptyFolders: (modsFolder, trayFolder) => ipcRenderer.invoke('organize:scan-empty-folders', modsFolder, trayFolder),
  deleteEmptyFolders: (folderPaths) => ipcRenderer.invoke('organize:delete-empty-folders', folderPaths),

  // Dialogs
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  openFilesDialog: (filters) => ipcRenderer.invoke('dialog:open-files', filters),

  // Shell
  openInExplorer: (folderPath) => ipcRenderer.invoke('shell:open', folderPath),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:show-item', filePath),

  // Filesystem
  pathExists: (folderPath) => ipcRenderer.invoke('fs:exists', folderPath),

  // Thumbnails
  getThumbnail: (filePath) => ipcRenderer.invoke('thumbnail:get', filePath),
  purgeThumbnailCache: (existingPaths) => ipcRenderer.invoke('thumbnail:purge-cache', existingPaths),
  clearThumbnailCache: () => ipcRenderer.invoke('thumbnail:clear-cache'),

  // App icon (for titlebar)
  getIcon: () => ipcRenderer.invoke('icon:get'),

  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized')
});
