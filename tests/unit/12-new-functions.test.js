'use strict';
/**
 * Testes para funções que não tinham cobertura:
 *  - scanInvalidFiles
 *  - scanScatteredGroups
 *  - scanEmptyFolders / deleteEmptyFolders / hasAnyFile
 *  - toggleFolder
 *  - parseTrayItemInfo
 *  - importFiles (fluxo básico sem archive)
 *  - safeDestFor via scanMisplaced (correção bug do contador)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const core = require('../../main');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), `ts4-new-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(filePath, content = 'data') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

// ─── scanInvalidFiles ─────────────────────────────────────────────────────────

describe('scanInvalidFiles', () => {
  let mods, tray;
  beforeEach(() => { mods = makeTmpDir(); tray = makeTmpDir(); });
  afterEach(() => { [mods, tray].forEach(d => fs.rmSync(d, { recursive: true, force: true })); });

  test('pasta vazia retorna array vazio', () => {
    expect(core.scanInvalidFiles(mods, tray)).toEqual([]);
  });

  test('arquivos válidos não são reportados', () => {
    touch(path.join(mods, 'mod.package'));
    touch(path.join(mods, 'script.ts4script'));
    touch(path.join(tray, 'house.trayitem'));
    expect(core.scanInvalidFiles(mods, tray)).toHaveLength(0);
  });

  test('arquivo .zip em Mods é reportado como archive', () => {
    touch(path.join(mods, 'pack.zip'));
    const result = core.scanInvalidFiles(mods, tray);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('archive');
    expect(result[0].ext).toBe('.zip');
    expect(result[0].folderType).toBe('mods');
  });

  test('arquivo .rar em Tray é reportado como archive', () => {
    touch(path.join(tray, 'pack.rar'));
    const result = core.scanInvalidFiles(mods, tray);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('archive');
    expect(result[0].folderType).toBe('tray');
  });

  test('extensão desconhecida é reportada como unknown', () => {
    touch(path.join(mods, 'estranha.xyz'));
    const result = core.scanInvalidFiles(mods, tray);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('unknown');
    expect(result[0].ext).toBe('.xyz');
  });

  test('arquivo de sistema (Thumbs.db) é ignorado', () => {
    touch(path.join(mods, 'Thumbs.db'));
    expect(core.scanInvalidFiles(mods, tray)).toHaveLength(0);
  });

  test('arquivos .cfg e .ini são ignorados', () => {
    touch(path.join(mods, 'config.cfg'));
    touch(path.join(mods, 'settings.ini'));
    expect(core.scanInvalidFiles(mods, tray)).toHaveLength(0);
  });

  test('pasta null/undefined não lança exceção', () => {
    touch(path.join(mods, 'bad.xyz'));
    expect(() => core.scanInvalidFiles(null, tray)).not.toThrow();
    expect(() => core.scanInvalidFiles(mods, null)).not.toThrow();
    expect(() => core.scanInvalidFiles(null, null)).not.toThrow();
  });

  test('arquivo .disabled com extensão inválida é reportado', () => {
    touch(path.join(mods, 'bad.xyz.disabled'));
    const result = core.scanInvalidFiles(mods, tray);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('unknown');
    expect(result[0].ext).toBe('.xyz');
  });

  test('inclui tamanho correto do arquivo', () => {
    touch(path.join(mods, 'bad.xyz'), 'abc');
    const result = core.scanInvalidFiles(mods, tray);
    expect(result[0].size).toBe(3);
  });
});

// ─── scanScatteredGroups ──────────────────────────────────────────────────────

describe('scanScatteredGroups', () => {
  let mods;
  beforeEach(() => { mods = makeTmpDir(); });
  afterEach(() => { fs.rmSync(mods, { recursive: true, force: true }); });

  test('pasta vazia retorna array vazio', () => {
    expect(core.scanScatteredGroups(mods)).toEqual([]);
  });

  test('arquivos sem prefixo (sem _) não são agrupados', () => {
    touch(path.join(mods, 'modA.package'));
    touch(path.join(mods, 'sub', 'modB.package'));
    expect(core.scanScatteredGroups(mods)).toHaveLength(0);
  });

  test('prefixo < 2 chars não é agrupado', () => {
    touch(path.join(mods, 'a_hair.package'));
    touch(path.join(mods, 'sub', 'a_body.package'));
    expect(core.scanScatteredGroups(mods)).toHaveLength(0);
  });

  test('dois arquivos com mesmo prefixo em pastas diferentes → scattered', () => {
    touch(path.join(mods, 'CC_hairA.package'));
    touch(path.join(mods, 'sub', 'CC_hairB.package'));
    const result = core.scanScatteredGroups(mods);
    expect(result).toHaveLength(1);
    expect(result[0].prefix).toBe('cc');
    expect(result[0].folders).toHaveLength(2);
    expect(result[0].files).toHaveLength(2);
  });

  test('dois arquivos com mesmo prefixo na mesma pasta → allAtRoot, incluído', () => {
    touch(path.join(mods, 'CC_hairA.package'));
    touch(path.join(mods, 'CC_hairB.package'));
    const result = core.scanScatteredGroups(mods);
    expect(result).toHaveLength(1);
    expect(result[0].targetFolder).toBe('/');
  });

  test('prefixos diferentes → grupos separados', () => {
    touch(path.join(mods, 'AA_hairA.package'));
    touch(path.join(mods, 'sub', 'BB_hairB.package'));
    touch(path.join(mods, 'sub2', 'BB_hairC.package'));
    const result = core.scanScatteredGroups(mods);
    // AA tem só 1 arquivo → não é grupo; BB tem 2 → 1 grupo
    expect(result).toHaveLength(1);
    expect(result[0].prefix).toBe('bb');
  });

  test('totalSize é soma dos tamanhos dos arquivos', () => {
    touch(path.join(mods, 'CC_hairA.package'), 'abc');         // 3 bytes
    touch(path.join(mods, 'sub', 'CC_hairB.package'), 'de');   // 2 bytes
    const result = core.scanScatteredGroups(mods);
    expect(result[0].totalSize).toBe(5);
  });

  test('arquivos de script (.ts4script) são incluídos nos grupos', () => {
    touch(path.join(mods, 'CC_mod.package'));
    touch(path.join(mods, 'sub', 'CC_mod.ts4script'));
    const result = core.scanScatteredGroups(mods);
    expect(result).toHaveLength(1);
  });

  test('arquivo .disabled com mesmo prefixo é incluído', () => {
    touch(path.join(mods, 'CC_hairA.package'));
    touch(path.join(mods, 'sub', 'CC_hairB.package.disabled'));
    const result = core.scanScatteredGroups(mods);
    expect(result).toHaveLength(1);
    expect(result[0].files).toHaveLength(2);
  });
});

// ─── hasAnyFile ───────────────────────────────────────────────────────────────

describe('hasAnyFile', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('pasta vazia retorna false', () => {
    expect(core.hasAnyFile(dir)).toBe(false);
  });

  test('pasta com arquivo retorna true', () => {
    touch(path.join(dir, 'mod.package'));
    expect(core.hasAnyFile(dir)).toBe(true);
  });

  test('pasta com subdirectório vazio retorna false', () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    expect(core.hasAnyFile(dir)).toBe(false);
  });

  test('pasta com arquivo em subdirectório retorna true', () => {
    touch(path.join(dir, 'sub', 'mod.package'));
    expect(core.hasAnyFile(dir)).toBe(true);
  });

  test('pasta inexistente retorna false sem lançar exceção', () => {
    expect(() => core.hasAnyFile(path.join(dir, 'nao-existe'))).not.toThrow();
    expect(core.hasAnyFile(path.join(dir, 'nao-existe'))).toBe(false);
  });
});

// ─── scanEmptyFolders ─────────────────────────────────────────────────────────

describe('scanEmptyFolders', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('pasta sem subpastas retorna array vazio', () => {
    expect(core.scanEmptyFolders(dir)).toEqual([]);
  });

  test('subpasta vazia é detectada', () => {
    fs.mkdirSync(path.join(dir, 'empty-sub'));
    const result = core.scanEmptyFolders(dir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('empty-sub');
  });

  test('subpasta com arquivo NÃO é detectada', () => {
    touch(path.join(dir, 'com-arquivo', 'mod.package'));
    const result = core.scanEmptyFolders(dir);
    expect(result).toHaveLength(0);
  });

  test('subpasta com subpasta vazia dentro é detectada', () => {
    fs.mkdirSync(path.join(dir, 'outer', 'inner'), { recursive: true });
    const result = core.scanEmptyFolders(dir);
    // outer é vazio (só tem inner vazio), inner também é vazio
    // hasAnyFile(outer) = false → outer é reportado; inner não precisa ser percorrido
    const names = result.map(r => r.name);
    expect(names).toContain('outer');
  });

  test('pasta raiz inexistente retorna array vazio', () => {
    expect(core.scanEmptyFolders(path.join(dir, 'nao-existe'))).toEqual([]);
  });

  test('relativePath está correto', () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    const result = core.scanEmptyFolders(dir);
    expect(result[0].relativePath).toBe('sub');
  });
});

// ─── deleteEmptyFolders ───────────────────────────────────────────────────────

describe('deleteEmptyFolders', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); });

  test('apaga pasta vazia com sucesso', () => {
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    const results = core.deleteEmptyFolders([empty]);
    expect(results[0].success).toBe(true);
    expect(fs.existsSync(empty)).toBe(false);
  });

  test('pasta que não existe retorna success=true (já removida)', () => {
    const ghost = path.join(dir, 'nao-existe');
    const results = core.deleteEmptyFolders([ghost]);
    expect(results[0].success).toBe(true);
  });

  test('pasta com arquivo retorna success=false', () => {
    const withFile = path.join(dir, 'com-arquivo');
    touch(path.join(withFile, 'mod.package'));
    const results = core.deleteEmptyFolders([withFile]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/não está vazia/i);
  });

  test('array vazio retorna array vazio', () => {
    expect(core.deleteEmptyFolders([])).toEqual([]);
  });

  test('múltiplas pastas processadas individualmente', () => {
    const e1 = path.join(dir, 'e1'); fs.mkdirSync(e1);
    const e2 = path.join(dir, 'e2'); fs.mkdirSync(e2);
    const results = core.deleteEmptyFolders([e1, e2]);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);
  });
});

// ─── toggleFolder ─────────────────────────────────────────────────────────────

describe('toggleFolder', () => {
  let mods;
  beforeEach(() => { mods = makeTmpDir(); });
  afterEach(() => { fs.rmSync(mods, { recursive: true, force: true }); });

  test('habilita todos os arquivos de mod na pasta', () => {
    touch(path.join(mods, 'sub', 'a.package'));
    touch(path.join(mods, 'sub', 'b.ts4script'));
    const results = core.toggleFolder(path.join(mods, 'sub'), mods);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);
    expect(fs.existsSync(path.join(mods, 'sub', 'a.package.disabled'))).toBe(true);
    expect(fs.existsSync(path.join(mods, 'sub', 'b.ts4script.disabled'))).toBe(true);
  });

  test('ignora arquivos não-mod (.txt, .jpg)', () => {
    touch(path.join(mods, 'sub', 'readme.txt'));
    touch(path.join(mods, 'sub', 'mod.package'));
    const results = core.toggleFolder(path.join(mods, 'sub'), mods);
    expect(results).toHaveLength(1);
  });

  test('pasta vazia retorna array vazio', () => {
    fs.mkdirSync(path.join(mods, 'sub'));
    const results = core.toggleFolder(path.join(mods, 'sub'), mods);
    expect(results).toHaveLength(0);
  });

  test('re-ativa arquivos já desabilitados', () => {
    touch(path.join(mods, 'sub', 'mod.package.disabled'));
    const results = core.toggleFolder(path.join(mods, 'sub'), mods);
    expect(results[0].success).toBe(true);
    expect(fs.existsSync(path.join(mods, 'sub', 'mod.package'))).toBe(true);
  });

  test('inclui arquivos tray na operação', () => {
    touch(path.join(mods, 'sub', 'house.trayitem'));
    const results = core.toggleFolder(path.join(mods, 'sub'), mods);
    expect(results).toHaveLength(1);
    expect(fs.existsSync(path.join(mods, 'sub', 'house.trayitem.disabled'))).toBe(true);
  });
});

// ─── parseTrayItemInfo ────────────────────────────────────────────────────────

describe('parseTrayItemInfo', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('arquivo inexistente retorna { name: null, creator: null }', () => {
    const result = core.parseTrayItemInfo(path.join(dir, 'ghost.trayitem'));
    expect(result.name).toBeNull();
    expect(result.creator).toBeNull();
  });

  test('arquivo binário sem strings legíveis retorna nulls', () => {
    const f = path.join(dir, 'binary.trayitem');
    fs.writeFileSync(f, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const result = core.parseTrayItemInfo(f);
    expect(result.name).toBeNull();
    expect(result.creator).toBeNull();
  });

  test('extrai nome de string com padrão "Nome*Descrição"', () => {
    const f = path.join(dir, 'house.trayitem');
    // Cria conteúdo com a string "CasaBonita*Uma casa bonita"
    fs.writeFileSync(f, Buffer.concat([
      Buffer.from([0x00, 0x00]),
      Buffer.from('CasaBonita*Uma casa bonita'),
      Buffer.from([0x00]),
    ]));
    const result = core.parseTrayItemInfo(f);
    expect(result.name).toBe('CasaBonita');
  });

  test('extrai criador de string terminada em "@"', () => {
    const f = path.join(dir, 'house.trayitem');
    fs.writeFileSync(f, Buffer.concat([
      Buffer.from('NomeCasa*desc'),
      Buffer.from([0x00]),
      Buffer.from('CriadorX@'),
      Buffer.from([0x00]),
    ]));
    const result = core.parseTrayItemInfo(f);
    expect(result.creator).toBe('CriadorX');
  });

  test('arquivo vazio retorna nulls sem lançar exceção', () => {
    const f = path.join(dir, 'empty.trayitem');
    fs.writeFileSync(f, Buffer.alloc(0));
    expect(() => core.parseTrayItemInfo(f)).not.toThrow();
    const result = core.parseTrayItemInfo(f);
    expect(result.name).toBeNull();
  });
});

// ─── safeDestFor via scanMisplaced — Bug 3: contador correto ──────────────────

describe('scanMisplaced — safeDestFor inicia contador em (1) não (2)', () => {
  let mods, tray;
  beforeEach(() => { mods = makeTmpDir(); tray = makeTmpDir(); });
  afterEach(() => { [mods, tray].forEach(d => fs.rmSync(d, { recursive: true, force: true })); });

  test('conflito de nome no destino gera sufixo (1), não (2)', () => {
    // Coloca um .trayitem dentro de Mods (misplaced) com mesmo nome que já existe na Tray
    touch(path.join(tray, 'house.trayitem'), 'original');
    touch(path.join(mods, 'sub', 'house.trayitem'), 'misplaced');

    const result = core.scanMisplaced(mods, tray);
    const trayItem = result.find(r => r.name === 'house.trayitem');
    expect(trayItem).toBeDefined();
    // Deve sugerir "house (1).trayitem", não "house (2).trayitem"
    expect(path.basename(trayItem.suggestedDest)).toBe('house (1).trayitem');
  });

  test('dois conflitos consecutivos geram (1) e (2)', () => {
    touch(path.join(tray, 'item.trayitem'), 'orig');
    touch(path.join(mods, 'sub1', 'item.trayitem'), 'copy1');
    touch(path.join(mods, 'sub2', 'item.trayitem'), 'copy2');

    const result = core.scanMisplaced(mods, tray);
    const items = result.filter(r => r.name === 'item.trayitem');
    expect(items).toHaveLength(2);
    const suffixes = items.map(r => path.basename(r.suggestedDest)).sort();
    expect(suffixes).toContain('item (1).trayitem');
    expect(suffixes).toContain('item (2).trayitem');
  });
});

// ─── importFiles — Bug 1: usa readConfig().tempFolder ────────────────────────

describe('importFiles — fluxo básico (sem archive)', () => {
  let mods, tray, src;
  beforeEach(() => { mods = makeTmpDir(); tray = makeTmpDir(); src = makeTmpDir(); });
  afterEach(() => { [mods, tray, src].forEach(d => fs.rmSync(d, { recursive: true, force: true })); });

  test('importa .package para modsFolder', async () => {
    const file = touch(path.join(src, 'hair.package'));
    const result = await core.importFiles([file], mods, tray);
    expect(result.errors).toHaveLength(0);
    expect(result.imported).toHaveLength(1);
    expect(fs.existsSync(path.join(mods, 'hair.package'))).toBe(true);
  });

  test('importa .trayitem para trayFolder', async () => {
    const file = touch(path.join(src, 'house.trayitem'));
    const result = await core.importFiles([file], mods, tray);
    expect(result.errors).toHaveLength(0);
    expect(result.imported).toHaveLength(1);
    expect(fs.existsSync(path.join(tray, 'house.trayitem'))).toBe(true);
  });

  test('tipo não suportado vai para errors', async () => {
    const file = touch(path.join(src, 'leia.txt'));
    const result = await core.importFiles([file], mods, tray);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/não suportado/i);
  });

  test('array vazio retorna resultado vazio sem erros', async () => {
    const result = await core.importFiles([], mods, tray);
    expect(result.imported).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test('arquivo idêntico no destino (mesmo MD5) não é copiado novamente', async () => {
    const content = 'conteudo-unico';
    const file = touch(path.join(src, 'mod.package'), content);
    // Cria arquivo idêntico no destino
    touch(path.join(mods, 'mod.package'), content);
    const result = await core.importFiles([file], mods, tray);
    expect(result.errors).toHaveLength(0);
    expect(result.imported).toHaveLength(1);
    // Não deve criar duplicata
    expect(fs.existsSync(path.join(mods, 'mod (1).package'))).toBe(false);
  });

  test('arquivo com conteúdo diferente no destino gera nova cópia numerada', async () => {
    const file = touch(path.join(src, 'mod.package'), 'conteudo-novo');
    touch(path.join(mods, 'mod.package'), 'conteudo-antigo');
    const result = await core.importFiles([file], mods, tray);
    expect(result.errors).toHaveLength(0);
    expect(result.imported).toHaveLength(1);
    expect(path.basename(result.imported[0])).toBe('mod (1).package');
  });

  test('múltiplos arquivos importados em sequência', async () => {
    const f1 = touch(path.join(src, 'a.package'));
    const f2 = touch(path.join(src, 'b.ts4script'));
    const f3 = touch(path.join(src, 'c.trayitem'));
    const result = await core.importFiles([f1, f2, f3], mods, tray);
    expect(result.errors).toHaveLength(0);
    expect(result.imported).toHaveLength(3);
  });
});
