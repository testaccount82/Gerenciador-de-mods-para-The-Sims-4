'use strict';
/**
 * Testes de segurança para isPathSafe.
 * Esta é a função mais crítica — previne path traversal e acesso a
 * arquivos do sistema fora das pastas de mods/tray.
 */

const path = require('path');
const core = require('../../main');

const MODS   = path.resolve('/home/user/Documents/EA/Sims4/Mods');
const TRAY   = path.resolve('/home/user/Documents/EA/Sims4/Tray');
const TRASH  = path.resolve('/home/user/AppData/ts4mm/trash');

describe('isPathSafe — entradas inválidas', () => {
  test('null retorna false', () => {
    expect(core.isPathSafe(null, MODS)).toBe(false);
  });

  test('undefined retorna false', () => {
    expect(core.isPathSafe(undefined, MODS)).toBe(false);
  });

  test('número retorna false', () => {
    expect(core.isPathSafe(42, MODS)).toBe(false);
  });

  test('string vazia retorna false', () => {
    expect(core.isPathSafe('', MODS)).toBe(false);
  });

  test('sem raízes retorna false', () => {
    expect(core.isPathSafe(path.join(MODS, 'mod.package'))).toBe(false);
  });
});

describe('isPathSafe — caminhos permitidos', () => {
  test('arquivo direto na pasta Mods', () => {
    expect(core.isPathSafe(path.join(MODS, 'mod.package'), MODS)).toBe(true);
  });

  test('arquivo em subpasta de Mods', () => {
    expect(core.isPathSafe(path.join(MODS, 'CAS', 'skin.package'), MODS)).toBe(true);
  });

  test('arquivo na pasta Tray', () => {
    expect(core.isPathSafe(path.join(TRAY, 'house.trayitem'), TRAY)).toBe(true);
  });

  test('arquivo na lixeira interna', () => {
    expect(core.isPathSafe(path.join(TRASH, 'old.package'), TRASH)).toBe(true);
  });

  test('arquivo permitido com múltiplas raízes', () => {
    expect(core.isPathSafe(path.join(TRAY, 'lot.blueprint'), MODS, TRAY)).toBe(true);
  });
});

describe('isPathSafe — ataques de path traversal', () => {
  test('../.. sai da pasta Mods', () => {
    const traversal = path.join(MODS, '..', '..', 'passwd');
    expect(core.isPathSafe(traversal, MODS)).toBe(false);
  });

  test('path fora da raiz (Windows System32)', () => {
    const sys = 'C:\\Windows\\System32\\notepad.exe';
    expect(core.isPathSafe(sys, MODS, TRAY)).toBe(false);
  });

  test('path fora da raiz (/etc/passwd)', () => {
    expect(core.isPathSafe('/etc/passwd', MODS, TRAY)).toBe(false);
  });

  test('prefixo coincide mas não é subpasta', () => {
    // MODS = /home/user/.../Mods
    // Um caminho como /home/user/.../ModsExtra não deve ser permitido
    const fake = MODS + 'Extra/mod.package';
    expect(core.isPathSafe(fake, MODS)).toBe(false);
  });

  test('raiz exata é permitida (é a própria pasta)', () => {
    expect(core.isPathSafe(MODS, MODS)).toBe(true);
  });

  test('raiz nula é ignorada', () => {
    const file = path.join(MODS, 'mod.package');
    expect(core.isPathSafe(file, null, MODS)).toBe(true);
  });

  test('arquivo fora de qualquer raiz', () => {
    const outside = path.resolve('/tmp/malicious.package');
    expect(core.isPathSafe(outside, MODS, TRAY)).toBe(false);
  });
});
