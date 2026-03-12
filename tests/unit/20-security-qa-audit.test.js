'use strict';
/**
 * Testes de auditoria de segurança e QA — Março 2026
 *
 * Cobre todos os problemas identificados na auditoria extensiva:
 *   SEC-001 — getAllowedRoots inclui tempFolder
 *   SEC-002 — mods:import: limite máximo de filePaths (DoS guard)
 *   SEC-003 — mods:import: elementos devem ser strings
 *   QA-001  — config:set: windowBounds validado (min/max/tipo)
 *   QA-002  — mods:toggle-folder: modsFolder validado com isPathSafe
 *   QA-003  — Conflitos hash-duplicate: IDs usam SHA-256 (consistência)
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ── Setup ───────────────────────────────────────────────────────────────────
// Carrega main.js no ambiente de teste (NODE_ENV=test já é definido pelo Jest/setup)
const {
  isPathSafe,
  readConfig,
  writeConfig,
  DEFAULT_CONFIG,
  scanConflicts,
} = require('../../main.js');

const { _ipcHandlers } = require('electron');

// ── SEC-001: getAllowedRoots inclui tempFolder ─────────────────────────────

describe('SEC-001 — getAllowedRoots inclui tempFolder', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts4-sec001-'));
    // Configura tempFolder para um diretório controlado
    const cfg = readConfig();
    cfg.modsFolder = path.join(tmpDir, 'Mods');
    cfg.trayFolder = path.join(tmpDir, 'Tray');
    cfg.tempFolder = path.join(tmpDir, 'temp');
    writeConfig(cfg);
    fs.mkdirSync(cfg.modsFolder, { recursive: true });
    fs.mkdirSync(cfg.trayFolder, { recursive: true });
    fs.mkdirSync(cfg.tempFolder, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('fs:exists aceita caminho dentro do tempFolder configurado', async () => {
    const cfg = readConfig();
    const subPath = path.join(cfg.tempFolder, 'extract_12345');
    // Não precisa existir em disco — apenas verificamos que o handler NÃO rejeita por segurança
    // O handler retorna false se não existe, mas não false por "não permitido"
    // Para testar isso, criamos a pasta
    fs.mkdirSync(subPath, { recursive: true });
    const handler = _ipcHandlers['fs:exists'];
    expect(handler).toBeDefined();
    const result = handler(null, subPath);
    expect(result).toBe(true); // existe e está dentro das roots
  });
});

// ── SEC-002 & SEC-003: mods:import — batch limit e validação de elementos ─

describe('SEC-002/003 — mods:import: validação de filePaths', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts4-sec002-'));
    const cfg = readConfig();
    cfg.modsFolder = path.join(tmpDir, 'Mods');
    cfg.trayFolder = path.join(tmpDir, 'Tray');
    cfg.tempFolder = path.join(tmpDir, 'temp');
    writeConfig(cfg);
    fs.mkdirSync(cfg.modsFolder, { recursive: true });
    fs.mkdirSync(cfg.trayFolder, { recursive: true });
    fs.mkdirSync(cfg.tempFolder, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('retorna erro quando filePaths excede MAX_IMPORT_BATCH (5000)', async () => {
    const handler = _ipcHandlers['mods:import'];
    expect(handler).toBeDefined();
    const cfg = readConfig();
    const hugeBatch = Array(5001).fill('fake.package');
    const result = await handler(
      { sender: null },
      hugeBatch,
      cfg.modsFolder,
      cfg.trayFolder
    );
    expect(result.imported).toHaveLength(0);
    expect(result.errors[0].error).toMatch(/limite/i);
  });

  test('retorna erro quando filePaths contém elemento não-string', async () => {
    const handler = _ipcHandlers['mods:import'];
    const cfg = readConfig();
    const result = await handler(
      { sender: null },
      ['valid.package', 42, null],
      cfg.modsFolder,
      cfg.trayFolder
    );
    expect(result.imported).toHaveLength(0);
    expect(result.errors[0].error).toMatch(/inválida/i);
  });

  test('array vazio ainda retorna { imported: [], errors: [] } imediatamente', async () => {
    const handler = _ipcHandlers['mods:import'];
    const cfg = readConfig();
    const result = await handler({ sender: null }, [], cfg.modsFolder, cfg.trayFolder);
    expect(result).toEqual({ imported: [], errors: [] });
  });

  test('array com exatamente 5000 elementos é aceito (não dispara o limite)', async () => {
    const handler = _ipcHandlers['mods:import'];
    const cfg = readConfig();
    // Todos os caminhos são inválidos/inexistentes → errors, mas não o erro de "limite"
    const batch = Array(5000).fill('/nonexistent/fake.package');
    const result = await handler({ sender: null }, batch, cfg.modsFolder, cfg.trayFolder);
    // Deve processar (retorna erros por arquivo não encontrado, não por limite de batch)
    expect(result.errors.every(e => !e.error?.match(/limite/i))).toBe(true);
  });
});

// ── QA-001: config:set — validação de windowBounds ────────────────────────

describe('QA-001 — config:set: windowBounds validação', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts4-qa001-'));
    const cfg = readConfig();
    cfg.modsFolder = path.join(tmpDir, 'Mods');
    cfg.trayFolder = path.join(tmpDir, 'Tray');
    writeConfig(cfg);
    fs.mkdirSync(cfg.modsFolder, { recursive: true });
    fs.mkdirSync(cfg.trayFolder, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('windowBounds com valores normais é salvo corretamente', () => {
    const handler = _ipcHandlers['config:set'];
    const cfg = readConfig();
    const result = handler(null, { ...cfg, windowBounds: { width: 1200, height: 800 } });
    expect(result).toBe(true);
    const saved = readConfig();
    expect(saved.windowBounds.width).toBe(1200);
    expect(saved.windowBounds.height).toBe(800);
  });

  test('windowBounds com width negativo é corrigido para mínimo (200)', () => {
    const handler = _ipcHandlers['config:set'];
    const cfg = readConfig();
    handler(null, { ...cfg, windowBounds: { width: -500, height: 600 } });
    const saved = readConfig();
    expect(saved.windowBounds.width).toBeGreaterThanOrEqual(200);
  });

  test('windowBounds com height zero é corrigido para mínimo (150)', () => {
    const handler = _ipcHandlers['config:set'];
    const cfg = readConfig();
    handler(null, { ...cfg, windowBounds: { width: 1000, height: 0 } });
    const saved = readConfig();
    expect(saved.windowBounds.height).toBeGreaterThanOrEqual(150);
  });

  test('windowBounds com largura absurda (100000) é limitado ao máximo (7680)', () => {
    const handler = _ipcHandlers['config:set'];
    const cfg = readConfig();
    handler(null, { ...cfg, windowBounds: { width: 100000, height: 720 } });
    const saved = readConfig();
    expect(saved.windowBounds.width).toBeLessThanOrEqual(7680);
  });

  test('windowBounds com valores NaN retorna false (config rejeitada)', () => {
    const handler = _ipcHandlers['config:set'];
    const cfg = readConfig();
    const result = handler(null, { ...cfg, windowBounds: { width: NaN, height: 720 } });
    expect(result).toBe(false);
  });

  test('windowBounds com Infinity retorna false (config rejeitada)', () => {
    const handler = _ipcHandlers['config:set'];
    const cfg = readConfig();
    const result = handler(null, { ...cfg, windowBounds: { width: Infinity, height: 720 } });
    expect(result).toBe(false);
  });

  test('config sem windowBounds é salva normalmente (campo opcional)', () => {
    const handler = _ipcHandlers['config:set'];
    const cfg = readConfig();
    const { windowBounds: _, ...cfgWithout } = cfg;
    const result = handler(null, cfgWithout);
    expect(result).toBe(true);
  });
});

// ── QA-002: mods:toggle-folder — modsFolder validado ─────────────────────

describe('QA-002 — mods:toggle-folder: modsFolder validado', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts4-qa002-'));
    const cfg = readConfig();
    cfg.modsFolder = path.join(tmpDir, 'Mods');
    cfg.trayFolder = path.join(tmpDir, 'Tray');
    writeConfig(cfg);
    fs.mkdirSync(cfg.modsFolder, { recursive: true });
    fs.mkdirSync(cfg.trayFolder, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('retorna [] se modsFolder não é string', () => {
    const handler = _ipcHandlers['mods:toggle-folder'];
    const cfg = readConfig();
    const result = handler(null, cfg.modsFolder, 12345);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test('retorna [] se modsFolder está fora das raízes permitidas', () => {
    const handler = _ipcHandlers['mods:toggle-folder'];
    const cfg = readConfig();
    const result = handler(null, cfg.modsFolder, '/etc');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test('aceita modsFolder válido dentro das raízes configuradas', () => {
    const handler = _ipcHandlers['mods:toggle-folder'];
    const cfg = readConfig();
    // folderPath e modsFolder ambos dentro das roots → deve processar (pasta vazia → 0 resultados)
    const result = handler(null, cfg.modsFolder, cfg.modsFolder);
    expect(Array.isArray(result)).toBe(true);
  });

  test('aceita modsFolder undefined/null sem retornar erro (campo opcional herdado)', () => {
    const handler = _ipcHandlers['mods:toggle-folder'];
    const cfg = readConfig();
    // modsFolder pode ser omitido — não deve rejeitar quando undefined
    const result = handler(null, cfg.modsFolder, undefined);
    expect(Array.isArray(result)).toBe(true);
  });
});

// ── QA-003: scanConflicts — IDs hash-duplicate usam SHA-256 ──────────────

describe('QA-003 — scanConflicts: hash-duplicate IDs usam SHA-256', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts4-qa003-'));
    const cfg = readConfig();
    cfg.modsFolder = tmpDir;
    cfg.trayFolder = path.join(tmpDir, '_tray');
    writeConfig(cfg);
    fs.mkdirSync(cfg.trayFolder, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('hash-duplicate conflict IDs não contêm o MD5 bruto do arquivo', async () => {
    // Cria dois arquivos com conteúdo idêntico mas nomes diferentes
    const content = Buffer.from('DBPF' + 'a'.repeat(100));
    fs.writeFileSync(path.join(tmpDir, 'modA.package'), content);
    fs.writeFileSync(path.join(tmpDir, 'modB.package'), content);

    const conflicts = await scanConflicts(tmpDir, null, null, { cancelled: false });
    const hashConflicts = (conflicts || []).filter(c => c.type === 'hash-duplicate');

    for (const c of hashConflicts) {
      // O ID deve ser "hash_" + SHA-256 truncado (32 hex chars = 128 bits)
      // NÃO deve ser "hash_" + MD5 bruto (32 hex chars de MD5)
      expect(c.id).toMatch(/^hash_[0-9a-f]{32}$/);
      // O campo hash separado ainda guarda o MD5 original (necessário para deduplicação)
      expect(c.hash).toBeDefined();
      expect(c.hash.length).toBe(32); // MD5 = 32 hex chars
      // O ID não deve ser igual a "hash_" + hash (que seria MD5)
      expect(c.id).not.toBe('hash_' + c.hash);
    }
  });

  test('IDs de same-name e hash-duplicate são ambos hex strings de 32+ chars após o prefixo', async () => {
    const content = Buffer.from('DBPF' + 'b'.repeat(100));
    fs.writeFileSync(path.join(tmpDir, 'modC.package'), content);
    fs.writeFileSync(path.join(tmpDir, 'modD.package'), content);

    const conflicts = await scanConflicts(tmpDir, null, null, { cancelled: false });
    for (const c of conflicts || []) {
      if (c.type === 'same-name' || c.type === 'os-duplicate') {
        expect(c.id.length).toBeGreaterThanOrEqual(32);
      } else if (c.type === 'hash-duplicate') {
        expect(c.id).toMatch(/^hash_/);
        expect(c.id.length).toBeGreaterThan(5);
      }
    }
  });
});
