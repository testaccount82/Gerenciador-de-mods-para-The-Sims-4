'use strict';
/**
 * Testes das funções utilitárias puras de main.js:
 * getFileDepth, getDisabledPath, isEnabled, getRealExtension, getRealName
 */

const path = require('path');
const core = require('../../main');

const SEP = path.sep;

describe('Constantes de extensão', () => {
  test('MOD_EXTENSIONS deve conter .package e .ts4script', () => {
    expect(core.MOD_EXTENSIONS).toContain('.package');
    expect(core.MOD_EXTENSIONS).toContain('.ts4script');
  });

  test('TRAY_EXTENSIONS deve conter .trayitem e .blueprint', () => {
    expect(core.TRAY_EXTENSIONS).toContain('.trayitem');
    expect(core.TRAY_EXTENSIONS).toContain('.blueprint');
  });

  test('ARCHIVE_EXTENSIONS deve conter .zip, .rar e .7z', () => {
    expect(core.ARCHIVE_EXTENSIONS).toContain('.zip');
    expect(core.ARCHIVE_EXTENSIONS).toContain('.rar');
    expect(core.ARCHIVE_EXTENSIONS).toContain('.7z');
  });

  test('DISABLED_SUFFIX deve ser ".disabled"', () => {
    expect(core.DISABLED_SUFFIX).toBe('.disabled');
  });
});

// ─── getFileDepth ─────────────────────────────────────────────────────────────
describe('getFileDepth', () => {
  const base = path.join('C:', 'Mods');

  test('arquivo direto na raiz retorna 0', () => {
    const file = path.join(base, 'mod.package');
    expect(core.getFileDepth(file, base)).toBe(0);
  });

  test('arquivo 1 nível abaixo retorna 1', () => {
    const file = path.join(base, 'subfolder', 'mod.package');
    expect(core.getFileDepth(file, base)).toBe(1);
  });

  test('arquivo 2 níveis abaixo retorna 2', () => {
    const file = path.join(base, 'a', 'b', 'mod.package');
    expect(core.getFileDepth(file, base)).toBe(2);
  });

  test('arquivo 3 níveis abaixo retorna 3', () => {
    const file = path.join(base, 'a', 'b', 'c', 'mod.package');
    expect(core.getFileDepth(file, base)).toBe(3);
  });
});

// ─── getDisabledPath ─────────────────────────────────────────────────────────
describe('getDisabledPath', () => {
  test('arquivo habilitado → adiciona .disabled', () => {
    expect(core.getDisabledPath('/Mods/mod.package')).toBe('/Mods/mod.package.disabled');
  });

  test('arquivo desabilitado → remove .disabled', () => {
    expect(core.getDisabledPath('/Mods/mod.package.disabled')).toBe('/Mods/mod.package');
  });

  test('ts4script habilitado → adiciona .disabled', () => {
    expect(core.getDisabledPath('/Mods/script.ts4script')).toBe('/Mods/script.ts4script.disabled');
  });

  test('ts4script desabilitado → remove .disabled', () => {
    expect(core.getDisabledPath('/Mods/script.ts4script.disabled')).toBe('/Mods/script.ts4script');
  });

  test('toggle duplo retorna ao caminho original', () => {
    const original = '/Mods/mod.package';
    expect(core.getDisabledPath(core.getDisabledPath(original))).toBe(original);
  });
});

// ─── isEnabled ────────────────────────────────────────────────────────────────
describe('isEnabled', () => {
  test('arquivo sem .disabled é habilitado', () => {
    expect(core.isEnabled('/Mods/mod.package')).toBe(true);
  });

  test('arquivo com .disabled é desabilitado', () => {
    expect(core.isEnabled('/Mods/mod.package.disabled')).toBe(false);
  });

  test('.disabled em meio ao caminho NÃO conta como desabilitado', () => {
    expect(core.isEnabled('/Mods/.disabled/mod.package')).toBe(true);
  });

  test('nome do arquivo que termina exatamente em .disabled é desabilitado', () => {
    expect(core.isEnabled('/Mods/trayitem.trayitem.disabled')).toBe(false);
  });
});

// ─── getRealExtension ─────────────────────────────────────────────────────────
describe('getRealExtension', () => {
  test('extensão de arquivo habilitado', () => {
    expect(core.getRealExtension('/Mods/skin.package')).toBe('.package');
  });

  test('extensão de arquivo desabilitado', () => {
    expect(core.getRealExtension('/Mods/skin.package.disabled')).toBe('.package');
  });

  test('extensão de script desabilitado', () => {
    expect(core.getRealExtension('/Mods/script.ts4script.disabled')).toBe('.ts4script');
  });

  test('extensão deve ser em minúsculo', () => {
    expect(core.getRealExtension('/Mods/Mod.PACKAGE')).toBe('.package');
  });

  test('extensão de tray desabilitado', () => {
    expect(core.getRealExtension('/Tray/house.blueprint.disabled')).toBe('.blueprint');
  });
});

// ─── getRealName ──────────────────────────────────────────────────────────────
describe('getRealName', () => {
  test('nome de arquivo habilitado sem alteração', () => {
    expect(core.getRealName('/Mods/CC-hair.package')).toBe('CC-hair.package');
  });

  test('nome de arquivo desabilitado sem o sufixo', () => {
    expect(core.getRealName('/Mods/CC-hair.package.disabled')).toBe('CC-hair.package');
  });

  test('nome de script desabilitado', () => {
    expect(core.getRealName('/Mods/my_script.ts4script.disabled')).toBe('my_script.ts4script');
  });

  test('nome sem diretório', () => {
    expect(core.getRealName('mod.package.disabled')).toBe('mod.package');
  });

  test('arquivo com múltiplos pontos no nome', () => {
    expect(core.getRealName('/Mods/my.mod.v2.package.disabled')).toBe('my.mod.v2.package');
  });
});
