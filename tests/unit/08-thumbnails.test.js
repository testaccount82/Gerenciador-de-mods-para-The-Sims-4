'use strict';
/**
 * Testes do gerador de thumbnail SVG e do cache de thumbnails:
 * generateTrayThumbnailSvg, purgeThumbnailCache, loadThumbnailCache
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const core = require('../../main');

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
    // Deve conter reticências indicando truncamento
    expect(svg).toContain('…');
  });

  test('caracteres especiais XML são escapados no SVG', () => {
    const malicious = '<script>alert("xss")</script>';
    const result = core.generateTrayThumbnailSvg(malicious, null);
    const svg = Buffer.from(result.split(',')[1], 'base64').toString('utf-8');
    // Não deve conter < ou > raw no conteúdo de texto
    expect(svg).not.toContain('<script>');
    // Deve conter a versão escapada
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

// ─── purgeThumbnailCache ──────────────────────────────────────────────────────

describe('purgeThumbnailCache', () => {
  const testUserData = path.join(os.tmpdir(), 'ts4-test-userData');
  const cachePath    = path.join(testUserData, 'thumbnail-cache.json');

  beforeEach(() => {
    fs.mkdirSync(testUserData, { recursive: true });
    // Resetar cache em memória
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
