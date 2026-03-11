'use strict';
/**
 * Mock do módulo 'electron' para testes Jest.
 * Captura todos os handlers registrados via ipcMain para inspeção nos testes.
 */

const os = require('os');
const path = require('path');
const tmpDir = path.join(os.tmpdir(), 'ts4-test-userData');

const _ipcHandlers = {};
const _ipcOnHandlers = {};

const ipcMain = {
  handle: jest.fn((channel, handler) => {
    _ipcHandlers[channel] = handler;
  }),
  on: jest.fn((channel, handler) => {
    _ipcOnHandlers[channel] = handler;
  }),
};

const app = {
  getPath: jest.fn((name) => {
    const paths = {
      userData: tmpDir,
      temp:     os.tmpdir(),
      home:     os.homedir(),
    };
    return paths[name] || os.tmpdir();
  }),
  whenReady:                  jest.fn(() => Promise.resolve()),
  quit:                       jest.fn(),
  on:                         jest.fn(),
  requestSingleInstanceLock:  jest.fn(() => true), // always returns true (sole instance) in tests
  getVersion:                 jest.fn(() => '1.1.0'),
};

const nativeImage = {
  createFromPath: jest.fn(() => ({
    toPNG: jest.fn(() => Buffer.alloc(0)),
    isEmpty: jest.fn(() => true),
  })),
};

const BrowserWindow = jest.fn().mockImplementation(() => ({
  loadFile:     jest.fn(),
  show:         jest.fn(),
  once:         jest.fn(),
  on:           jest.fn(),
  getSize:      jest.fn(() => [1100, 720]),
  isMaximized:  jest.fn(() => false),
  isMinimized:  jest.fn(() => false),
  minimize:     jest.fn(),
  maximize:     jest.fn(),
  unmaximize:   jest.fn(),
  close:        jest.fn(),
  focus:        jest.fn(),
  restore:      jest.fn(),
  isDestroyed:  jest.fn(() => false),
  setMenuBarVisibility: jest.fn(),
  webContents: {
    on:   jest.fn(),
    send: jest.fn(),
  },
}));

const dialog = {
  showOpenDialog: jest.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
};

const shell = {
  trashItem: jest.fn(() => Promise.resolve()),
  openPath:  jest.fn(() => Promise.resolve()),
  showItemInFolder: jest.fn(),
};

module.exports = {
  app, BrowserWindow, ipcMain, dialog, shell, nativeImage,
  // Exposed for tests that need to call handlers directly
  _ipcHandlers,
  _ipcOnHandlers,
};
