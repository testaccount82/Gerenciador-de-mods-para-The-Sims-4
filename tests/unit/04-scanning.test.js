'use strict';
/**
 * Testes de escaneamento de pastas:
 * walkFolder, buildModObject, scanModsFolder, scanTrayFolder
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const core = require('../../main');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), `ts4-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ─── walkFolder ───────────────────────────────────────────────────────────────

describe('walkFolder', () => {
  let base;
  beforeEach(() => { base = makeTmpDir(); });
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

  test('pasta vazia retorna array vazio', () => {
    expect(core.walkFolder(base, base)).toEqual([]);
  });

  test('pasta inexistente retorna array vazio', () => {
    expect(core.walkFolder('/nao/existe/caminho', '/nao/existe')).toEqual([]);
  });

  test('arquivos na raiz são encontrados com depth 0', () => {
    touch(path.join(base, 'a.package'));
    touch(path.join(base, 'b.package'));
    const results = core.walkFolder(base, base);
    expect(results).toHaveLength(2);
    results.forEach(r => expect(r.depth).toBe(0));
  });

  test('arquivos em subpastas têm depth correto', () => {
    touch(path.join(base, 'sub', 'mod.package'));
    touch(path.join(base, 'sub', 'deep', 'script.ts4script'));
    const results = core.walkFolder(base, base);
    const depths = results.map(r => r.depth).sort();
    expect(depths).toEqual([1, 2]);
  });

  test('retorna fullPath correto', () => {
    const file = path.join(base, 'meu-mod.package');
    touch(file);
    const results = core.walkFolder(base, base);
    expect(results[0].fullPath).toBe(file);
  });
});

// ─── buildModObject ───────────────────────────────────────────────────────────

describe('buildModObject', () => {
  let base;
  beforeEach(() => { base = makeTmpDir(); });
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

  test('retorna null para arquivo inexistente', () => {
    const result = core.buildModObject(path.join(base, 'ghost.package'), base, 'package');
    expect(result).toBeNull();
  });

  test('objeto com campos corretos para arquivo habilitado', () => {
    const file = path.join(base, 'CC-skin.package');
    touch(file, 'fakedata');
    const mod = core.buildModObject(file, base, 'package');

    expect(mod).not.toBeNull();
    expect(mod.name).toBe('CC-skin.package');
    expect(mod.extension).toBe('.package');
    expect(mod.type).toBe('package');
    expect(mod.enabled).toBe(true);
    expect(mod.depth).toBe(0);
    expect(mod.folder).toBe('/');
    expect(mod.size).toBe(8); // 'fakedata' = 8 bytes
    expect(typeof mod.id).toBe('string');
    expect(mod.id).toHaveLength(32); // MD5 hex
    expect(typeof mod.lastModified).toBe('string'); // ISO date
  });

  test('arquivo desabilitado: enabled=false e nome real sem .disabled', () => {
    const file = path.join(base, 'CC-skin.package.disabled');
    touch(file);
    const mod = core.buildModObject(file, base, 'package');

    expect(mod.enabled).toBe(false);
    expect(mod.name).toBe('CC-skin.package');
    expect(mod.extension).toBe('.package');
  });

  test('arquivo em subpasta: depth e folder corretos', () => {
    const file = path.join(base, 'CAS', 'hair.package');
    touch(file);
    const mod = core.buildModObject(file, base, 'package');

    expect(mod.depth).toBe(1);
    expect(mod.folder).toBe('CAS');
  });
});

// ─── scanModsFolder ───────────────────────────────────────────────────────────

describe('scanModsFolder', () => {
  let mods;
  beforeEach(() => { mods = makeTmpDir(); });
  afterEach(() => { fs.rmSync(mods, { recursive: true, force: true }); });

  test('pasta vazia retorna array vazio', () => {
    expect(core.scanModsFolder(mods)).toEqual([]);
  });

  test('pasta inexistente retorna array vazio', () => {
    expect(core.scanModsFolder('/nao/existe')).toEqual([]);
  });

  test('detecta arquivos .package', () => {
    touch(path.join(mods, 'hair.package'));
    const results = core.scanModsFolder(mods);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('package');
  });

  test('detecta arquivos .ts4script como type="script"', () => {
    touch(path.join(mods, 'my_script.ts4script'));
    const results = core.scanModsFolder(mods);
    expect(results[0].type).toBe('script');
  });

  test('arquivo tray dentro de Mods é marcado como "tray-in-mods"', () => {
    touch(path.join(mods, 'house.trayitem'));
    const results = core.scanModsFolder(mods);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('tray-in-mods');
  });

  test('arquivos irrelevantes (.txt, .jpg) são ignorados', () => {
    touch(path.join(mods, 'notes.txt'));
    touch(path.join(mods, 'preview.jpg'));
    expect(core.scanModsFolder(mods)).toHaveLength(0);
  });

  test('detecta múltiplos tipos', () => {
    touch(path.join(mods, 'skin.package'));
    touch(path.join(mods, 'script.ts4script'));
    touch(path.join(mods, 'sub', 'outfit.package'));
    const results = core.scanModsFolder(mods);
    expect(results).toHaveLength(3);
  });
});

// ─── scanTrayFolder ───────────────────────────────────────────────────────────

describe('scanTrayFolder', () => {
  let tray;
  beforeEach(() => { tray = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tray, { recursive: true, force: true }); });

  test('pasta vazia retorna array vazio', () => {
    expect(core.scanTrayFolder(tray)).toEqual([]);
  });

  test('detecta .trayitem com type="tray"', () => {
    touch(path.join(tray, 'house.trayitem'));
    const results = core.scanTrayFolder(tray);
    expect(results[0].type).toBe('tray');
  });

  test('detecta .blueprint com type="tray"', () => {
    touch(path.join(tray, 'lot.blueprint'));
    expect(core.scanTrayFolder(tray)[0].type).toBe('tray');
  });

  test('arquivo .package dentro de Tray é marcado como "mods-in-tray"', () => {
    touch(path.join(tray, 'misplaced.package'));
    const results = core.scanTrayFolder(tray);
    expect(results[0].type).toBe('mods-in-tray');
  });

  test('arquivos .bpi são incluídos (type="tray")', () => {
    touch(path.join(tray, '0x00000002!AABBCCDD.bpi'));
    const results = core.scanTrayFolder(tray);
    expect(results[0].type).toBe('tray');
  });
});
