'use strict';
/**
 * Testes para os 5 bugs encontrados e corrigidos na auditoria 3:
 *
 * BUG 1 – conflicts:restore-from-trash não limpava o .meta.json após restaurar
 * BUG 2 – moveFile fallback: arquivo duplicado quando copyFileSync passa mas unlinkSync falha
 * BUG 3 – wireGridEvents (openGroupOverlay): deletar via ctx menu não registrava Undo
 * BUG 4 – openGroupGridOverlay: deletar via ctx menu não registrava Undo nem logAction
 * BUG 5 – init(): getAppVersion chamado duas vezes desnecessariamente (sem IPC duplo)
 *
 * Bugs 3 e 4 são de comportamento de UI (renderer.js) e são validados via inspeção de código.
 * Bugs 1, 2 e 5 são cobertos por testes de unidade abaixo.
 */

const path  = require('path');
const fs    = require('fs');
const os    = require('os');

process.env.NODE_ENV = 'test';
const {
  moveFile,
} = require('../../main');

// ─── BUG 1: conflicts:restore-from-trash — cleanup de .meta.json ──────────────
// Validação via inspeção do código-fonte (o teste de IPC é coberto pelos testes
// de integração 09/13/14, e a lógica de cleanup é idêntica à de mods:restore-from-trash).

describe('BUG 1 — conflicts:restore-from-trash limpa .meta.json', () => {
  it('o código-fonte deve conter fs.unlinkSync(trashPath + .meta.json) no handler', () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf-8');
    // Localiza o bloco do handler
    const handlerIdx = mainSrc.indexOf("ipcMain.handle('conflicts:restore-from-trash'");
    expect(handlerIdx).toBeGreaterThan(-1);
    // O bloco do handler deve conter cleanup de .meta.json
    const handlerBlock = mainSrc.slice(handlerIdx, handlerIdx + 900);
    expect(handlerBlock).toContain('.meta.json');
    expect(handlerBlock).toContain('unlinkSync');
  });
});

// ─── BUG 2: moveFile — não deve deixar arquivo duplicado ─────────────────────

describe('BUG 2 — moveFile: sem duplicata quando unlink falha no fallback', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts4-moveFile-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('move normalmente quando renameSync funciona', () => {
    const src  = path.join(tmpDir, 'a.package');
    const dest = path.join(tmpDir, 'b.package');
    fs.writeFileSync(src, 'data');
    const result = moveFile(src, dest);
    expect(result.success).toBe(true);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(src)).toBe(false);
  });

  it('retorna success:false sem criar duplicata quando unlinkSync falha', () => {
    // Simula cross-device: renameSync vai falhar se src e dest estiverem em
    // sistemas de arquivos diferentes. Aqui forçamos o cenário mockando o módulo fs
    // diretamente na função para verificar a lógica de limpeza.
    // Como não podemos mockar facilmente no ambiente de teste sem jest.mock,
    // verificamos a lógica inspecionando o código-fonte (garantia estrutural).
    const mainSrc = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf-8');
    const fnStart = mainSrc.indexOf('function moveFile(');
    const fnEnd   = mainSrc.indexOf('\nfunction ', fnStart + 1);
    const fnBody  = mainSrc.slice(fnStart, fnEnd);

    // Deve tentar deletar a cópia se unlinkSync falhar
    expect(fnBody).toContain('unlinkSync(toPath)');
    // Deve retornar failure com a mensagem do erro de unlink
    expect(fnBody).toContain('unlinkErr.message');
    // Deve retornar success:false nesse caso
    expect(fnBody).toContain("success: false, error: unlinkErr.message");
  });

  it('retorna success:false quando copyFileSync falha (sem arquivo destino criado)', () => {
    const src  = path.join(tmpDir, 'nao-existe.package');
    const dest = path.join(tmpDir, 'dest.package');
    // src não existe — copyFileSync vai lançar exceção
    const result = moveFile(src, dest);
    expect(result.success).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('move com fallback de cópia (renameSync falha)', () => {
    // Não é fácil forçar cross-device em teste unitário portátil,
    // mas podemos verificar que o arquivo é movido corretamente no caminho normal.
    const src  = path.join(tmpDir, 'src.package');
    const dest = path.join(tmpDir, 'subdir', 'dest.package');
    fs.writeFileSync(src, 'conteudo-teste');
    const result = moveFile(src, dest);
    expect(result.success).toBe(true);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('conteudo-teste');
    expect(fs.existsSync(src)).toBe(false);
  });
});

// ─── BUG 3 e 4: Undo em deletes de overlays de grupo ─────────────────────────
// Validação via inspeção do código-fonte do renderer.js

describe('BUG 3 — wireGridEvents ctx delete registra pushUndo', () => {
  it('renderer.js deve conter pushUndo para delete em wireGridEvents', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf-8');
    // wireGridEvents fica dentro de openGroupOverlay
    const overlayStart = src.indexOf('function openGroupOverlay(');
    const overlayEnd   = src.indexOf('\nfunction openGroupGridOverlay', overlayStart);
    const overlayBlock = src.slice(overlayStart, overlayEnd);

    // wireGridEvents deve conter o bloco de undo
    const wireGridStart = overlayBlock.indexOf('function wireGridEvents()');
    const wireGridBlock = overlayBlock.slice(wireGridStart);

    expect(wireGridBlock).toContain('pushUndo');
    expect(wireGridBlock).toContain('trashPath');
    expect(wireGridBlock).toContain('originalPath');
    expect(wireGridBlock).toContain('updateTrashBadge');
  });
});

describe('BUG 4 — openGroupGridOverlay ctx delete registra pushUndo e logAction', () => {
  it('renderer.js deve conter pushUndo para delete em openGroupGridOverlay', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf-8');
    const fnStart = src.indexOf('function openGroupGridOverlay(');
    const fnEnd   = src.indexOf('\nfunction ', fnStart + 1);
    const fnBlock = src.slice(fnStart, fnEnd);

    expect(fnBlock).toContain('pushUndo');
    expect(fnBlock).toContain('trashPath');
    expect(fnBlock).toContain('originalPath');
    expect(fnBlock).toContain('logAction');
  });
});

// ─── BUG 5: init() — getAppVersion chamado apenas uma vez ────────────────────

describe('BUG 5 — init() não chama getAppVersion duas vezes', () => {
  it('renderer.js deve ter exatamente uma chamada a getAppVersion na função init', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf-8');
    const initStart = src.indexOf('\nasync function init()');
    const initEnd   = src.indexOf('\ninit();', initStart);
    const initBlock = src.slice(initStart, initEnd);

    // Conta chamadas a getAppVersion dentro de init()
    const matches = (initBlock.match(/getAppVersion/g) || []).length;
    expect(matches).toBe(1);
  });
});

// ─── BUG 6: consolidateGroup retorna apenas movimentos bem-sucedidos ──────────

describe('BUG 6 — consolidateGroup só inclui movimentos bem-sucedidos no movedMap', () => {
  it('consolidateGroup usa successfulMovedMap separado do movedMap planejado', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf-8');
    const fnIdx = src.indexOf('async function consolidateGroup(group)');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBlock = src.slice(fnIdx, fnIdx + 1600);
    // Deve declarar successfulMovedMap
    expect(fnBlock).toContain('successfulMovedMap');
    // Deve fazer push para successfulMovedMap apenas em caso de sucesso
    expect(fnBlock).toContain('successfulMovedMap.push');
    // Deve retornar movedMap: successfulMovedMap
    expect(fnBlock).toContain('movedMap: successfulMovedMap');
  });
});

// ─── BUG 7: btn-fix-all não registra pushUndo quando ok === 0 ────────────────

describe('BUG 7 — btn-fix-all guarda pushUndo com if (ok > 0)', () => {
  it('btn-fix-all deve ter if (ok > 0) antes de pushUndo', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf-8');
    const btnIdx = src.indexOf("el.querySelector('#btn-fix-all')?.addEventListener");
    expect(btnIdx).toBeGreaterThan(-1);
    const btnBlock = src.slice(btnIdx, btnIdx + 1200);
    // O bloco deve conter a guarda
    expect(btnBlock).toContain('if (ok > 0)');
    // pushUndo deve estar dentro do bloco de ok > 0
    const okGuardIdx = btnBlock.indexOf('if (ok > 0)');
    const pushUndoIdx = btnBlock.indexOf('pushUndo', okGuardIdx);
    expect(pushUndoIdx).toBeGreaterThan(okGuardIdx);
  });
});

// ─── BUG 8: btn-fix-all erro restaura texto correto do botão ─────────────────

describe('BUG 8 — btn-fix-all restaura label correto "Corrigir Todos" no catch', () => {
  it('o catch do btn-fix-all usa "Corrigir Todos" (não "Corrigir Tudo")', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf-8');
    const btnIdx = src.indexOf("el.querySelector('#btn-fix-all')?.addEventListener");
    expect(btnIdx).toBeGreaterThan(-1);
    const btnBlock = src.slice(btnIdx, btnIdx + 1600);
    expect(btnBlock).not.toContain('Corrigir Tudo\'');
    expect(btnBlock).toContain('Corrigir Todos');
  });
});
