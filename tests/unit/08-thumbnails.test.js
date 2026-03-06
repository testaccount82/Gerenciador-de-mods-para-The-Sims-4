'use strict';
/**
 * Testes do sistema de miniaturas:
 * - generateTrayThumbnailSvg
 * - extractThumbnailFromPackage (extração real de arquivos .package)
 * - purgeThumbnailCache / loadThumbnailCache
 * - loadVisibleThumbnails (lógica de carregamento paralelo)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const core = require('../../main');

// ─── Caminhos dos arquivos de teste reais ─────────────────────────────────────

const CABELO_PKG  = path.resolve(__dirname, '../../test-uploads/cabelos/EnriqueS4_yfHair_Hina.package');
const ROUPA_PKG   = path.resolve(__dirname, '../../test-uploads/roupas/MysteriousOoVintageSweetApronMaidDress2302.package');
const ROUPA2_PKG  = path.resolve(__dirname, '../../test-uploads/roupas/Talarian_Miranda_OneSleeveCut-OutMiniDress_TSR[Adult].package');

// ─── generateTrayThumbnailSvg ─────────────────────────────────────────────────

describe('generateTrayThumbnailSvg', () => {
  test('retorna data URL base64 de SVG', () => {
    const result = core.generateTrayThumbnailSvg('Minha Casa', 'Criador');
    expect(result).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  test('SVG decodificado contém o nome do lote', () => {
    const result = core.generateTrayThumbnailSvg('Minha Casa', null);
    const svg = Buffer.from(result.split(',')[1], 'base64').toString('utf-8');
    expect(svg).toContain('Minha Casa');
  });

  test('SVG decodificado contém o criador quando fornecido', () => {
    const result = core.generateTrayThumbnailSvg('Casa Bonita', 'SimsCriador');
    const svg = Buffer.from(result.split(',')[1], 'base64').toString('utf-8');
    expect(svg).toContain('SimsCriador');
  });

  test('sem nome: usa "Casa" como fallback', () => {
    const result = core.generateTrayThumbnailSvg(null, null);
    const svg = Buffer.from(result.split(',')[1], 'base64').toString('utf-8');
    expect(svg).toContain('Casa');
  });

  test('nomes longos são truncados com reticências (max 16 chars)', () => {
    const longName = 'Um Nome Muito Longo Para Caber';
    const result = core.generateTrayThumbnailSvg(longName, null);
    const svg = Buffer.from(result.split(',')[1], 'base64').toString('utf-8');
    expect(svg).toContain('…');
  });

  test('caracteres especiais XML são escapados no SVG', () => {
    const malicious = '<script>alert("xss")</script>';
    const result = core.generateTrayThumbnailSvg(malicious, null);
    const svg = Buffer.from(result.split(',')[1], 'base64').toString('utf-8');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;');
  });

  test('SVG válido (contém tag <svg> e </svg>)', () => {
    const result = core.generateTrayThumbnailSvg('Test', 'Author');
    const svg = Buffer.from(result.split(',')[1], 'base64').toString('utf-8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  test('& no nome é escapado para &amp;', () => {
    const result = core.generateTrayThumbnailSvg('Casa & Jardim', null);
    const svg = Buffer.from(result.split(',')[1], 'base64').toString('utf-8');
    expect(svg).toContain('&amp;');
  });
});

// ─── extractThumbnailFromPackage — arquivos reais ─────────────────────────────

describe('extractThumbnailFromPackage — arquivos reais', () => {
  beforeEach(() => {
    // Limpa o cache em memória antes de cada teste para garantir extração fresca
    const cache = core.loadThumbnailCache();
    Object.keys(cache).forEach(k => { if (k !== '__version') delete cache[k]; });
  });

  test('extrai miniatura do pacote de cabelo (JPEG ou PNG base64)', async () => {
    const result = await core.extractThumbnailFromPackage(CABELO_PKG);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^data:image\/(jpeg|png);base64,/);
    // Verifica que o base64 é decodificável e não vazio
    const b64 = result.split(',')[1];
    expect(b64.length).toBeGreaterThan(100);
  });

  test('extrai miniatura do primeiro pacote de roupa', async () => {
    const result = await core.extractThumbnailFromPackage(ROUPA_PKG);
    expect(result).not.toBeNull();
    expect(result).toMatch(/^data:image\/(jpeg|png);base64,/);
  });

  test('extrai miniatura do segundo pacote de roupa (nome com colchetes)', async () => {
    // Verifica que caminhos com caracteres especiais ([]) não quebram a extração
    const result = await core.extractThumbnailFromPackage(ROUPA2_PKG);
    expect(result).not.toBeNull();
    expect(result).toMatch(/^data:image\/(jpeg|png);base64,/);
  });

  test('retorna null para arquivo inexistente sem lançar exceção', async () => {
    const result = await core.extractThumbnailFromPackage('/nao/existe.package');
    expect(result).toBeNull();
  });

  test('retorna null para arquivo não-DBPF sem lançar exceção', async () => {
    const tempFile = path.join(os.tmpdir(), 'not-a-dbpf.package');
    fs.writeFileSync(tempFile, Buffer.from('este nao e um arquivo dbpf valido'));
    try {
      const result = await core.extractThumbnailFromPackage(tempFile);
      expect(result).toBeNull();
    } finally {
      fs.unlinkSync(tempFile);
    }
  });

  test('retorna null para arquivo vazio', async () => {
    const tempFile = path.join(os.tmpdir(), 'empty.package');
    fs.writeFileSync(tempFile, Buffer.alloc(0));
    try {
      const result = await core.extractThumbnailFromPackage(tempFile);
      expect(result).toBeNull();
    } finally {
      fs.unlinkSync(tempFile);
    }
  });

  test('usa o cache na segunda chamada (mesmo mtime)', async () => {
    // Primeira chamada — extrai e armazena em cache
    const first = await core.extractThumbnailFromPackage(CABELO_PKG);
    expect(first).not.toBeNull();

    // Segunda chamada — deve retornar do cache sem re-extrair
    const second = await core.extractThumbnailFromPackage(CABELO_PKG);
    expect(second).toBe(first); // mesma referência de string = veio do cache
  });

  test('miniatura do cabelo é um JPEG ou PNG válido (magic bytes corretos)', async () => {
    const result = await core.extractThumbnailFromPackage(CABELO_PKG);
    const b64 = result.split(',')[1];
    const buf = Buffer.from(b64, 'base64');

    const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    const isPng  = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    expect(isJpeg || isPng).toBe(true);
  });

  test('miniatura da roupa é um JPEG ou PNG válido (magic bytes corretos)', async () => {
    const result = await core.extractThumbnailFromPackage(ROUPA_PKG);
    const b64 = result.split(',')[1];
    const buf = Buffer.from(b64, 'base64');

    const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    const isPng  = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    expect(isJpeg || isPng).toBe(true);
  });
});

// ─── loadVisibleThumbnails — lógica de carregamento paralelo ──────────────────

describe('loadVisibleThumbnails — lógica de carregamento paralelo', () => {
  // Simula o ambiente DOM mínimo necessário para testar a lógica
  function makeFakeEl(paths) {
    const loaders = paths.map(p => ({
      dataset: { load: p },
      replaceWith: jest.fn(),
    }));
    return {
      querySelectorAll: jest.fn(() => loaders),
      querySelector: jest.fn((sel) => {
        // Extrai o caminho do seletor [data-load="..."]
        const match = sel.match(/\[data-load="(.+)"\]$/s);
        if (!match) return null;
        // CSS.escape escapa caracteres especiais, mas para os testes usamos
        // caminhos simples, então a comparação direta é suficiente
        return loaders.find(l => l.dataset.load === match[1]) || null;
      }),
      _loaders: loaders,
    };
  }

  test('faz requisições paralelas: todas as promessas são iniciadas antes de qualquer await', async () => {
    const callOrder = [];
    const resolvers = {};

    const mockApi = {
      getThumbnail: jest.fn((filePath) => {
        callOrder.push(filePath);
        return new Promise(resolve => { resolvers[filePath] = resolve; });
      }),
    };

    const state = { thumbnailCache: {} };
    const THUMB_LOADING = Symbol('loading');

    // Extrai só a lógica de carregamento paralelo para testar isoladamente
    async function loadVisibleThumbnails(el) {
      const loaders = el.querySelectorAll('[data-load]');
      const toLoad = [];
      for (const loader of loaders) {
        const filePath = loader.dataset.load;
        if (state.thumbnailCache[filePath] !== undefined) continue;
        state.thumbnailCache[filePath] = THUMB_LOADING;
        toLoad.push(filePath);
      }
      await Promise.all(toLoad.map(async (filePath) => {
        const thumb = await mockApi.getThumbnail(filePath);
        state.thumbnailCache[filePath] = thumb ?? null;
        const stillThere = el.querySelector(`[data-load="${filePath}"]`);
        if (stillThere) {
          if (thumb) {
            const img = { className: '', src: '', alt: '', loading: '' };
            img.className = 'gallery-thumb';
            img.src = thumb;
            stillThere.replaceWith(img);
          }
        }
      }));
    }

    const el = makeFakeEl(['A', 'B', 'C']);
    const loadPromise = loadVisibleThumbnails(el);

    // Antes de resolver qualquer promessa, todas as 3 devem já ter sido chamadas
    // (comportamento paralelo: todos os getThumbnail são iniciados juntos)
    await Promise.resolve(); // deixa as microtasks rodarem
    expect(mockApi.getThumbnail).toHaveBeenCalledTimes(3);
    expect(callOrder).toEqual(['A', 'B', 'C']);

    // Resolve em ordem inversa para provar que não há dependência sequencial
    resolvers['C']('data:image/png;base64,C');
    resolvers['A']('data:image/png;base64,A');
    resolvers['B']('data:image/png;base64,B');

    await loadPromise;

    expect(state.thumbnailCache['A']).toBe('data:image/png;base64,A');
    expect(state.thumbnailCache['B']).toBe('data:image/png;base64,B');
    expect(state.thumbnailCache['C']).toBe('data:image/png;base64,C');
  });

  test('não faz requisição duplicada para item já em THUMB_LOADING', async () => {
    const THUMB_LOADING = Symbol('loading');
    const state = { thumbnailCache: { 'A': THUMB_LOADING } };

    const mockApi = { getThumbnail: jest.fn(() => Promise.resolve('data:image/png;base64,x')) };

    async function loadVisibleThumbnails(el) {
      const loaders = el.querySelectorAll('[data-load]');
      const toLoad = [];
      for (const loader of loaders) {
        const fp = loader.dataset.load;
        if (state.thumbnailCache[fp] !== undefined) continue;
        state.thumbnailCache[fp] = THUMB_LOADING;
        toLoad.push(fp);
      }
      await Promise.all(toLoad.map(async (fp) => {
        const thumb = await mockApi.getThumbnail(fp);
        state.thumbnailCache[fp] = thumb ?? null;
      }));
    }

    const el = makeFakeEl(['A']);
    await loadVisibleThumbnails(el);

    // A estava como THUMB_LOADING — não deve ter sido requisitada de novo
    expect(mockApi.getThumbnail).not.toHaveBeenCalled();
    // E o cache não deve ter sido alterado (ainda THUMB_LOADING)
    expect(state.thumbnailCache['A']).toBe(THUMB_LOADING);
  });

  test('armazena null no cache quando getThumbnail retorna null', async () => {
    const THUMB_LOADING = Symbol('loading');
    const state = { thumbnailCache: {} };
    const mockApi = { getThumbnail: jest.fn(() => Promise.resolve(null)) };

    async function loadVisibleThumbnails(el) {
      const loaders = el.querySelectorAll('[data-load]');
      const toLoad = [];
      for (const loader of loaders) {
        const fp = loader.dataset.load;
        if (state.thumbnailCache[fp] !== undefined) continue;
        state.thumbnailCache[fp] = THUMB_LOADING;
        toLoad.push(fp);
      }
      await Promise.all(toLoad.map(async (fp) => {
        const thumb = await mockApi.getThumbnail(fp);
        state.thumbnailCache[fp] = thumb ?? null;
      }));
    }

    const el = makeFakeEl(['/mods/semthumb.package']);
    await loadVisibleThumbnails(el);

    expect(state.thumbnailCache['/mods/semthumb.package']).toBeNull();
  });

  test('quando múltiplos renderMods disparam em paralelo, nenhum item fica perdido', async () => {
    // Simula o cenário de bug: renderMods() chamado várias vezes enquanto
    // os thumbnails ainda estão carregando.
    const THUMB_LOADING = Symbol('loading');
    const state = { thumbnailCache: {} };
    const loaded = [];

    const mockApi = {
      getThumbnail: jest.fn((fp) => {
        return new Promise(resolve => setTimeout(() => {
          loaded.push(fp);
          resolve('data:image/png;base64,' + fp);
        }, 0));
      }),
    };

    async function loadVisibleThumbnails(el) {
      const loaders = el.querySelectorAll('[data-load]');
      const toLoad = [];
      for (const loader of loaders) {
        const fp = loader.dataset.load;
        if (state.thumbnailCache[fp] !== undefined) continue;
        state.thumbnailCache[fp] = THUMB_LOADING;
        toLoad.push(fp);
      }
      await Promise.all(toLoad.map(async (fp) => {
        const thumb = await mockApi.getThumbnail(fp);
        state.thumbnailCache[fp] = thumb ?? null;
      }));
    }

    const el1 = makeFakeEl(['A', 'B', 'C']);
    const el2 = makeFakeEl(['A', 'B', 'C']); // segundo render

    // Dispara duas instâncias concorrentes (simula dois renderMods seguidos)
    await Promise.all([
      loadVisibleThumbnails(el1),
      loadVisibleThumbnails(el2),
    ]);

    // Todos os 3 items devem estar no cache com valor real (não THUMB_LOADING)
    expect(state.thumbnailCache['A']).toMatch(/^data:image/);
    expect(state.thumbnailCache['B']).toMatch(/^data:image/);
    expect(state.thumbnailCache['C']).toMatch(/^data:image/);

    // Cada item deve ter sido requisitado exatamente uma vez (sem duplicatas)
    expect(mockApi.getThumbnail).toHaveBeenCalledTimes(3);
  });
});

// ─── purgeThumbnailCache ──────────────────────────────────────────────────────

describe('purgeThumbnailCache', () => {
  const testUserData = path.join(os.tmpdir(), 'ts4-test-userData');
  const cachePath    = path.join(testUserData, 'thumbnail-cache.json');

  beforeEach(() => {
    fs.mkdirSync(testUserData, { recursive: true });
    try { fs.unlinkSync(cachePath); } catch (_) {}
  });

  afterAll(() => {
    try { fs.unlinkSync(cachePath); } catch (_) {}
  });

  test('remove entradas cujos caminhos não estão na lista', () => {
    const cache = core.loadThumbnailCache();
    cache['/Mods/mod-antigo.package'] = { mtime: 1000, data: 'imgdata' };
    cache['/Mods/mod-atual.package']  = { mtime: 2000, data: 'imgdata' };

    core.purgeThumbnailCache(['/Mods/mod-atual.package']);

    const updated = core.loadThumbnailCache();
    expect(updated['/Mods/mod-antigo.package']).toBeUndefined();
    expect(updated['/Mods/mod-atual.package']).toBeDefined();
  });

  test('não remove a chave __version', () => {
    const cache = core.loadThumbnailCache();
    const versionBefore = cache.__version;

    core.purgeThumbnailCache([]);

    const updated = core.loadThumbnailCache();
    expect(updated.__version).toBe(versionBefore);
  });

  test('lista vazia limpa todas as entradas (exceto __version)', () => {
    const cache = core.loadThumbnailCache();
    cache['/Mods/a.package'] = { mtime: 1, data: 'x' };
    cache['/Mods/b.package'] = { mtime: 2, data: 'y' };

    core.purgeThumbnailCache([]);

    const updated = core.loadThumbnailCache();
    expect(Object.keys(updated).filter(k => k !== '__version')).toHaveLength(0);
  });
});
