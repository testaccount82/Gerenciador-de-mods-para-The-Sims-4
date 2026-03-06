'use strict';
/**
 * Testes de operações em arquivos:
 * toggleMod, moveFile, copyModFile, collectModFiles
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const core = require('../../main');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), `ts4-ops-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(filePath, content = 'data') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

// ─── toggleMod ────────────────────────────────────────────────────────────────

describe('toggleMod', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('habilitar → desabilitar: cria arquivo .disabled', () => {
    const src = touch(path.join(dir, 'mod.package'));
    const result = core.toggleMod(src);

    expect(result.success).toBe(true);
    expect(result.newPath).toBe(src + '.disabled');
    expect(fs.existsSync(src + '.disabled')).toBe(true);
    expect(fs.existsSync(src)).toBe(false);
  });

  test('desabilitar → habilitar: remove .disabled', () => {
    const disabled = touch(path.join(dir, 'mod.package.disabled'));
    const result = core.toggleMod(disabled);

    expect(result.success).toBe(true);
    expect(result.newPath).toBe(path.join(dir, 'mod.package'));
    expect(fs.existsSync(path.join(dir, 'mod.package'))).toBe(true);
    expect(fs.existsSync(disabled)).toBe(false);
  });

  test('arquivo inexistente retorna success=false com mensagem de erro', () => {
    const result = core.toggleMod(path.join(dir, 'ghost.package'));
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  test('toggle duplo restaura ao nome original', () => {
    const src = touch(path.join(dir, 'mod.package'));
    core.toggleMod(src);
    core.toggleMod(src + '.disabled');
    expect(fs.existsSync(src)).toBe(true);
  });
});

// ─── moveFile ─────────────────────────────────────────────────────────────────

describe('moveFile', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('move arquivo para nova localização', () => {
    const src  = touch(path.join(dir, 'mod.package'));
    const dest = path.join(dir, 'new', 'mod.package');
    const result = core.moveFile(src, dest);

    expect(result.success).toBe(true);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(src)).toBe(false);
  });

  test('cria subpastas necessárias automaticamente', () => {
    const src  = touch(path.join(dir, 'mod.package'));
    const dest = path.join(dir, 'a', 'b', 'c', 'mod.package');
    const result = core.moveFile(src, dest);

    expect(result.success).toBe(true);
    expect(fs.existsSync(dest)).toBe(true);
  });

  test('arquivo origem inexistente retorna success=false', () => {
    const result = core.moveFile(path.join(dir, 'ghost.package'), path.join(dir, 'dest.package'));
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  test('conteúdo do arquivo é preservado após mover', () => {
    const content = 'conteudo-especial-123';
    const src  = touch(path.join(dir, 'mod.package'), content);
    const dest = path.join(dir, 'dest', 'mod.package');
    core.moveFile(src, dest);
    expect(fs.readFileSync(dest, 'utf-8')).toBe(content);
  });
});

// ─── copyModFile ──────────────────────────────────────────────────────────────

describe('copyModFile', () => {
  let mods, tray, src;
  beforeEach(() => {
    mods = makeTmpDir();
    tray = makeTmpDir();
    src  = makeTmpDir();
  });
  afterEach(() => {
    [mods, tray, src].forEach(d => fs.rmSync(d, { recursive: true, force: true }));
  });

  test('copia .package para pasta Mods', () => {
    const file = touch(path.join(src, 'hair.package'));
    const dest = core.copyModFile(file, mods, tray);
    expect(dest).toBe(path.join(mods, 'hair.package'));
    expect(fs.existsSync(dest)).toBe(true);
  });

  test('copia .ts4script para pasta Mods', () => {
    const file = touch(path.join(src, 'script.ts4script'));
    const dest = core.copyModFile(file, mods, tray);
    expect(dest).toBe(path.join(mods, 'script.ts4script'));
  });

  test('copia .trayitem para pasta Tray', () => {
    const file = touch(path.join(src, 'house.trayitem'));
    const dest = core.copyModFile(file, mods, tray);
    expect(dest).toBe(path.join(tray, 'house.trayitem'));
  });

  test('copia .blueprint para pasta Tray', () => {
    const file = touch(path.join(src, 'lot.blueprint'));
    const dest = core.copyModFile(file, mods, tray);
    expect(dest).toBe(path.join(tray, 'lot.blueprint'));
  });

  test('extensão desconhecida retorna null', () => {
    const file = touch(path.join(src, 'readme.txt'));
    const dest = core.copyModFile(file, mods, tray);
    expect(dest).toBeNull();
  });

  test('nome duplicado recebe sufixo numérico (1)', () => {
    const file = touch(path.join(src, 'hair.package'), 'original');
    // Criar arquivo já existente no destino
    touch(path.join(mods, 'hair.package'), 'existente');

    const dest = core.copyModFile(file, mods, tray);
    expect(dest).toBe(path.join(mods, 'hair (1).package'));
    expect(fs.existsSync(dest)).toBe(true);
  });

  test('nome duplicado com múltiplas colisões incrementa contador', () => {
    const file = touch(path.join(src, 'hair.package'));
    touch(path.join(mods, 'hair.package'));
    touch(path.join(mods, 'hair (1).package'));
    const dest = core.copyModFile(file, mods, tray);
    expect(dest).toBe(path.join(mods, 'hair (2).package'));
  });
});

// ─── collectModFiles ──────────────────────────────────────────────────────────

describe('collectModFiles', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('pasta vazia retorna array vazio', () => {
    expect(core.collectModFiles(dir)).toEqual([]);
  });

  test('encontra .package e .ts4script', () => {
    touch(path.join(dir, 'mod.package'));
    touch(path.join(dir, 'script.ts4script'));
    touch(path.join(dir, 'readme.txt'));
    const files = core.collectModFiles(dir);
    expect(files).toHaveLength(2);
  });

  test('encontra arquivos tray em subdirectórios', () => {
    touch(path.join(dir, 'sub', 'house.trayitem'));
    touch(path.join(dir, 'sub', 'deep', 'lot.blueprint'));
    const files = core.collectModFiles(dir);
    expect(files).toHaveLength(2);
  });

  test('retorna caminhos absolutos', () => {
    const file = touch(path.join(dir, 'mod.package'));
    const files = core.collectModFiles(dir);
    expect(files[0]).toBe(file);
  });
});
