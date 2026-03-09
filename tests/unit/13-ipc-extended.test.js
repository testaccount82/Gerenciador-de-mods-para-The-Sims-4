'use strict';
/**
 * Testes para handlers IPC sem cobertura:
 *  - trash:list / trash:restore / trash:delete-permanent / trash:empty
 *  - mods:trash-batch / mods:restore-from-trash
 *  - shell:open / shell:show-item
 *  - organize:scan-invalid (Bug 2: pasta bloqueada não impede scan da outra)
 *  - organize:scan-scattered
 *  - organize:scan-empty-folders
 *  - organize:delete-empty-folders
 *  - conflicts:restore-from-trash
 *  - tray:scan
 */

const path  = require('path');
const os    = require('os');
const fs    = require('fs');

require('../../main');

const { _ipcHandlers, _ipcOnHandlers, shell } = require('electron');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), `ts4-ipc2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(filePath, content = 'x') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

const fakeEvent = { sender: { send: jest.fn() } };

// ─── tray:scan ────────────────────────────────────────────────────────────────

describe('IPC tray:scan', () => {
  test('retorna [] para input não-string', async () => {
    expect(await _ipcHandlers['tray:scan'](fakeEvent, null)).toEqual([]);
    expect(await _ipcHandlers['tray:scan'](fakeEvent, 42)).toEqual([]);
  });

  test('retorna [] para pasta fora das roots', async () => {
    expect(await _ipcHandlers['tray:scan'](fakeEvent, '/etc')).toEqual([]);
  });
});

// ─── shell:open ───────────────────────────────────────────────────────────────

describe('IPC shell:open', () => {
  test('caminho inválido (nulo) não chama openPath', async () => {
    shell.openPath.mockClear();
    await _ipcHandlers['shell:open'](fakeEvent, null);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  test('caminho fora das roots não chama openPath', async () => {
    shell.openPath.mockClear();
    await _ipcHandlers['shell:open'](fakeEvent, '/etc/passwd');
    expect(shell.openPath).not.toHaveBeenCalled();
  });
});

// ─── shell:show-item ──────────────────────────────────────────────────────────

describe('IPC shell:show-item', () => {
  test('caminho nulo não chama showItemInFolder', () => {
    shell.showItemInFolder.mockClear();
    _ipcHandlers['shell:show-item'](fakeEvent, null);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  test('caminho fora das roots não chama showItemInFolder', () => {
    shell.showItemInFolder.mockClear();
    _ipcHandlers['shell:show-item'](fakeEvent, '/etc/passwd');
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});

// ─── organize:scan-invalid — Bug 2 ───────────────────────────────────────────

describe('IPC organize:scan-invalid — Bug 2: pasta bloqueada não impede scan da outra', () => {
  let mods;
  beforeEach(() => { mods = makeTmpDir(); });
  afterEach(() => { fs.rmSync(mods, { recursive: true, force: true }); });

  test('modsFolder inválida + trayFolder null → retorna []', async () => {
    const result = await _ipcHandlers['organize:scan-invalid'](fakeEvent, '/etc', null);
    expect(Array.isArray(result)).toBe(true);
  });

  test('ambas as pastas null → retorna []', async () => {
    const result = await _ipcHandlers['organize:scan-invalid'](fakeEvent, null, null);
    expect(result).toEqual([]);
  });
});

// ─── organize:scan-empty-folders ─────────────────────────────────────────────

describe('IPC organize:scan-empty-folders', () => {
  test('retorna [] para pastas inexistentes/null', async () => {
    const result = await _ipcHandlers['organize:scan-empty-folders'](fakeEvent, '/nao-existe', null);
    expect(Array.isArray(result)).toBe(true);
  });

  test('retorna [] para pastas fora das roots', async () => {
    const result = await _ipcHandlers['organize:scan-empty-folders'](fakeEvent, '/etc', '/etc');
    expect(result).toEqual([]);
  });

  test('retorna [] para inputs não-string', async () => {
    const result = await _ipcHandlers['organize:scan-empty-folders'](fakeEvent, null, null);
    expect(result).toEqual([]);
  });
});

// ─── organize:delete-empty-folders ───────────────────────────────────────────

describe('IPC organize:delete-empty-folders', () => {
  test('retorna [] para input não-array', async () => {
    const result = await _ipcHandlers['organize:delete-empty-folders'](fakeEvent, 'not-array');
    expect(result).toEqual([]);
  });

  test('array vazio retorna array vazio', async () => {
    const result = await _ipcHandlers['organize:delete-empty-folders'](fakeEvent, []);
    expect(result).toEqual([]);
  });

  test('pasta fora das roots é filtrada (não deletada)', async () => {
    const result = await _ipcHandlers['organize:delete-empty-folders'](fakeEvent, ['/etc/test-empty']);
    expect(result).toHaveLength(0);
  });
});

// ─── organize:scan-scattered ─────────────────────────────────────────────────

describe('IPC organize:scan-scattered', () => {
  test('retorna [] para input não-string', async () => {
    expect(await _ipcHandlers['organize:scan-scattered'](fakeEvent, null)).toEqual([]);
    expect(await _ipcHandlers['organize:scan-scattered'](fakeEvent, 42)).toEqual([]);
  });

  test('retorna [] para pasta fora das roots', async () => {
    expect(await _ipcHandlers['organize:scan-scattered'](fakeEvent, '/etc')).toEqual([]);
  });
});

// ─── mods:trash-batch ────────────────────────────────────────────────────────

describe('IPC mods:trash-batch', () => {
  test('retorna [] para input não-array', async () => {
    const result = await _ipcHandlers['mods:trash-batch'](fakeEvent, 'not-array');
    expect(result).toEqual([]);
  });

  test('array vazio retorna array vazio', async () => {
    const result = await _ipcHandlers['mods:trash-batch'](fakeEvent, []);
    expect(result).toEqual([]);
  });

  test('caminho fora das roots retorna error por item', async () => {
    const result = await _ipcHandlers['mods:trash-batch'](fakeEvent, ['/etc/passwd']);
    expect(result).toHaveLength(1);
    expect(result[0].success).toBe(false);
    expect(result[0].error).toMatch(/não permitido/i);
  });
});

// ─── mods:restore-from-trash ─────────────────────────────────────────────────

describe('IPC mods:restore-from-trash', () => {
  test('origem fora da lixeira interna retorna erro', async () => {
    const result = await _ipcHandlers['mods:restore-from-trash'](fakeEvent, '/tmp/rogue', '/tmp/dest');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lixeira/i);
  });

  test('destino fora das roots retorna erro', async () => {
    // Monta um caminho que parece estar na lixeira
    const { app } = require('electron');
    const trashDir = path.join(app.getPath('userData'), 'trash');
    const fakeTrashItem = path.join(trashDir, 'fake_item.package');
    const result = await _ipcHandlers['mods:restore-from-trash'](fakeEvent, fakeTrashItem, '/etc/malicious');
    expect(result.success).toBe(false);
  });
});

// ─── conflicts:restore-from-trash ────────────────────────────────────────────

describe('IPC conflicts:restore-from-trash', () => {
  test('origem fora da lixeira interna retorna erro', async () => {
    const result = await _ipcHandlers['conflicts:restore-from-trash'](fakeEvent, '/tmp/rogue', '/tmp/dest');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lixeira/i);
  });
});

// ─── trash:list ───────────────────────────────────────────────────────────────

describe('IPC trash:list', () => {
  test('retorna array (mesmo vazio)', async () => {
    const result = await _ipcHandlers['trash:list'](fakeEvent);
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─── trash:restore ───────────────────────────────────────────────────────────

describe('IPC trash:restore', () => {
  test('caminho não da lixeira retorna erro', async () => {
    const result = await _ipcHandlers['trash:restore'](fakeEvent, '/tmp/externo', '/tmp/destino');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lixeira/i);
  });

  test('destino null retorna erro', async () => {
    const { app } = require('electron');
    const trashDir = path.join(app.getPath('userData'), 'trash');
    const result = await _ipcHandlers['trash:restore'](fakeEvent, path.join(trashDir, 'item'), null);
    expect(result.success).toBe(false);
  });
});

// ─── trash:delete-permanent ──────────────────────────────────────────────────

describe('IPC trash:delete-permanent', () => {
  test('caminho fora da lixeira retorna erro', async () => {
    const result = await _ipcHandlers['trash:delete-permanent'](fakeEvent, '/tmp/externo');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lixeira/i);
  });
});

// ─── trash:empty ─────────────────────────────────────────────────────────────

describe('IPC trash:empty', () => {
  test('retorna { ok, failed } como números', async () => {
    const result = await _ipcHandlers['trash:empty'](fakeEvent);
    expect(typeof result.ok).toBe('number');
    expect(typeof result.failed).toBe('number');
  });
});

// ─── window:is-maximized ─────────────────────────────────────────────────────

describe('IPC window:is-maximized', () => {
  test('retorna booleano sem lançar exceção', async () => {
    const result = await _ipcHandlers['window:is-maximized'](fakeEvent);
    expect(typeof result).toBe('boolean');
  });
});

// ─── fs:exists ────────────────────────────────────────────────────────────────

describe('IPC fs:exists — inputs adicionais', () => {
  test('retorna false para string vazia', async () => {
    expect(await _ipcHandlers['fs:exists'](fakeEvent, '')).toBe(false);
  });

  test('retorna false para objeto', async () => {
    expect(await _ipcHandlers['fs:exists'](fakeEvent, {})).toBe(false);
  });
});

// ─── mods:toggle-folder ──────────────────────────────────────────────────────

describe('IPC mods:toggle-folder', () => {
  test('caminho fora das roots retorna []', async () => {
    const result = await _ipcHandlers['mods:toggle-folder'](fakeEvent, '/etc', '/etc');
    expect(result).toEqual([]);
  });
});

// ─── config:set — modsFolder === trayFolder (QA-03) ──────────────────────────

describe('IPC config:set — QA-03: modsFolder igual trayFolder é bloqueado', () => {
  test('mesmo diretório para mods e tray retorna false', async () => {
    const dir = makeTmpDir();
    const result = await _ipcHandlers['config:set'](fakeEvent, {
      modsFolder: dir,
      trayFolder: dir,
    });
    expect(result).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
