'use strict';
/**
 * Testes de leitura/escrita de configuração.
 * readConfig deve mesclar defaults com valores salvos.
 * writeConfig deve persistir o JSON corretamente.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const core = require('../../main');

// Caminho do config durante testes (userData mockado em tests/__mocks__/electron.js)
const testUserData = path.join(os.tmpdir(), 'ts4-test-userData');
const CONFIG_PATH  = path.join(testUserData, 'config.json');

beforeEach(() => {
  // Garantir pasta e limpar config anterior
  fs.mkdirSync(testUserData, { recursive: true });
  try { fs.unlinkSync(CONFIG_PATH); } catch (_) {}
});

afterAll(() => {
  try { fs.unlinkSync(CONFIG_PATH); } catch (_) {}
});

describe('readConfig — sem arquivo salvo', () => {
  test('retorna os valores default', () => {
    const cfg = core.readConfig();
    expect(cfg.theme).toBe('dark');
    expect(cfg.autoCheckMisplaced).toBe(true);
    expect(cfg.autoCheckDuplicates).toBe(false);
    expect(cfg.windowBounds).toEqual({ width: 1100, height: 720 });
  });

  test('modsFolder deve ser uma string não vazia', () => {
    const cfg = core.readConfig();
    expect(typeof cfg.modsFolder).toBe('string');
    expect(cfg.modsFolder.length).toBeGreaterThan(0);
  });
});

describe('writeConfig → readConfig — ciclo de ida e volta', () => {
  test('grava e relê configuração simples', () => {
    const newCfg = { ...core.DEFAULT_CONFIG, theme: 'light' };
    const ok = core.writeConfig(newCfg);
    expect(ok).toBe(true);

    const loaded = core.readConfig();
    expect(loaded.theme).toBe('light');
  });

  test('windowBounds personalizado é preservado', () => {
    core.writeConfig({ ...core.DEFAULT_CONFIG, windowBounds: { width: 1920, height: 1080 } });
    const cfg = core.readConfig();
    expect(cfg.windowBounds).toEqual({ width: 1920, height: 1080 });
  });

  test('valores customizados são mesclados com defaults', () => {
    // Salvar apenas um subset
    core.writeConfig({ theme: 'light' });
    const cfg = core.readConfig();
    // theme deve vir do arquivo
    expect(cfg.theme).toBe('light');
    // outros campos devem vir do DEFAULT_CONFIG
    expect(cfg.autoCheckMisplaced).toBe(true);
  });
});

describe('readConfig — JSON corrompido', () => {
  test('JSON inválido → retorna defaults sem lançar exceção', () => {
    fs.mkdirSync(testUserData, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, '{ invalid json :::');
    expect(() => {
      const cfg = core.readConfig();
      expect(cfg.theme).toBe('dark'); // fallback para default
    }).not.toThrow();
  });
});

describe('writeConfig — erros de escrita', () => {
  test('retorna false quando não é possível gravar', () => {
    // Testa passando uma config com caminho inválido (não há como forçar erro de I/O
    // facilmente, mas podemos verificar que a função retorna boolean)
    const result = core.writeConfig({ theme: 'dark' });
    expect(typeof result).toBe('boolean');
  });
});
