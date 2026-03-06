'use strict';
/**
 * Testes de detecção de conflitos e arquivos mal posicionados:
 * scanConflicts, scanMisplaced, fixMisplaced
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const core = require('../../main');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), `ts4-conf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(filePath, content = 'data') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ─── scanConflicts ────────────────────────────────────────────────────────────

describe('scanConflicts — same-name', () => {
  let mods;
  beforeEach(() => { mods = makeTmpDir(); });
  afterEach(() => { fs.rmSync(mods, { recursive: true, force: true }); });

  test('sem conflitos retorna array vazio', async () => {
    touch(path.join(mods, 'hair.package'));
    const result = await core.scanConflicts(mods);
    expect(result).toEqual([]);
  });

  test('mesmo nome em subpastas diferentes gera conflito same-name', async () => {
    touch(path.join(mods, 'CAS', 'hair.package'));
    touch(path.join(mods, 'Other', 'hair.package'));
    const result = await core.scanConflicts(mods);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const sameNameConflict = result.find(c => c.type === 'same-name');
    expect(sameNameConflict).toBeDefined();
    expect(sameNameConflict.files).toHaveLength(2);
  });

  test('arquivos com sufixo OS-duplicate: mesmo nome (N) em pastas diferentes', async () => {
    // Os-duplicate é detectado quando o MESMO nome com sufixo " (N)" aparece
    // em múltiplas subpastas (o próprio filename contém " (2)")
    touch(path.join(mods, 'sub1', 'hair (2).package'));
    touch(path.join(mods, 'sub2', 'hair (2).package'));
    const result = await core.scanConflicts(mods);
    const osDup = result.find(c => c.type === 'os-duplicate');
    expect(osDup).toBeDefined();
    expect(osDup.label).toBe('Duplicata do sistema');
  });

  test('conflito tem id determinístico baseado no nome', async () => {
    touch(path.join(mods, 'sub1', 'outfit.package'));
    touch(path.join(mods, 'sub2', 'outfit.package'));
    const r1 = await core.scanConflicts(mods);
    const r2 = await core.scanConflicts(mods);
    // Mesmo conteúdo = mesmo id
    expect(r1[0].id).toBe(r2[0].id);
  });
});

describe('scanConflicts — hash-duplicate', () => {
  let mods;
  beforeEach(() => { mods = makeTmpDir(); });
  afterEach(() => { fs.rmSync(mods, { recursive: true, force: true }); });

  test('arquivos com conteúdo idêntico mas nomes diferentes geram hash-duplicate', async () => {
    const content = 'IDENTICAL_CONTENT_XYZ_12345';
    touch(path.join(mods, 'mod-original.package'), content);
    touch(path.join(mods, 'mod-copia.package'), content);
    const result = await core.scanConflicts(mods);
    const hashDup = result.find(c => c.type === 'hash-duplicate');
    expect(hashDup).toBeDefined();
    expect(hashDup.files).toHaveLength(2);
  });

  test('conteúdo diferente não gera hash-duplicate', async () => {
    touch(path.join(mods, 'mod-a.package'), 'conteudo-a');
    touch(path.join(mods, 'mod-b.package'), 'conteudo-b');
    const result = await core.scanConflicts(mods);
    const hashDups = result.filter(c => c.type === 'hash-duplicate');
    expect(hashDups).toHaveLength(0);
  });

  test('arquivos com mesmo nome E mesmo conteúdo não geram hash-duplicate (já cobertos por same-name)', async () => {
    const content = 'SAME_CONTENT';
    touch(path.join(mods, 'sub1', 'mod.package'), content);
    touch(path.join(mods, 'sub2', 'mod.package'), content);
    const result = await core.scanConflicts(mods);
    const hashDups = result.filter(c => c.type === 'hash-duplicate');
    // Não deve criar hash-duplicate quando todos os caminhos têm o mesmo nome
    expect(hashDups).toHaveLength(0);
  });

  test('conflito hash-duplicate inclui campo hash', async () => {
    const content = 'UNIQUE_HASH_TEST';
    touch(path.join(mods, 'a.package'), content);
    touch(path.join(mods, 'b.package'), content);
    const result = await core.scanConflicts(mods);
    const hashDup = result.find(c => c.type === 'hash-duplicate');
    expect(hashDup).toBeDefined();
    expect(typeof hashDup.hash).toBe('string');
    expect(hashDup.hash).toHaveLength(32); // MD5
  });
});

// ─── scanMisplaced ────────────────────────────────────────────────────────────

describe('scanMisplaced', () => {
  let mods, tray;
  beforeEach(() => {
    mods = makeTmpDir();
    tray = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(mods, { recursive: true, force: true });
    fs.rmSync(tray, { recursive: true, force: true });
  });

  test('pastas corretas e sem arquivos errados retorna vazio', () => {
    touch(path.join(mods, 'hair.package'));
    touch(path.join(tray, 'house.trayitem'));
    const result = core.scanMisplaced(mods, tray);
    expect(result).toEqual([]);
  });

  test('.ts4script mais de 1 nível abaixo é detectado como too-deep', () => {
    touch(path.join(mods, 'scripts', 'deep', 'script.ts4script'));
    const result = core.scanMisplaced(mods, tray);
    const item = result.find(r => r.type === 'too-deep');
    expect(item).toBeDefined();
    expect(item.name).toBe('script.ts4script');
  });

  test('.ts4script 1 nível abaixo NÃO é too-deep (limite máximo permitido)', () => {
    touch(path.join(mods, 'scripts', 'script.ts4script'));
    const result = core.scanMisplaced(mods, tray);
    expect(result.filter(r => r.type === 'too-deep')).toHaveLength(0);
  });

  test('.ts4script na raiz da pasta Mods NÃO é too-deep', () => {
    touch(path.join(mods, 'script.ts4script'));
    const result = core.scanMisplaced(mods, tray);
    expect(result.filter(r => r.type === 'too-deep')).toHaveLength(0);
  });

  test('.trayitem dentro de Mods é detectado como wrong-folder', () => {
    touch(path.join(mods, 'house.trayitem'));
    const result = core.scanMisplaced(mods, tray);
    const item = result.find(r => r.type === 'wrong-folder');
    expect(item).toBeDefined();
    expect(item.name).toBe('house.trayitem');
    // Destino sugerido deve ser dentro de tray
    expect(item.suggestedDest).toBe(path.join(tray, 'house.trayitem'));
  });

  test('.package dentro de Tray é detectado como wrong-folder', () => {
    touch(path.join(tray, 'misplaced.package'));
    const result = core.scanMisplaced(mods, tray);
    const item = result.find(r => r.type === 'wrong-folder');
    expect(item).toBeDefined();
    expect(item.name).toBe('misplaced.package');
    // Destino sugerido deve ser dentro de mods
    expect(item.suggestedDest).toBe(path.join(mods, 'misplaced.package'));
  });

  test('.package na pasta correta (Mods) não é reportado', () => {
    touch(path.join(mods, 'skin.package'));
    const result = core.scanMisplaced(mods, tray);
    expect(result).toHaveLength(0);
  });
});

// ─── fixMisplaced ─────────────────────────────────────────────────────────────

describe('fixMisplaced', () => {
  let mods, tray;
  beforeEach(() => {
    mods = makeTmpDir();
    tray = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(mods, { recursive: true, force: true });
    fs.rmSync(tray, { recursive: true, force: true });
  });

  test('move todos os itens para o destino sugerido', () => {
    const filePath = path.join(mods, 'house.trayitem');
    touch(filePath);
    const misplaced = [{
      path: filePath,
      suggestedDest: path.join(tray, 'house.trayitem'),
      name: 'house.trayitem',
    }];
    const results = core.fixMisplaced(misplaced);
    expect(results[0].success).toBe(true);
    expect(fs.existsSync(path.join(tray, 'house.trayitem'))).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test('retorna item original junto com o resultado', () => {
    const filePath = path.join(mods, 'script.ts4script');
    touch(filePath);
    const item = { path: filePath, suggestedDest: path.join(mods, 'script.ts4script'), name: 'script.ts4script' };
    // mover para a mesma pasta (no-op útil para testar estrutura de retorno)
    const results = core.fixMisplaced([item]);
    expect(results[0].item).toEqual(item);
  });
});
