/**
 * Testes de regressão para os 3 bugs corrigidos na auditoria de Março/2026:
 *
 * Bug 1 — mods:delete: falta Array.isArray — TypeError em input não-array
 * Bug 2 — conflicts:scan: falta isPathSafe — SEC-03 path traversal não bloqueado
 * Bug 3 — organize:scan: falta isPathSafe — SEC-03 path traversal não bloqueado
 */

require('../../main');

const { _ipcHandlers } = require('electron');

const fakeEvent = { sender: { send: () => {} } };

// ─── Bug 1: mods:delete — Array.isArray guard ─────────────────────────────────

describe('Bug 1 — mods:delete: guard Array.isArray', () => {
  test('retorna [] para input null (não lança TypeError)', async () => {
    await expect(_ipcHandlers['mods:delete'](fakeEvent, null)).resolves.toEqual([]);
  });

  test('retorna [] para input undefined (não lança TypeError)', async () => {
    await expect(_ipcHandlers['mods:delete'](fakeEvent, undefined)).resolves.toEqual([]);
  });

  test('retorna [] para input string (não lança TypeError)', async () => {
    await expect(_ipcHandlers['mods:delete'](fakeEvent, 'caminho.package')).resolves.toEqual([]);
  });

  test('retorna [] para input número (não lança TypeError)', async () => {
    await expect(_ipcHandlers['mods:delete'](fakeEvent, 42)).resolves.toEqual([]);
  });

  test('retorna [] para input objeto (não lança TypeError)', async () => {
    await expect(_ipcHandlers['mods:delete'](fakeEvent, { path: '/some/file.package' })).resolves.toEqual([]);
  });

  test('array vazio retorna array vazio sem erros', async () => {
    const result = await _ipcHandlers['mods:delete'](fakeEvent, []);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

// ─── Bug 2: conflicts:scan — SEC-03 path safety ───────────────────────────────

describe('Bug 2 — conflicts:scan: SEC-03 isPathSafe aplicado', () => {
  test('retorna [] para pasta fora das roots (path traversal)', async () => {
    const result = await _ipcHandlers['conflicts:scan'](fakeEvent, '/etc/passwd');
    expect(result).toEqual([]);
  });

  test('retorna [] para /etc', async () => {
    const result = await _ipcHandlers['conflicts:scan'](fakeEvent, '/etc');
    expect(result).toEqual([]);
  });

  test('retorna [] para pasta completamente fora das roots configuradas', async () => {
    const result = await _ipcHandlers['conflicts:scan'](fakeEvent, '/tmp/malicious');
    expect(result).toEqual([]);
  });

  test('retorna [] para input não-string (guarda de tipo)', async () => {
    const result = await _ipcHandlers['conflicts:scan'](fakeEvent, null);
    expect(result).toEqual([]);
  });

  test('retorna [] para string vazia', async () => {
    const result = await _ipcHandlers['conflicts:scan'](fakeEvent, '');
    expect(result).toEqual([]);
  });
});

// ─── Bug 3: organize:scan — SEC-03 path safety ───────────────────────────────

describe('Bug 3 — organize:scan: SEC-03 isPathSafe aplicado', () => {
  test('retorna [] quando modsFolder está fora das roots', async () => {
    const result = await _ipcHandlers['organize:scan'](fakeEvent, '/etc', '/tmp/tray');
    expect(result).toEqual([]);
  });

  test('retorna [] quando trayFolder está fora das roots', async () => {
    const result = await _ipcHandlers['organize:scan'](fakeEvent, '/tmp/mods', '/etc');
    expect(result).toEqual([]);
  });

  test('retorna [] quando ambas as pastas estão fora das roots', async () => {
    const result = await _ipcHandlers['organize:scan'](fakeEvent, '/etc/mods', '/etc/tray');
    expect(result).toEqual([]);
  });

  test('retorna [] para modsFolder não-string', async () => {
    const result = await _ipcHandlers['organize:scan'](fakeEvent, null, '/tmp/tray');
    expect(result).toEqual([]);
  });

  test('retorna [] para trayFolder não-string', async () => {
    const result = await _ipcHandlers['organize:scan'](fakeEvent, '/tmp/mods', null);
    expect(result).toEqual([]);
  });

  // Verifica consistência com organize:scan-scattered (que já tinha o guard)
  test('organize:scan tem mesmo comportamento SEC-03 que organize:scan-scattered', async () => {
    const unsafePath = '/etc/passwd';

    // Ambos devem retornar [] para path fora das roots
    const scanResult      = await _ipcHandlers['organize:scan'](fakeEvent, unsafePath, unsafePath);
    const scatteredResult = await _ipcHandlers['organize:scan-scattered'](fakeEvent, unsafePath);
    expect(scanResult).toEqual([]);
    expect(scatteredResult).toEqual([]);
  });
});

