'use strict';
/**
 * Testes de integração usando os arquivos reais da pasta test-uploads.
 * Verifica que o escaneamento, detecção e leitura de metadados funcionam
 * com arquivos .package e tray reais do TS4.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const core = require('../../main');

const UPLOADS = path.join(__dirname, '../../test-uploads');
const CABELOS = path.join(UPLOADS, 'cabelos');
const ROUPAS  = path.join(UPLOADS, 'roupas');
const CASAS   = path.join(UPLOADS, 'casas');

// Pula a suíte inteira se test-uploads não existir
const hasUploads = fs.existsSync(UPLOADS);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeTmpDir() {
  const dir = path.join(os.tmpdir(), `ts4-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Escaneamento de arquivos reais ───────────────────────────────────────────

describe('scanModsFolder — arquivos reais de cabelos', () => {
  (hasUploads ? test : test.skip)('detecta arquivos .package na pasta cabelos', () => {
    if (!fs.existsSync(CABELOS)) return;
    const results = core.scanModsFolder(CABELOS);
    const packages = results.filter(r => r.extension === '.package');
    expect(packages.length).toBeGreaterThan(0);
    // Todos devem ter campos obrigatórios
    packages.forEach(mod => {
      expect(typeof mod.id).toBe('string');
      expect(typeof mod.name).toBe('string');
      expect(mod.size).toBeGreaterThanOrEqual(0);
    });
  });

  (hasUploads ? test : test.skip)('detecta arquivos .package na pasta roupas', () => {
    if (!fs.existsSync(ROUPAS)) return;
    const results = core.scanModsFolder(ROUPAS);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('scanTrayFolder — arquivos reais de casas', () => {
  (hasUploads ? test : test.skip)('detecta arquivos tray na pasta casas', () => {
    if (!fs.existsSync(CASAS)) return;
    const results = core.scanTrayFolder(CASAS);
    expect(results.length).toBeGreaterThan(0);
    results.forEach(item => {
      expect(core.TRAY_EXTENSIONS).toContain(item.extension);
    });
  });
});

// ─── Toggle / restore com arquivo real ───────────────────────────────────────

describe('toggleMod — arquivo real', () => {
  let tmpDir;
  beforeAll(() => { tmpDir = makeTmpDir(); });
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  (hasUploads ? test : test.skip)('desabilita e reabilita um .package real', () => {
    if (!fs.existsSync(CABELOS)) return;
    // Copiar o primeiro .package encontrado para tmpDir
    const cabelos = core.scanModsFolder(CABELOS);
    const primeiro = cabelos.find(m => m.extension === '.package');
    if (!primeiro) return;

    const dest = path.join(tmpDir, primeiro.name);
    fs.copyFileSync(primeiro.path, dest);

    // Desabilitar
    const r1 = core.toggleMod(dest);
    expect(r1.success).toBe(true);
    expect(fs.existsSync(dest + '.disabled')).toBe(true);

    // Reabilitar
    const r2 = core.toggleMod(dest + '.disabled');
    expect(r2.success).toBe(true);
    expect(fs.existsSync(dest)).toBe(true);
  });
});

// ─── Importação de arquivo real ───────────────────────────────────────────────

describe('copyModFile — copia arquivo real para destino', () => {
  let modsDir, trayDir;
  beforeAll(() => {
    modsDir = makeTmpDir();
    trayDir = makeTmpDir();
  });
  afterAll(() => {
    fs.rmSync(modsDir, { recursive: true, force: true });
    fs.rmSync(trayDir, { recursive: true, force: true });
  });

  (hasUploads ? test : test.skip)('copia .package real para pasta de mods', () => {
    if (!fs.existsSync(CABELOS)) return;
    const mods = core.scanModsFolder(CABELOS);
    const pkg = mods.find(m => m.extension === '.package');
    if (!pkg) return;

    const dest = core.copyModFile(pkg.path, modsDir, trayDir);
    expect(dest).not.toBeNull();
    expect(fs.existsSync(dest)).toBe(true);

    const srcSize  = fs.statSync(pkg.path).size;
    const destSize = fs.statSync(dest).size;
    expect(destSize).toBe(srcSize);
  });
});

// ─── Detecção de conflitos com arquivos reais ─────────────────────────────────

describe('scanConflicts — duplas em test-uploads', () => {
  let tmpDir;
  beforeAll(() => {
    tmpDir = makeTmpDir();
    if (!hasUploads || !fs.existsSync(CABELOS)) return;
    // Copiar todos os .package de cabelos para tmpDir
    const mods = core.scanModsFolder(CABELOS);
    mods.filter(m => m.extension === '.package').forEach(m => {
      fs.copyFileSync(m.path, path.join(tmpDir, m.name));
    });
  });
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  (hasUploads ? test : test.skip)('nenhum conflito de hash entre arquivos únicos', async () => {
    if (!fs.existsSync(CABELOS)) return;
    const conflicts = await core.scanConflicts(tmpDir);
    const hashDups = conflicts.filter(c => c.type === 'hash-duplicate');
    // Arquivos de mods diferentes não devem ter o mesmo hash
    expect(hashDups.length).toBe(0);
  });
});
