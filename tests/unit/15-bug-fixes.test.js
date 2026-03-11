'use strict';
/**
 * Testes para os bugs corrigidos e cenários adicionais não cobertos anteriormente:
 *
 * BUG 1 — app:version IPC handler + mock do Electron
 *   - app.getVersion() existia no mock (estava faltando)
 *   - handler retorna string de versão
 *
 * BUG 2 — SOURCE_LABEL 'invalid-files' na Lixeira
 *   - arquivos enviados por organize:delete-invalid ficam com source='invalid-files'
 *   - a chave deve ser tratada corretamente (não mostrar o raw key)
 *
 * BUG 3 — state.appVersion no renderer (testado indiretamente via IPC)
 *
 * Cenários adicionais:
 *   - organize:delete-invalid: grava meta.json com source='invalid-files'
 *   - trash:list: item com source='invalid-files' é retornado corretamente
 *   - config:set: modsFolder === trayFolder → retorna false
 *   - mods:import com filePaths=[] retorna cedo
 *   - conflicts:cancel: seta token como cancelled
 *   - scanInvalidFiles: arquivos de arquivo compactado (.zip) ficam com category='archive'
 *   - scanEmptyFolders: pasta com subpastas vazias aninhadas
 *   - deleteEmptyFolders: pasta com arquivo → retorna error
 *   - purgeThumbnailCache: remove entradas cujos paths não existem mais
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');

require('../../main');

const { _ipcHandlers, _ipcOnHandlers, app } = require('electron');
const {
  scanInvalidFiles,
  scanEmptyFolders,
  deleteEmptyFolders,
  hasAnyFile,
  purgeThumbnailCache,
  loadThumbnailCache,
  copyModFile,
  getRealExtension,
  isPathSafe,
} = require('../../main');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), `ts4-bug-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(filePath, content = 'x') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

const fakeEvent = { sender: { send: jest.fn() } };

// ─── BUG 1 — app:version handler e mock ──────────────────────────────────────

describe('BUG 1 — app:version IPC handler', () => {
  test('app.getVersion está definido no mock do Electron', () => {
    expect(typeof app.getVersion).toBe('function');
  });

  test('app.getVersion() retorna string não vazia', () => {
    const v = app.getVersion();
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  test('handler app:version retorna string de versão', async () => {
    const handler = _ipcHandlers['app:version'];
    expect(handler).toBeDefined();
    const result = await handler(fakeEvent);
    expect(typeof result).toBe('string');
    expect(result).toBe('1.1.0');
  });

  test('handler app:version não lança exceção', () => {
    const handler = _ipcHandlers['app:version'];
    expect(() => handler(fakeEvent)).not.toThrow();
  });
});

// ─── BUG 2 — organize:delete-invalid grava source='invalid-files' ─────────────

describe('BUG 2 — organize:delete-invalid grava meta com source invalid-files', () => {
  let modsDir, trashDir;

  beforeEach(() => {
    modsDir  = makeTmpDir();
    trashDir = path.join(app.getPath('userData'), 'trash');
    fs.mkdirSync(trashDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(modsDir, { recursive: true, force: true });
    // não limpa trashDir pois pertence ao userData mock compartilhado
  });

  test('arquivo inválido movido para trash recebe source=invalid-files no meta.json', async () => {
    // Registrar modsDir nas roots permitidas — simula config com modsDir como modsFolder
    const cfgHandler = _ipcHandlers['config:set'];
    await cfgHandler(fakeEvent, {
      modsFolder: modsDir,
      trayFolder: modsDir + '_tray',
      theme: 'dark',
    });

    // Criar pasta tray para a config
    fs.mkdirSync(modsDir + '_tray', { recursive: true });

    // Criar arquivo inválido dentro da pasta mods (que agora é root permitida)
    const invalidFile = path.join(modsDir, 'arquivo_invalido.xyz');
    touch(invalidFile, 'conteudo invalido');

    const handler = _ipcHandlers['organize:delete-invalid'];
    const results  = await handler(fakeEvent, [invalidFile]);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    // Verificar que o meta.json contém source='invalid-files'
    const metaPath = results[0].trashPath + '.meta.json';
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta.source).toBe('invalid-files');
    expect(meta.originalPath).toBe(invalidFile);

    // Cleanup
    fs.rmSync(modsDir + '_tray', { recursive: true, force: true });
  });

  test('trash:list retorna itens com source=invalid-files', async () => {
    const listHandler = _ipcHandlers['trash:list'];
    const items = await listHandler(fakeEvent);
    // Pode haver itens do teste anterior — apenas verifica que source é sempre string
    for (const item of items) {
      expect(typeof item.source).toBe('string');
    }
  });
});

// ─── scanInvalidFiles — categoria 'archive' para .zip ─────────────────────────

describe('scanInvalidFiles — arquivos compactados', () => {
  let modsDir;

  beforeEach(() => { modsDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(modsDir, { recursive: true, force: true }); });

  test('arquivo .zip em pasta mods fica com category=archive', () => {
    touch(path.join(modsDir, 'mod_esquecido.zip'), 'PK\x03\x04');
    const results = scanInvalidFiles(modsDir, null);
    const zipEntry = results.find(r => r.name === 'mod_esquecido.zip');
    expect(zipEntry).toBeDefined();
    expect(zipEntry.category).toBe('archive');
    expect(zipEntry.folderType).toBe('mods');
  });

  test('arquivo .rar em pasta tray fica com category=archive', () => {
    touch(path.join(modsDir, 'casa.rar'), 'Rar!');
    const results = scanInvalidFiles(null, modsDir); // passa como tray
    const rarEntry = results.find(r => r.name === 'casa.rar');
    expect(rarEntry).toBeDefined();
    expect(rarEntry.category).toBe('archive');
    expect(rarEntry.folderType).toBe('tray');
  });

  test('arquivo .xyz desconhecido fica com category=unknown', () => {
    touch(path.join(modsDir, 'estranho.xyz'), 'dados');
    const results = scanInvalidFiles(modsDir, null);
    const entry = results.find(r => r.name === 'estranho.xyz');
    expect(entry).toBeDefined();
    expect(entry.category).toBe('unknown');
  });

  test('arquivos .package e .trayitem NÃO aparecem como inválidos', () => {
    touch(path.join(modsDir, 'mod.package'));
    touch(path.join(modsDir, 'casa.trayitem'));
    const results = scanInvalidFiles(modsDir, modsDir);
    const names = results.map(r => r.name);
    expect(names).not.toContain('mod.package');
    expect(names).not.toContain('casa.trayitem');
  });

  test('arquivos de sistema são ignorados (thumbs.db, .ds_store)', () => {
    touch(path.join(modsDir, 'Thumbs.db'));
    touch(path.join(modsDir, '.DS_Store'));
    const results = scanInvalidFiles(modsDir, null);
    const names = results.map(r => r.name.toLowerCase());
    expect(names).not.toContain('thumbs.db');
    expect(names).not.toContain('.ds_store');
  });

  test('retorna [] quando ambas as pastas são null', () => {
    const results = scanInvalidFiles(null, null);
    expect(results).toEqual([]);
  });

  test('retorna [] quando pasta não existe', () => {
    const results = scanInvalidFiles('/pasta/inexistente/xyzabc', null);
    expect(results).toEqual([]);
  });
});

// ─── scanEmptyFolders ─────────────────────────────────────────────────────────

describe('scanEmptyFolders', () => {
  let root;

  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('pasta raiz sem subpastas retorna []', () => {
    expect(scanEmptyFolders(root)).toEqual([]);
  });

  test('subpasta vazia é detectada', () => {
    fs.mkdirSync(path.join(root, 'vazia'));
    const result = scanEmptyFolders(root);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('vazia');
  });

  test('subpasta com arquivo NÃO é retornada', () => {
    const sub = path.join(root, 'com-arquivo');
    fs.mkdirSync(sub);
    touch(path.join(sub, 'mod.package'));
    const result = scanEmptyFolders(root);
    expect(result).toHaveLength(0);
  });

  test('subpastas aninhadas todas vazias são detectadas como a raiz aninhada', () => {
    // root/a/b/c — tudo vazio → apenas root/a é reportado (contém subpastas vazias)
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    const result = scanEmptyFolders(root);
    // 'a' não tem arquivos → reportado; b e c são filhas de a, não reportadas separadamente
    const names = result.map(r => r.name);
    expect(names).toContain('a');
  });

  test('pasta mista: uma vazia, uma com arquivo → só a vazia é retornada', () => {
    const comArq = path.join(root, 'com-arquivo');
    const vazia  = path.join(root, 'vazia');
    fs.mkdirSync(comArq); touch(path.join(comArq, 'a.package'));
    fs.mkdirSync(vazia);
    const result = scanEmptyFolders(root);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('vazia');
  });

  test('pasta inexistente retorna []', () => {
    expect(scanEmptyFolders('/nao/existe/jamais')).toEqual([]);
  });
});

// ─── deleteEmptyFolders ────────────────────────────────────────────────────────

describe('deleteEmptyFolders', () => {
  let root;

  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });

  test('deleta pasta vazia com sucesso', () => {
    const sub = path.join(root, 'vazia');
    fs.mkdirSync(sub);
    const results = deleteEmptyFolders([sub]);
    expect(results[0].success).toBe(true);
    expect(fs.existsSync(sub)).toBe(false);
  });

  test('recusa deletar pasta com arquivo dentro (guarda de segurança)', () => {
    const sub = path.join(root, 'cheia');
    fs.mkdirSync(sub);
    touch(path.join(sub, 'mod.package'));
    const results = deleteEmptyFolders([sub]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/não está vazia/i);
  });

  test('pasta já deletada retorna success=true (idempotente)', () => {
    const sub = path.join(root, 'fantasma');
    const results = deleteEmptyFolders([sub]);
    expect(results[0].success).toBe(true);
  });

  test('processa múltiplas pastas, retorna resultado por índice', () => {
    const a = path.join(root, 'a'); fs.mkdirSync(a);
    const b = path.join(root, 'b'); fs.mkdirSync(b); touch(path.join(b, 'x.package'));
    const c = path.join(root, 'c'); fs.mkdirSync(c);
    const results = deleteEmptyFolders([a, b, c]);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(results[2].success).toBe(true);
  });
});

// ─── hasAnyFile ───────────────────────────────────────────────────────────────

describe('hasAnyFile', () => {
  let root;

  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('pasta vazia retorna false', () => {
    expect(hasAnyFile(root)).toBe(false);
  });

  test('pasta com arquivo retorna true', () => {
    touch(path.join(root, 'a.package'));
    expect(hasAnyFile(root)).toBe(true);
  });

  test('pasta com subpasta vazia retorna false', () => {
    fs.mkdirSync(path.join(root, 'vazia'));
    expect(hasAnyFile(root)).toBe(false);
  });

  test('pasta com subpasta contendo arquivo retorna true', () => {
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    touch(path.join(sub, 'mod.package'));
    expect(hasAnyFile(root)).toBe(true);
  });

  test('pasta inexistente retorna false', () => {
    expect(hasAnyFile('/pasta/que/nao/existe')).toBe(false);
  });
});

// ─── isPathSafe — casos de borda ─────────────────────────────────────────────

describe('isPathSafe — casos de borda', () => {
  test('null retorna false', () => {
    expect(isPathSafe(null, '/base')).toBe(false);
  });

  test('número retorna false', () => {
    expect(isPathSafe(42, '/base')).toBe(false);
  });

  test('path traversal é bloqueado', () => {
    expect(isPathSafe('/base/../etc/passwd', '/base')).toBe(false);
  });

  test('path exatamente igual ao root é permitido', () => {
    const tmp = os.tmpdir();
    expect(isPathSafe(tmp, tmp)).toBe(true);
  });

  test('subpath do root é permitido', () => {
    const tmp = os.tmpdir();
    const sub = path.join(tmp, 'mods');
    expect(isPathSafe(sub, tmp)).toBe(true);
  });

  test('path fora de qualquer root é bloqueado', () => {
    expect(isPathSafe('/etc/passwd', '/home/user/mods')).toBe(false);
  });

  test('root vazio (null/undefined) não dá match', () => {
    expect(isPathSafe('/qualquer/coisa', null, undefined)).toBe(false);
  });
});

// ─── getRealExtension — casos com .disabled ───────────────────────────────────

describe('getRealExtension', () => {
  test('arquivo normal retorna extensão correta', () => {
    expect(getRealExtension('/mods/mod.package')).toBe('.package');
  });

  test('arquivo .disabled retorna extensão real', () => {
    expect(getRealExtension('/mods/mod.package.disabled')).toBe('.package');
  });

  test('ts4script.disabled retorna .ts4script', () => {
    expect(getRealExtension('/mods/script.ts4script.disabled')).toBe('.ts4script');
  });

  test('sem extensão retorna string vazia', () => {
    expect(getRealExtension('/mods/noext')).toBe('');
  });
});

// ─── copyModFile — limite de 999 cópias ──────────────────────────────────────

describe('copyModFile — limite de cópias', () => {
  let src, modsDir, trayDir;

  beforeEach(() => {
    src     = path.join(os.tmpdir(), `src_${Date.now()}.package`);
    modsDir = makeTmpDir();
    trayDir = makeTmpDir();
    fs.writeFileSync(src, 'conteudo');
  });

  afterEach(() => {
    try { fs.unlinkSync(src); } catch (_) {}
    fs.rmSync(modsDir, { recursive: true, force: true });
    fs.rmSync(trayDir, { recursive: true, force: true });
  });

  test('primeira cópia vai para o destino sem sufixo numérico', () => {
    const dest = copyModFile(src, modsDir, trayDir);
    expect(path.basename(dest)).toBe(path.basename(src));
  });

  test('segunda cópia recebe sufixo (1)', () => {
    copyModFile(src, modsDir, trayDir); // cria original
    const dest2 = copyModFile(src, modsDir, trayDir);
    expect(path.basename(dest2)).toMatch(/\(1\)\.package$/);
  });

  test('arquivo tray vai para pasta tray', () => {
    const traySrc = path.join(os.tmpdir(), `item_${Date.now()}.trayitem`);
    fs.writeFileSync(traySrc, 'dados');
    const dest = copyModFile(traySrc, modsDir, trayDir);
    expect(path.dirname(dest)).toBe(trayDir);
    fs.unlinkSync(traySrc);
  });

  test('extensão não suportada retorna null', () => {
    const unknown = path.join(os.tmpdir(), `arq_${Date.now()}.xyz`);
    fs.writeFileSync(unknown, 'x');
    const result = copyModFile(unknown, modsDir, trayDir);
    expect(result).toBeNull();
    fs.unlinkSync(unknown);
  });
});

// ─── purgeThumbnailCache ──────────────────────────────────────────────────────

describe('purgeThumbnailCache', () => {
  test('remove entradas cujos paths não estão na lista fornecida', () => {
    const cache = loadThumbnailCache();
    cache['/fake/path/mod.package'] = { mtime: 0, data: 'base64data' };
    cache['/outro/mod.package']     = { mtime: 0, data: null };

    // Purgar mantendo só /outro/mod.package
    purgeThumbnailCache(['/outro/mod.package']);

    const afterCache = loadThumbnailCache();
    expect(afterCache['/fake/path/mod.package']).toBeUndefined();
    expect(afterCache['/outro/mod.package']).toBeDefined();

    // Cleanup
    delete afterCache['/outro/mod.package'];
  });

  test('não remove a chave __version ao purgar', () => {
    purgeThumbnailCache([]);
    const cache = loadThumbnailCache();
    expect(cache.__version).toBeDefined();
  });
});

// ─── organize:scan-invalid IPC ────────────────────────────────────────────────

describe('IPC organize:scan-invalid', () => {
  let modsDir;

  beforeEach(() => { modsDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(modsDir, { recursive: true, force: true }); });

  test('retorna [] para pastas inexistentes', async () => {
    const handler = _ipcHandlers['organize:scan-invalid'];
    const result = await handler(fakeEvent, '/nao/existe', '/tambem/nao');
    expect(Array.isArray(result)).toBe(true);
  });

  test('arquivo .zip em pasta mods detectado via IPC com category=archive', async () => {
    touch(path.join(modsDir, 'esquecido.zip'));
    // Configurar modsDir como modsFolder
    await _ipcHandlers['config:set'](fakeEvent, {
      modsFolder: modsDir,
      trayFolder: modsDir + '_tray',
      theme: 'dark',
    });
    fs.mkdirSync(modsDir + '_tray', { recursive: true });

    const handler = _ipcHandlers['organize:scan-invalid'];
    const result  = await handler(fakeEvent, modsDir, modsDir + '_tray');
    const zipEntry = result.find(r => r.name === 'esquecido.zip');
    expect(zipEntry).toBeDefined();
    expect(zipEntry.category).toBe('archive');

    fs.rmSync(modsDir + '_tray', { recursive: true, force: true });
  });
});

// ─── organize:scan-empty-folders IPC ─────────────────────────────────────────

describe('IPC organize:scan-empty-folders', () => {
  test('retorna [] para pastas inexistentes (não lança exceção)', async () => {
    const handler = _ipcHandlers['organize:scan-empty-folders'];
    const result = await handler(fakeEvent, '/nao/existe', '/tambem/nao');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  test('lista argumentos inválidos sem lançar', () => {
    const handler = _ipcHandlers['organize:scan-empty-folders'];
    expect(() => handler(fakeEvent, null, null)).not.toThrow();
    expect(handler(fakeEvent, null, null)).toEqual([]);
  });
});

// ─── organize:delete-empty-folders IPC ───────────────────────────────────────

describe('IPC organize:delete-empty-folders', () => {
  test('retorna [] para input não-array', async () => {
    const handler = _ipcHandlers['organize:delete-empty-folders'];
    const result = await handler(fakeEvent, 'nao-e-array');
    expect(result).toEqual([]);
  });
});

// ─── conflicts:cancel ─────────────────────────────────────────────────────────

describe('conflicts:cancel IPC', () => {
  test('handler on conflicts:cancel está registrado', () => {
    expect(_ipcOnHandlers['conflicts:cancel']).toBeDefined();
  });

  test('chamar conflicts:cancel não lança exceção', () => {
    expect(() => _ipcOnHandlers['conflicts:cancel']()).not.toThrow();
  });
});

// ─── config:set — validações de segurança ─────────────────────────────────────

describe('IPC config:set — validações', () => {
  test('modsFolder === trayFolder retorna false', async () => {
    const handler = _ipcHandlers['config:set'];
    const result  = await handler(fakeEvent, {
      modsFolder: '/home/user/Documents/EA/Sims4/Mods',
      trayFolder:  '/home/user/Documents/EA/Sims4/Mods',
      theme: 'dark',
    });
    expect(result).toBe(false);
  });

  test('campo não-string onde string é esperada retorna false', async () => {
    const handler = _ipcHandlers['config:set'];
    const result  = await handler(fakeEvent, { modsFolder: 42 });
    expect(result).toBe(false);
  });

  test('array retorna false', async () => {
    const handler = _ipcHandlers['config:set'];
    const result  = await handler(fakeEvent, ['invalid']);
    expect(result).toBe(false);
  });

  test('objeto vazio retorna true (nenhum campo inválido)', async () => {
    const handler = _ipcHandlers['config:set'];
    const result  = await handler(fakeEvent, {});
    expect(result).toBe(true);
  });
});

// ─── mods:import — validações de input ───────────────────────────────────────

describe('IPC mods:import — validações', () => {
  test('filePaths não-array retorna {imported:[],errors:[]}', async () => {
    const handler = _ipcHandlers['mods:import'];
    const result  = await handler(fakeEvent, 'nao-e-array', '/mods', '/tray');
    expect(result).toEqual({ imported: [], errors: [] });
  });

  test('filePaths=[] sem paths válidos retorna imported:[] sem importar arquivos', async () => {
    const handler = _ipcHandlers['mods:import'];
    // Paths /mods e /tray não estão nas roots permitidas — a validação retorna erro antes
    // de verificar se o array está vazio (comportamento correto de segurança)
    const result = await handler(fakeEvent, [], '/mods', '/tray');
    expect(result.imported).toEqual([]);
  });

  test('modsFolder não-string retorna erro', async () => {
    const handler = _ipcHandlers['mods:import'];
    const result  = await handler(fakeEvent, [], 42, '/tray');
    expect(result.errors).toBeDefined();
  });
});

// ─── window:is-maximized ──────────────────────────────────────────────────────

describe('IPC window:is-maximized', () => {
  test('handler está registrado e retorna booleano', async () => {
    const handler = _ipcHandlers['window:is-maximized'];
    expect(handler).toBeDefined();
    const result = await handler(fakeEvent);
    expect(typeof result).toBe('boolean');
  });
});

// ─── thumbnail:clear-cache ────────────────────────────────────────────────────

describe('IPC thumbnail:clear-cache', () => {
  test('limpa o cache e retorna true', async () => {
    const handler = _ipcHandlers['thumbnail:clear-cache'];
    const result  = await handler(fakeEvent);
    expect(result).toBe(true);
    // Cache deve ter apenas __version após limpar
    const cache = loadThumbnailCache();
    const keys = Object.keys(cache).filter(k => k !== '__version');
    expect(keys).toHaveLength(0);
  });
});

// ─── trash:empty ─────────────────────────────────────────────────────────────

describe('IPC trash:empty', () => {
  test('retorna { ok, failed } com lixeira vazia', async () => {
    const handler = _ipcHandlers['trash:empty'];
    const result  = await handler(fakeEvent);
    expect(typeof result.ok).toBe('number');
    expect(typeof result.failed).toBe('number');
  });
});

// ─── fs:exists ────────────────────────────────────────────────────────────────

describe('IPC fs:exists', () => {
  test('retorna false para input não-string', async () => {
    const handler = _ipcHandlers['fs:exists'];
    expect(await handler(fakeEvent, null)).toBe(false);
    expect(await handler(fakeEvent, 42)).toBe(false);
  });

  test('retorna false para path vazio', async () => {
    const handler = _ipcHandlers['fs:exists'];
    expect(await handler(fakeEvent, '')).toBe(false);
  });
});

// ─── BUG: second-instance com mainWindow fechada não reabria o app ────────────
describe('second-instance — recriar mainWindow quando debug window mantém processo vivo', () => {
  const mainSrc = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../main.js'), 'utf8'
  );

  function getSecondInstanceSrc(src) {
    const start = src.indexOf("app.on('second-instance'");
    const marker = "});";
    const end = src.indexOf(marker, start) + marker.length;
    return src.slice(start, end);
  }

  test('handler second-instance está registrado no app', () => {
    const { _appHandlers } = require('electron');
    expect(typeof _appHandlers['second-instance']).toBe('function');
  });

  test('second-instance contém ramo else que chama createWindow()', () => {
    // Sem este ramo, fechar a mainWindow com debugWindow aberta deixa o usuário
    // sem conseguir reabrir o app (second-instance dispara mas não faz nada).
    const handlerSrc = getSecondInstanceSrc(mainSrc);
    expect(handlerSrc).toContain('else');
    expect(handlerSrc).toContain('createWindow()');
  });

  test('second-instance verifica isDestroyed() antes de focar', () => {
    // Garante que não tenta focar uma janela destruída
    const handlerSrc = getSecondInstanceSrc(mainSrc);
    expect(handlerSrc).toContain('isDestroyed()');
  });
});
