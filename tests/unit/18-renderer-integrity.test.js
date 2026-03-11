'use strict';
/**
 * Testes de integridade estrutural do renderer.js
 *
 * Detecta erros que quebram a interface completamente sem lançar avisos visíveis:
 *  - SyntaxError (ex: declaração de função deletada por engano em commit)
 *  - Funções top-level essenciais ausentes ou com nome trocado
 *  - Funções internas de openGroupOverlay escapando para o escopo global
 *  - Desequilíbrio de chaves/parênteses/colchetes
 *  - Funções referenciadas que não existem no arquivo
 *  - Ausência de listeners críticos de inicialização
 *
 * Histórico: commit ad47919 deletou acidentalmente `function renderView(view) {`
 * dentro de openGroupOverlay, gerando SyntaxError que tornava toda a UI inoperante.
 * Nenhum teste existente detectava esse tipo de falha estrutural.
 */

const vm  = require('vm');
const fs  = require('fs');
const path = require('path');

const RENDERER_PATH = path.resolve(__dirname, '../../src/renderer.js');

let src = '';
beforeAll(() => {
  src = fs.readFileSync(RENDERER_PATH, 'utf8');
});

// ─── 1. Sintaxe ───────────────────────────────────────────────────────────────

describe('renderer.js — sintaxe', () => {
  test('não contém SyntaxError', () => {
    expect(() => new vm.Script(src, { filename: 'renderer.js' }))
      .not.toThrow();
  });

  test('arquivo não está vazio', () => {
    expect(src.length).toBeGreaterThan(1000);
  });
});

// ─── 2. Balanceamento de delimitadores ─────────────────────────────────────────
//
// Delimitadores (chaves, parênteses, colchetes) são verificados implicitamente
// pelo teste vm.Script acima. Contagem manual falha em regex literais como
// /\.(disabled)$/i que contêm ( ) sintáticos mas não são delimitadores de código.
// O vm.Script do Node.js já usa o parser V8 completo para isso.


// ─── 3. Funções top-level obrigatórias ───────────────────────────────────────

describe('renderer.js — funções top-level obrigatórias', () => {
  /**
   * Extrai nomes de funções declaradas no escopo global
   * (linha começa com `function` ou `async function`).
   */
  function getTopLevelFunctions(source) {
    const names = new Set();
    const re = /^(?:async\s+)?function\s+(\w+)\s*\(/gm;
    let m;
    while ((m = re.exec(source)) !== null) {
      names.add(m[1]);
    }
    return names;
  }

  const REQUIRED_TOP_LEVEL = [
    // Roteamento e inicialização
    'navigate', 'init',
    // Renderização de páginas
    'renderDashboard', 'renderMods', 'renderConflicts',
    'renderOrganizer', 'renderManual', 'renderHistory',
    'renderTrash', 'renderSettings',
    // Modal e overlays
    'openModal', 'closeModal',
    'openGroupOverlay', 'openGroupGridOverlay',
    // Utilitários de UI
    'toast', 'showUndoBar', 'clearUndoBar', 'pushUndo',
    'navigate',
    // Dados
    'loadMods', 'updateTrashBadge',
    // Helpers de renderização
    'formatBytes', 'escapeHtml', 'fileIcon',
    'typeBadge', 'statusBadge', 'thumbKey',
    'getModPrefix', 'groupModsByPrefix', 'groupTrayFiles',
    'renderPagination', 'getFilteredMods',
    // Galeria / tabela
    'renderGallery', 'renderTable',
    'setupGalleryEvents', 'setupModsEvents',
    'initRubberBand',
    // Conflitos / organizer
    'runConflictScan', 'renderConflictResults',
    'runOrganizeScan', 'renderOrganizeResults',
  ];

  let topLevel;
  beforeAll(() => {
    topLevel = getTopLevelFunctions(src);
  });

  REQUIRED_TOP_LEVEL.forEach(name => {
    test(`função "${name}" está declarada`, () => {
      expect(topLevel.has(name)).toBe(true);
    });
  });
});

// ─── 4. Funções internas de openGroupOverlay ─────────────────────────────────

describe('renderer.js — funções internas de openGroupOverlay', () => {
  /**
   * Verifica que funções que DEVEM ser internas (indentadas com 2 espaços)
   * dentro de openGroupOverlay não escaparam para o escopo global.
   *
   * O bug do commit ad47919: `function renderView(view) {` foi deletada,
   * fazendo o corpo virar código solto — o } de fechamento de openGroupOverlay
   * ficou no lugar errado, e wireListEvents etc. viraram top-level orphans.
   */
  const INTERNAL_ONLY = [
    'renderView',
    'refreshGroupFiles',
    'wireListEvents',
    'wireGridEvents',
    'buildListHtml',
    'buildGridHtml',
    'clearOverlaySelection',
    'selectOverlayItem',
    'initModalRubberBand',
  ];

  function getTopLevelFunctions(source) {
    const names = new Set();
    const re = /^(?:async\s+)?function\s+(\w+)\s*\(/gm;
    let m;
    while ((m = re.exec(source)) !== null) {
      names.add(m[1]);
    }
    return names;
  }

  let topLevel;
  beforeAll(() => {
    topLevel = getTopLevelFunctions(src);
  });

  INTERNAL_ONLY.forEach(name => {
    test(`"${name}" NÃO está no escopo global (deve ser interna à closure)`, () => {
      expect(topLevel.has(name)).toBe(false);
    });
  });

  test('todas as funções internas existem como declarações indentadas', () => {
    INTERNAL_ONLY.forEach(name => {
      // Aceita 2 ou 4 espaços de indentação
      const re = new RegExp(`^[ ]{2,}(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm');
      expect(src).toMatch(re);
    });
  });

  test('renderView está declarada DENTRO de openGroupOverlay (após linha de abertura)', () => {
    const openLine  = src.indexOf('function openGroupOverlay(group)');
    const renderLine = src.indexOf('  function renderView(view)');
    expect(openLine).toBeGreaterThan(-1);
    expect(renderLine).toBeGreaterThan(openLine);
  });
});

// ─── 5. Referências a funções críticas ───────────────────────────────────────

describe('renderer.js — funções referenciadas existem', () => {
  /**
   * Detecta chamadas a funções que deveriam existir mas foram deletadas/renomeadas.
   * Não é AST completo, mas cobre os padrões mais comuns de quebra.
   */

  function topLevelFunctions(source) {
    const names = new Set();
    const re = /^(?:async\s+)?function\s+(\w+)\s*\(/gm;
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
    return names;
  }

  // Pares [função-que-chama, função-chamada]: se o chamador existe, o chamado deve existir.
  const CALL_DEPS = [
    // init chama navigate
    ['init', 'navigate'],
    // init chama loadMods
    ['init', 'loadMods'],
    // renderMods chama renderGallery
    ['renderMods', 'renderGallery'],
    // renderMods chama renderTable
    ['renderMods', 'renderTable'],
    // renderMods chama getFilteredMods
    ['renderMods', 'getFilteredMods'],
    // navigate chama renderDashboard, renderMods, etc (all page renderers)
    ['navigate', 'renderDashboard'],
    ['navigate', 'renderMods'],
    // Utility callers
    ['renderDashboard', 'formatBytes'],
    ['renderDashboard', 'escapeHtml'],
  ];

  let names;
  beforeAll(() => { names = topLevelFunctions(src); });

  CALL_DEPS.forEach(([caller, callee]) => {
    test(`"${callee}" existe (chamada por "${caller}")`, () => {
      // Se o caller existe, o callee também deve existir
      if (names.has(caller)) {
        expect(names.has(callee)).toBe(true);
      }
    });
  });
});

// ─── 6. Listeners de inicialização ───────────────────────────────────────────

describe('renderer.js — listeners de inicialização obrigatórios', () => {
  test('nav-item tem listener de clique registrado', () => {
    expect(src).toMatch(/querySelectorAll\(['"].nav-item['"]\)/);
    expect(src).toMatch(/addEventListener\(['"]click['"]/);
  });

  test('modal-close-btn tem listener registrado', () => {
    expect(src).toMatch(/modal-close-btn/);
    expect(src).toMatch(/modal-close-btn.*addEventListener|addEventListener.*modal-close-btn/s);
  });

  test('init() é chamada para inicializar o app', () => {
    // Deve haver uma chamada direta a init() no escopo global (não dentro de outra função)
    expect(src).toMatch(/^init\(\)/m);
  });

  test('navigate("dashboard") é chamada em init()', () => {
    expect(src).toMatch(/navigate\(['"]dashboard['"]\)/);
  });

  test('window.api é usado para comunicação com o processo principal', () => {
    expect(src).toMatch(/window\.api\./);
  });
});

// ─── 7. Regressão específica: bug do commit ad47919 ─────────────────────────

describe('renderer.js — regressão: bug SyntaxError de ad47919', () => {
  /**
   * O commit ad47919 deletou `function renderView(view) {` dentro de openGroupOverlay.
   * Isso causou SyntaxError e tornou TODA a interface inoperante.
   * Este teste garante que esse padrão nunca mais passe despercebido.
   */

  test('openGroupOverlay contém a declaração de renderView internamente', () => {
    // A função deve existir como declaração indentada (não top-level)
    const internalDecl = /^  function renderView\(view\)/m;
    expect(src).toMatch(internalDecl);
  });

  test('renderView não está declarada como função top-level', () => {
    const topLevelDecl = /^(?:async\s+)?function\s+renderView\s*\(/m;
    expect(src).not.toMatch(topLevelDecl);
  });

  test('corpo de renderView (currentView = view) está dentro de openGroupOverlay', () => {
    const openStart  = src.indexOf('function openGroupOverlay(group)');
    const renderDecl = src.indexOf('  function renderView(view)');
    const currentViewAssign = src.indexOf('currentView = view;');

    expect(openStart).toBeGreaterThan(-1);
    expect(renderDecl).toBeGreaterThan(openStart);
    // currentView = view deve aparecer APÓS a declaração de renderView
    expect(currentViewAssign).toBeGreaterThan(renderDecl);
  });

  test('a remoção de "function renderView(view) {" geraria SyntaxError', () => {
    // Simula o bug: remove a declaração mas mantém o corpo
    const broken = src.replace(
      /^  function renderView\(view\) \{/m,
      '  // [SIMULAÇÃO DE BUG: declaração removida]'
    );
    // vm.Script lança SyntaxError de um contexto V8 interno; verificamos via message
    let threw = false;
    let errorName = '';
    try {
      new vm.Script(broken, { filename: 'renderer-broken.js' });
    } catch (e) {
      threw = true;
      errorName = e.constructor.name;
    }
    expect(threw).toBe(true);
    expect(errorName).toBe('SyntaxError');
  });
});

// ─── 8. Regressões de comportamento crítico ───────────────────────────────────

describe('renderer.js — regressões de comportamento crítico', () => {

  test('invalidateUndoForTrashPaths é chamado ANTES do await trashEmpty (bug undo ativo durante esvaziamento)', () => {
    // Garante que clearUndoBar e invalidateUndoForTrashPaths aparecem antes de
    // "await apiTrashEmpty()" no código fonte, impedindo que o botão
    // Desfazer permaneça ativo enquanto a operação de esvaziamento está em curso.
    const trashEmptyIdx   = src.indexOf('await apiTrashEmpty()');
    const invalidateIdx   = src.lastIndexOf('invalidateUndoForTrashPaths(allTrashPaths)', trashEmptyIdx);
    const clearUndoIdx    = src.lastIndexOf('clearUndoBar()', trashEmptyIdx);

    expect(trashEmptyIdx).toBeGreaterThan(-1);
    expect(invalidateIdx).toBeGreaterThan(-1);
    expect(clearUndoIdx).toBeGreaterThan(-1);

    // Ambas as chamadas de invalidação devem aparecer ANTES do await
    expect(invalidateIdx).toBeLessThan(trashEmptyIdx);
    expect(clearUndoIdx).toBeLessThan(trashEmptyIdx);
  });

  test('exclusão de pastas vazias usa pushUndo com restoreEmptyFolders (undo suportado)', () => {
    // Pastas vazias agora suportam desfazer — são recriadas via restoreEmptyFolders.
    // O código deve usar pushUndo com uma undoFn que chama apiRestoreEmptyFolders.
    const deleteEmptyIdx       = src.indexOf("await apiDeleteEmptyFolders(paths)");
    const deleteEmptySingleIdx = src.indexOf("await apiDeleteEmptyFolders([folder.path]");

    const afterBatch  = src.slice(deleteEmptyIdx,  deleteEmptyIdx  + 2000);
    const afterSingle = src.slice(deleteEmptySingleIdx, deleteEmptySingleIdx + 2000);

    // pushUndo deve aparecer logo após cada deleteEmptyFolders
    expect(afterBatch).toMatch(/pushUndo\(/);
    expect(afterSingle).toMatch(/pushUndo\(/);

    // A undoFn deve chamar restoreEmptyFolders
    expect(afterBatch).toContain('apiRestoreEmptyFolders');
    expect(afterSingle).toContain('apiRestoreEmptyFolders');

    // restoreEmptyFolders deve existir como wrapper no renderer
    expect(src).toMatch(/apiRestoreEmptyFolders/);
  });

  test('handler organize:restore-empty-folders existe no main.js', () => {
    const mainSrc = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../main.js'), 'utf8'
    );
    expect(mainSrc).toContain("ipcMain.handle('organize:restore-empty-folders'");
    // O handler deve usar mkdirSync para recriar as pastas
    const handlerStart = mainSrc.indexOf("ipcMain.handle('organize:restore-empty-folders'");
    const handlerBody  = mainSrc.slice(handlerStart, mainSrc.indexOf('ipcMain.handle', handlerStart + 10));
    expect(handlerBody).toContain('mkdirSync');
  });

  test('trash:delete-permanent e trash:empty não chamam shell.trashItem (deleção permanente direta)', () => {
    const mainSrc = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../main.js'), 'utf8'
    );
    // Localizar os handlers
    const permStart  = mainSrc.indexOf("ipcMain.handle('trash:delete-permanent'");
    const emptyStart = mainSrc.indexOf("ipcMain.handle('trash:empty'");

    // Extrair o corpo de cada handler (até o próximo ipcMain.handle)
    const permBody  = mainSrc.slice(permStart,  mainSrc.indexOf('ipcMain.handle', permStart  + 10));
    const emptyBody = mainSrc.slice(emptyStart, mainSrc.indexOf('ipcMain.handle', emptyStart + 10));

    // Nenhum dos handlers deve chamar shell.trashItem
    expect(permBody).not.toContain('shell.trashItem');
    expect(emptyBody).not.toContain('shell.trashItem');

    // Ambos devem usar fs.unlinkSync ou fs.rmSync para deleção direta
    expect(permBody).toMatch(/fs\.(unlinkSync|rmSync)/);
    expect(emptyBody).toMatch(/fs\.(unlinkSync|rmSync)/);
  });
});
