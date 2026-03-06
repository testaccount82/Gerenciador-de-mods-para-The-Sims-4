'use strict';
/**
 * QA-03 — Testes para os handlers IPC críticos registrados no main.js.
 *
 * Usa o mock do Electron (tests/__mocks__/electron.js) que captura todos os
 * handlers em _ipcHandlers, permitindo invocá-los diretamente nos testes.
 *
 * Cobre:
 *  - SEC-01/QA-05: organize:fix com caminhos fora das roots
 *  - SEC-02/QA-06: mods:import com tipos inválidos e destinos fora das roots
 *  - SEC-03: mods:scan com pasta fora das roots
 *  - QA-02: thumbnail:clear-cache preserva __version
 *  - config:set bloqueio de campos inválidos
 *  - mods:toggle bloqueio de path fora das roots
 *  - mods:delete bloqueio de path fora das roots
 *  - mods:move bloqueio de paths fora das roots
 *  - organize:fix-one bloqueio de paths fora das roots
 *  - conflicts:move-to-trash bloqueio de path fora das roots
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');

// Carrega o main.js (que registra os handlers no ipcMain mockado)
require('../../main');

const { _ipcHandlers } = require('electron');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), `ts4-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(filePath, content = 'x') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

// Stub de evento IPC (o primeiro argumento dos handlers)
const fakeEvent = { sender: { send: jest.fn() } };

// ─── config:set ──────────────────────────────────────────────────────────────

describe('IPC config:set — validação de entrada', () => {
  test('retorna false para input não-objeto', async () => {
    expect(await _ipcHandlers['config:set'](fakeEvent, null)).toBe(false);
    expect(await _ipcHandlers['config:set'](fakeEvent, 'string')).toBe(false);
    expect(await _ipcHandlers['config:set'](fakeEvent, 42)).toBe(false);
  });

  test('retorna false se campo string receber não-string', async () => {
    expect(await _ipcHandlers['config:set'](fakeEvent, { theme: 42 })).toBe(false);
    expect(await _ipcHandlers['config:set'](fakeEvent, { modsFolder: null })).toBe(false);
  });

  test('retorna false ao tentar apontar modsFolder para homedir', async () => {
    const result = await _ipcHandlers['config:set'](fakeEvent, { modsFolder: os.homedir() });
    expect(result).toBe(false);
  });

  test('aceita config válida', async () => {
    const tmpDir = makeTmpDir();
    const result = await _ipcHandlers['config:set'](fakeEvent, { modsFolder: path.join(tmpDir, 'Mods') });
    // Pode ser true ou false dependendo de outros campos, mas não deve lançar
    expect(typeof result).toBe('boolean');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── mods:scan — SEC-03 ───────────────────────────────────────────────────────

describe('IPC mods:scan — SEC-03: whitelist de pastas', () => {
  test('retorna [] para input não-string', async () => {
    expect(await _ipcHandlers['mods:scan'](fakeEvent, null)).toEqual([]);
    expect(await _ipcHandlers['mods:scan'](fakeEvent, 42)).toEqual([]);
    expect(await _ipcHandlers['mods:scan'](fakeEvent, '')).toEqual([]);
  });

  test('retorna [] para pasta completamente fora das roots (path traversal)', async () => {
    // /etc não é pasta de mods — deve ser bloqueada pela whitelist
    const result = await _ipcHandlers['mods:scan'](fakeEvent, '/etc');
    expect(result).toEqual([]);
  });

  test('retorna [] para pasta fora das roots configuradas', async () => {
    const tmpDir = makeTmpDir();
    const result = await _ipcHandlers['mods:scan'](fakeEvent, tmpDir);
    // Pasta temporária não está nas roots do config → deve bloquear
    expect(result).toEqual([]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── mods:toggle — path safety ───────────────────────────────────────────────

describe('IPC mods:toggle — validação de path', () => {
  test('retorna erro para path fora das roots (/etc/passwd)', async () => {
    const result = await _ipcHandlers['mods:toggle'](fakeEvent, '/etc/passwd');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/não permitido/i);
  });

  test('retorna erro para path null', async () => {
    const result = await _ipcHandlers['mods:toggle'](fakeEvent, null);
    expect(result.success).toBe(false);
  });
});

// ─── mods:delete — path safety ───────────────────────────────────────────────

describe('IPC mods:delete — validação de paths', () => {
  test('retorna erro para path fora das roots', async () => {
    const results = await _ipcHandlers['mods:delete'](fakeEvent, ['/etc/passwd']);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/não permitido/i);
  });

  test('retorna array vazio para input vazio', async () => {
    const results = await _ipcHandlers['mods:delete'](fakeEvent, []);
    expect(results).toEqual([]);
  });
});

// ─── mods:move — path safety ─────────────────────────────────────────────────

describe('IPC mods:move — validação de paths', () => {
  test('retorna erro quando origem está fora das roots', async () => {
    const result = await _ipcHandlers['mods:move'](fakeEvent, '/etc/shadow', '/tmp/dest.package');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/não permitido/i);
  });

  test('retorna erro quando destino está fora das roots', async () => {
    const result = await _ipcHandlers['mods:move'](fakeEvent, '/tmp/mod.package', '/etc/mod.package');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/não permitido/i);
  });
});

// ─── mods:import — SEC-02 + QA-06 ────────────────────────────────────────────

describe('IPC mods:import — SEC-02 + QA-06', () => {
  test('retorna {} vazio para filePaths não-array', async () => {
    const result = await _ipcHandlers['mods:import'](fakeEvent, null, '/tmp/Mods', '/tmp/Tray');
    expect(result).toEqual({ imported: [], errors: [] });
  });

  test('retorna erro para modsFolder não-string', async () => {
    const result = await _ipcHandlers['mods:import'](fakeEvent, [], 42, '/tmp/Tray');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('retorna erro quando modsFolder está fora das roots', async () => {
    const result = await _ipcHandlers['mods:import'](fakeEvent, [], '/etc', '/etc');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toMatch(/não permitida/i);
  });

  test('aceita array vazio sem erros quando pastas estão nas roots', async () => {
    const { writeConfig, DEFAULT_CONFIG } = require('../../main');
    const tmpMods = makeTmpDir();
    const tmpTray = makeTmpDir();
    // Escreve config com as pastas temporárias como roots permitidas
    writeConfig({ ...DEFAULT_CONFIG, modsFolder: tmpMods, trayFolder: tmpTray });
    try {
      const result = await _ipcHandlers['mods:import'](fakeEvent, [], tmpMods, tmpTray);
      expect(result.imported).toEqual([]);
      expect(result.errors).toEqual([]);
    } finally {
      fs.rmSync(tmpMods, { recursive: true, force: true });
      fs.rmSync(tmpTray, { recursive: true, force: true });
    }
  });
});

// ─── organize:fix — SEC-01 + QA-05 ───────────────────────────────────────────

describe('IPC organize:fix — SEC-01 + QA-05', () => {
  test('retorna erro para items não-array', async () => {
    const result = await _ipcHandlers['organize:fix'](fakeEvent, null);
    expect(result).toEqual([]);
  });

  test('retorna erro quando path está fora das roots', async () => {
    const items = [{ path: '/etc/passwd', suggestedDest: '/tmp/dest' }];
    const result = await _ipcHandlers['organize:fix'](fakeEvent, items);
    expect(result[0].success).toBe(false);
    expect(result[0].error).toMatch(/não permitido/i);
  });

  test('retorna erro quando suggestedDest está fora das roots', async () => {
    const items = [{ path: '/tmp/mod.package', suggestedDest: '/etc/mod.package' }];
    const result = await _ipcHandlers['organize:fix'](fakeEvent, items);
    expect(result[0].success).toBe(false);
  });

  test('retorna erro para item sem campos obrigatórios', async () => {
    const result = await _ipcHandlers['organize:fix'](fakeEvent, [{ path: '/tmp/x' }]);
    expect(result[0].success).toBe(false);
  });

  test('array vazio retorna array vazio', async () => {
    const result = await _ipcHandlers['organize:fix'](fakeEvent, []);
    expect(result).toEqual([]);
  });
});

// ─── organize:fix-one ────────────────────────────────────────────────────────

describe('IPC organize:fix-one — validação de paths', () => {
  test('retorna erro para item inválido (sem path)', async () => {
    const result = await _ipcHandlers['organize:fix-one'](fakeEvent, { suggestedDest: '/tmp/x' });
    expect(result.success).toBe(false);
  });

  test('retorna erro para path fora das roots', async () => {
    const result = await _ipcHandlers['organize:fix-one'](fakeEvent, {
      path: '/etc/passwd', suggestedDest: '/tmp/dest'
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/não permitido/i);
  });
});

// ─── conflicts:move-to-trash ─────────────────────────────────────────────────

describe('IPC conflicts:move-to-trash — validação de path', () => {
  test('retorna erro para path fora das roots', async () => {
    const result = await _ipcHandlers['conflicts:move-to-trash'](fakeEvent, '/etc/passwd');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/não permitido/i);
  });
});

// ─── thumbnail:clear-cache — QA-02 ───────────────────────────────────────────

describe('IPC thumbnail:clear-cache — QA-02', () => {
  test('após clear-cache o objeto em memória tem __version', async () => {
    const result = await _ipcHandlers['thumbnail:clear-cache'](fakeEvent);
    expect(result).toBe(true);

    // Verifica que o cache em memória tem __version preservada
    const { loadThumbnailCache, THUMBNAIL_CACHE_VERSION } = require('../../main');
    // Força reload do cache para garantir estado fresco
    const cache = loadThumbnailCache();
    // __version deve existir (não pode ser undefined)
    expect(cache.__version).toBeDefined();
  });
});

// ─── fs:exists ───────────────────────────────────────────────────────────────

describe('IPC fs:exists — inputs inválidos', () => {
  test('retorna false para null', async () => {
    expect(await _ipcHandlers['fs:exists'](fakeEvent, null)).toBe(false);
  });

  test('retorna false para número', async () => {
    expect(await _ipcHandlers['fs:exists'](fakeEvent, 42)).toBe(false);
  });

  test('retorna false para pasta inexistente', async () => {
    expect(await _ipcHandlers['fs:exists'](fakeEvent, '/caminho/que/nao/existe/xyz')).toBe(false);
  });

  test('retorna true para pasta que existe', async () => {
    const dir = makeTmpDir();
    expect(await _ipcHandlers['fs:exists'](fakeEvent, dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
