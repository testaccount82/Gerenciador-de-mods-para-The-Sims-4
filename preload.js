'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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

  // Internal Trash management
  trashList: () => ipcRenderer.invoke('trash:list'),
  trashRestore: (trashPath, originalPath) => ipcRenderer.invoke('trash:restore', trashPath, originalPath),
  trashDeletePermanent: (trashPath) => ipcRenderer.invoke('trash:delete-permanent', trashPath),
  trashEmpty: () => ipcRenderer.invoke('trash:empty'),

  // Conflict detection
  scanConflicts: (modsFolder, trayFolder) => ipcRenderer.invoke('conflicts:scan', modsFolder, trayFolder),
  cancelConflictScan: () => ipcRenderer.send('conflicts:cancel'),
  conflictMoveToTrash: (filePath) => ipcRenderer.invoke('conflicts:move-to-trash', filePath),
  conflictRestoreFromTrash: (trashPath, originalPath) => ipcRenderer.invoke('conflicts:restore-from-trash', trashPath, originalPath),
  onConflictProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('conflicts:progress', listener);
    return () => ipcRenderer.off('conflicts:progress', listener);
  },

  // Auto-organizer
  scanMisplaced: (modsFolder, trayFolder) => ipcRenderer.invoke('organize:scan', modsFolder, trayFolder),
  fixMisplaced: (items) => ipcRenderer.invoke('organize:fix', items),
  scanScatteredGroups: (modsFolder) => ipcRenderer.invoke('organize:scan-scattered', modsFolder),
  fixOneMisplaced: (item) => ipcRenderer.invoke('organize:fix-one', item),
  scanEmptyFolders: (modsFolder, trayFolder) => ipcRenderer.invoke('organize:scan-empty-folders', modsFolder, trayFolder),
  deleteEmptyFolders: (folderPaths) => ipcRenderer.invoke('organize:delete-empty-folders', folderPaths),
  restoreEmptyFolders: (folderPaths) => ipcRenderer.invoke('organize:restore-empty-folders', folderPaths),
  scanInvalidFiles: (modsFolder, trayFolder) => ipcRenderer.invoke('organize:scan-invalid', modsFolder, trayFolder),
  deleteInvalidFiles: (filePaths) => ipcRenderer.invoke('organize:delete-invalid', filePaths),

  // Dialogs
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),
  openFilesDialog: (filters) => ipcRenderer.invoke('dialog:open-files', filters),

  // Resolves a dragged File object to its real filesystem path (Electron sandbox-safe)
  getPathForFile: (file) => webUtils.getPathForFile(file),

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

  // App version
  getAppVersion: () => ipcRenderer.invoke('app:version'),

  // Debug
  getDebugStatus:   ()           => ipcRenderer.invoke('debug:get-status'),
  setDebugEnabled:  (value)      => ipcRenderer.invoke('debug:set-enabled', value),
  openDebugWindow:  ()           => ipcRenderer.invoke('debug:open-window'),
  openDebugLogFile: ()           => ipcRenderer.invoke('debug:open-log-file'),
  openUserDataFolder: ()         => ipcRenderer.invoke('shell:open-userdata'),
  openLogsFolder:     ()         => ipcRenderer.invoke('shell:open-logs'),
  getErrorLogStatus:  ()         => ipcRenderer.invoke('errorlog:get-status'),
  setErrorLog:        (opts)     => ipcRenderer.invoke('errorlog:set', opts),
  // Envia lote de entradas de log (fire-and-forget, sem roundtrip de resposta)
  debugLogBatch:    (entries)    => ipcRenderer.send('debug:log-batch', entries),

  // Escuta eventos de progresso de importação enviados pelo main process
  onImportProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('import:progress', listener);
    return () => ipcRenderer.off('import:progress', listener);
  },

  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized')
});
