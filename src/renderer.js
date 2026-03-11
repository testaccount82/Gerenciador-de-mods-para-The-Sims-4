'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

// FIX BUG 4: Sentinel symbol to mark thumbnails that are currently being loaded.
// Using Symbol ensures it can never equal undefined (key-not-present), null (no thumb), or a base64 string.
const THUMB_LOADING = Symbol('loading');

// Normalize the cache key by stripping the ".disabled" suffix so that toggling
// a mod (which renames the file) doesn't bust the thumbnail cache.
function thumbKey(path) {
  return path ? path.replace(/\.disabled$/i, '') : path;
}

const state = {
  config: null,
  mods: [],
  trayFiles: [],
  conflicts: [],
  misplaced: [],
  scattered: [],   // groups of mods scattered across multiple folders
  currentPage: 'dashboard',
  selectedMods: new Set(),
  searchQuery: '',
  filterStatus: 'all',
  filterType: 'all',
  filterFolder: 'all',
  sortColumn: 'name',
  sortDir: 'asc',
  undoStack: [],
  actionLog: [],   // histórico de ações do usuário
  scanning: false,
  conflictScanning: false,
  organizeScanning: false,
  emptyFolders: [],   // empty folder paths found by the organizer
  invalidFiles: [],   // files with unrecognised extensions in Mods/Tray folders
  // Gallery
  viewMode: 'grid',       // 'list' | 'grid' — FIX BUG 2: was 'list', thumbnails only show in grid mode
  galleryPage: 1,
  itemsPerPage: 30,
  thumbnailCache: {},     // path -> base64 | null
  expandedGroups: new Set(), // group keys currently expanded
  appVersion: null,        // cached app version string (populated in init())
};

// Prevents runStartupChecks() from being called more than once per session
let _startupChecksRan = false;

// Sort state for the Trash page (persists between re-renders)
const trashSort = { col: 'trashedAt', dir: 'desc' };

// ─── Utilities ───────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fileIcon(type) {
  const icons = { package: '📦', script: '⚙️', tray: '🏠', 'tray-in-mods': '⚠️', 'mods-in-tray': '⚠️' };
  return icons[type] || '📄';
}

function typeBadge(type) {
  if (type === 'package') return '<span class="badge badge-package">.package</span>';
  if (type === 'script')  return '<span class="badge badge-script">.ts4script</span>';
  if (type === 'tray')    return '<span class="badge badge-tray">Tray</span>';
  return '<span class="badge badge-warn">Mal colocado</span>';
}

function statusBadge(enabled, partial = false) {
  if (partial) return '<span class="badge badge-partial">Parcial</span>';
  return enabled
    ? '<span class="badge badge-active">Ativo</span>'
    : '<span class="badge badge-inactive">Inativo</span>';
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function toast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<div class="toast-dot"></div><span>${escapeHtml(message)}</span>`;
  container.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 280);
  }, duration);
}

// ─── Modal ───────────────────────────────────────────────────────────────────

function openModal(title, bodyHtml, buttons = []) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  const footer = document.getElementById('modal-footer');
  footer.innerHTML = '';
  buttons.forEach(({ label, cls, action }) => {
    const btn = document.createElement('button');
    btn.className = `btn ${cls || 'btn-secondary'}`;
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      closeModal();
      try { await action(); } catch (e) { console.error('Modal action error:', e); }
    });
    footer.appendChild(btn);
  });
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// ─── Undo System ─────────────────────────────────────────────────────────────

function pushUndo(label, undoFn, type = 'action', details = {}, redoFn = null) {
  // Store undoFn in the log entry so History page can expose it
  const entry = {
    id: Date.now() + Math.random(),
    type,
    details: { ...details, label },
    timestamp: new Date(),
    undoFn,
    redoFn,
    undone: false,
  };
  state.actionLog.unshift(entry);
  if (state.actionLog.length > 500) state.actionLog.length = 500;
  if (state.currentPage === 'history') renderHistory();

  state.undoStack.push({ label, undoFn });
  showUndoBar(label);
}


// Oculta a barra de desfazer e limpa a pilha — usado após ações permanentes
// que invalidam qualquer desfazer anterior (ex: enviar para lixeira do sistema)
function clearUndoBar() {
  const bar = document.getElementById('undo-bar');
  if (bar) { clearTimeout(bar._timer); bar.classList.add('hidden'); }
  state.undoStack.length = 0;
}

// Marca entradas do histórico como permanentemente não-desfazíveis quando os
// trashPaths correspondentes foram enviados à lixeira do sistema ou esvaziados.
// Sem isso, o botão "↩ Desfazer" continua visível no histórico mas não tem efeito.
function invalidateUndoForTrashPaths(trashPaths) {
  if (!trashPaths || !trashPaths.length) return;
  const pathSet = new Set(trashPaths);
  let changed = false;
  state.actionLog.forEach(entry => {
    if (!entry.undoFn || entry.undone) return;
    const entryPaths = entry.details?.trashPaths;
    if (!entryPaths) return;
    const overlaps = entryPaths.some(p => pathSet.has(p));
    if (overlaps) {
      entry.undoFn  = null;
      entry.redoFn  = null;
      entry.details.permanent = true; // flag para exibir label no histórico
      changed = true;
    }
  });
  if (changed && state.currentPage === 'history') renderHistory();
}
function showUndoBar(label) {
  let bar = document.getElementById('undo-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'undo-bar';
    document.body.appendChild(bar);
  }
  bar.innerHTML = `
    <span>${escapeHtml(label)}</span>
    <button class="btn btn-secondary btn-sm" id="undo-btn">↩ Desfazer</button>
    <button class="icon-btn" id="undo-dismiss">✕</button>
  `;
  bar.classList.remove('hidden');
  clearTimeout(bar._timer);
  bar._timer = setTimeout(() => bar.classList.add('hidden'), 5000);
  document.getElementById('undo-btn').addEventListener('click', async () => {
    const op = state.undoStack.pop();
    bar.classList.add('hidden');
    if (op) {
      try {
        await op.undoFn();
        toast('Operação desfeita', 'info');
      } catch (e) {
        toast('Erro ao desfazer: ' + (e.message || ''), 'error');
      }
    }
  });
  document.getElementById('undo-dismiss').addEventListener('click', () => {
    state.undoStack.pop();
    bar.classList.add('hidden');
  });
}

// ─── Action Log ──────────────────────────────────────────────────────────────

const ACTION_ICONS = {
  toggle_on:   '▶',
  toggle_off:  '⏸',
  delete:      '🗑',
  import:      '📥',
  move:        '📁',
  consolidate: '📦',
  restore:     '↩',
  scan:        '🔍',
  fs_change:   '🔄',
};

function logAction(type, details = {}) {
  const entry = {
    id: Date.now() + Math.random(),
    type,
    details,
    timestamp: new Date(),
  };
  state.actionLog.unshift(entry);
  if (state.actionLog.length > 500) state.actionLog.length = 500; // cap
  // Refresh history page if open
  if (state.currentPage === 'history') renderHistory();
}

// ─── Column Resize ───────────────────────────────────────────────────────────

// ─── Background Scan (startup) ───────────────────────────────────────────────

// Two fully independent progress trackers — one per scan type.
// This allows both scans to run simultaneously without interfering.
const organizeProgress = {
  running:   false,
  cancelled: false,
};

const conflictProgress = {
  running:   false,
  remaining: 0,
  total:     0,
  cancelled: false,
};

// Legacy alias so any stray code using scanProgress.cancelled still works.
const scanProgress = organizeProgress;

function updateScanIndicator() {
  const elOrg  = document.getElementById('sidebar-scan-indicator-organize');
  const elConf = document.getElementById('sidebar-scan-indicator-conflicts');
  if (!elOrg || !elConf) return;

  // ── Organizar indicator — hidden when user is already on that page ────────
  if (organizeProgress.running && state.currentPage !== 'organizer') {
    elOrg.classList.remove('hidden');
    const text = document.getElementById('scan-indicator-organize-text');
    const bar  = document.getElementById('scan-indicator-organize-bar');
    if (text) text.textContent = 'Verificando arquivos e pastas…';
    // Indeterminate bar — set to 60% so the pulse animation is visible
    if (bar) bar.style.width = '60%';
  } else {
    elOrg.classList.add('hidden');
    const bar = document.getElementById('scan-indicator-organize-bar');
    if (bar) bar.style.width = '0%';
  }

  // ── Conflitos indicator — hidden when user is already on that page ────────
  if (conflictProgress.running && state.currentPage !== 'conflicts') {
    elConf.classList.remove('hidden');
    const text = document.getElementById('scan-indicator-conflicts-text');
    const bar  = document.getElementById('scan-indicator-conflicts-bar');
    if (text) text.textContent = conflictProgress.remaining > 0
      ? `${conflictProgress.remaining} arquivo(s) restantes`
      : 'Verificando hashes…';
    if (bar) {
      if (conflictProgress.total > 0) {
        const done = conflictProgress.total - conflictProgress.remaining;
        bar.style.width = Math.max(5, Math.round((done / conflictProgress.total) * 100)) + '%';
      } else {
        // Total not yet known — show indeterminate progress
        bar.style.width = '30%';
      }
    }
  } else {
    elConf.classList.add('hidden');
    const bar = document.getElementById('scan-indicator-conflicts-bar');
    if (bar) bar.style.width = '0%';
  }
}

function startOrganizeIndicator() {
  organizeProgress.running   = true;
  organizeProgress.cancelled = false;
  updateScanIndicator();
}

function stopOrganizeIndicator() {
  organizeProgress.running = false;
  updateScanIndicator();
}

function startConflictIndicator() {
  conflictProgress.running   = true;
  conflictProgress.cancelled = false;
  conflictProgress.remaining = 0;
  conflictProgress.total     = 0;
  updateScanIndicator();

  const stopBtn = document.getElementById('scan-indicator-stop');
  if (stopBtn) {
    stopBtn.onclick = () => {
      conflictProgress.cancelled = true;
      window.api.cancelConflictScan();
      stopConflictIndicator();
    };
  }
}

function stopConflictIndicator() {
  conflictProgress.running   = false;
  conflictProgress.remaining = 0;
  conflictProgress.total     = 0;
  updateScanIndicator();
}

// Legacy shims — keep callers working during transition
function startScanIndicator(phase) {
  if (phase === 'conflicts') startConflictIndicator();
  else startOrganizeIndicator();
}
function stopScanIndicator() {
  stopOrganizeIndicator();
  stopConflictIndicator();
}


// ─── Context Menu ────────────────────────────────────────────────────────────

let _ctxMenu = null;

function closeCtxMenu() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
}

function showCtxMenu(x, y, filePath, options = {}) {
  closeCtxMenu();

  const svgTrash = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
  </svg>`;

  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  menu.innerHTML = `
    <div class="ctx-item" id="ctx-open-folder">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
      </svg>
      Abrir pasta do arquivo
    </div>
    ${options.onDelete ? `<div class="ctx-item ctx-item-danger" id="ctx-delete">${svgTrash} Excluir arquivo</div>` : ''}`;

  document.body.appendChild(menu);
  _ctxMenu = menu;

  // Posicionar sem sair da tela
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const ww = window.innerWidth, wh = window.innerHeight;
  menu.style.left = (x + mw > ww ? ww - mw - 6 : x) + 'px';
  menu.style.top  = (y + mh > wh ? wh - mh - 6 : y) + 'px';

  menu.querySelector('#ctx-open-folder').addEventListener('click', () => {
    window.api.showItemInFolder(filePath);
    closeCtxMenu();
  });

  if (options.onDelete) {
    menu.querySelector('#ctx-delete').addEventListener('click', () => {
      closeCtxMenu();
      options.onDelete(filePath);
    });
  }
}

// Fechar ao clicar fora ou pressionar Escape
document.addEventListener('mousedown', e => { if (_ctxMenu && !_ctxMenu.contains(e.target)) closeCtxMenu(); });
document.addEventListener('keydown',   e => { if (e.key === 'Escape') closeCtxMenu(); });

function attachCtxMenu(container) {
  // Cards da galeria (individuais e grupos)
  container.querySelectorAll('.gallery-card[data-path]').forEach(card => {
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, card.dataset.path);
    });
  });
  // Linhas da tabela (individuais e child-rows)
  container.querySelectorAll('tr[data-path]').forEach(row => {
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, row.dataset.path);
    });
  });
}

function initColumnResize(table) {
  const handles = table.querySelectorAll('.col-resize-handle');
  handles.forEach(handle => {
    let startX, startW, th;
    handle.addEventListener('mousedown', e => {
      th = handle.parentElement;
      startX = e.pageX;
      startW = th.offsetWidth;
      e.preventDefault();
      const onMove = ev => { th.style.width = Math.max(60, startW + ev.pageX - startX) + 'px'; };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ─── Router ──────────────────────────────────────────────────────────────────

function navigate(page) {
  state.currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  document.querySelector(`[data-page="${page}"]`).classList.add('active');

  const renderers = {
    dashboard: renderDashboard,
    mods: renderMods,
    conflicts: renderConflicts,
    organizer: renderOrganizer,
    manual: renderManual,
    history: renderHistory,
    trash: renderTrash,
    settings: renderSettings
  };
  if (renderers[page]) renderers[page]();

  // Mostrar/ocultar indicador de sidebar conforme a aba atual
  updateScanIndicator();
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

async function renderDashboard() {
  const el = document.getElementById('page-dashboard');
  const allMods = [...state.mods, ...state.trayFiles];
  const active = allMods.filter(m => m.enabled).length;
  const inactive = allMods.filter(m => !m.enabled).length;
  const totalSize = allMods.reduce((s, m) => s + m.size, 0);
  const modsOk = state.modsFolderExists ?? false;
  const trayOk = state.trayFolderExists ?? false;

  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Início</div>
        <div class="page-subtitle">Visão geral dos seus mods</div>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary" id="dash-refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
          </svg>
          Atualizar
        </button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card accent">
        <div class="stat-label">Total de Mods</div>
        <div class="stat-value">${allMods.length}</div>
      </div>
      <div class="stat-card success stat-card-link" data-filter-status="active" title="Ver mods ativos">
        <div class="stat-label">Ativos</div>
        <div class="stat-value">${active}</div>
      </div>
      <div class="stat-card warning stat-card-link" data-filter-status="inactive" title="Ver mods inativos">
        <div class="stat-label">Inativos</div>
        <div class="stat-value">${inactive}</div>
      </div>
      <div class="stat-card info stat-card-link" data-filter-type="package" title="Ver pacotes .package">
        <div class="stat-label">Pacotes (.package)</div>
        <div class="stat-value">${state.mods.filter(m => m.type === 'package').length}</div>
      </div>
      <div class="stat-card warning stat-card-link" data-filter-type="script" title="Ver scripts .ts4script">
        <div class="stat-label">Scripts (.ts4script)</div>
        <div class="stat-value">${state.mods.filter(m => m.type === 'script').length}</div>
      </div>
      <div class="stat-card tray stat-card-link" data-filter-type="tray" title="Ver itens do Tray">
        <div class="stat-label">Tray</div>
        <div class="stat-value">${state.trayFiles.length}</div>
      </div>
      <div class="stat-card accent">
        <div class="stat-label">Tamanho Total</div>
        <div class="stat-value" style="font-size:18px;letter-spacing:-0.5px">${formatBytes(totalSize)}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Status das Pastas</div>
      <div class="folder-status-grid">
        <div class="folder-row">
          <div class="folder-dot ${modsOk ? 'ok' : 'missing'}"></div>
          <div class="folder-label">Mods</div>
          <div class="folder-path">${escapeHtml(state.config?.modsFolder || 'Não configurada')}</div>
          <div class="folder-status-text ${modsOk ? 'ok' : 'missing'}">${modsOk ? '✓ Detectada' : '✗ Não encontrada'}</div>
          ${!modsOk ? '<button class="btn btn-sm btn-secondary" id="btn-fix-mods">Configurar</button>' : `<button class="btn btn-sm btn-subtle" id="btn-open-mods">Abrir</button>`}
        </div>
        <div class="folder-row">
          <div class="folder-dot ${trayOk ? 'ok' : 'missing'}"></div>
          <div class="folder-label">Tray</div>
          <div class="folder-path">${escapeHtml(state.config?.trayFolder || 'Não configurada')}</div>
          <div class="folder-status-text ${trayOk ? 'ok' : 'missing'}">${trayOk ? '✓ Detectada' : '✗ Não encontrada'}</div>
          ${!trayOk ? '<button class="btn btn-sm btn-secondary" id="btn-fix-tray">Configurar</button>' : `<button class="btn btn-sm btn-subtle" id="btn-open-tray">Abrir</button>`}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Ações Rápidas</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="quick-import">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Importar Mods
        </button>
        <button class="btn btn-secondary" id="quick-conflicts">⚠️ Verificar Conflitos</button>
        <button class="btn btn-secondary" id="quick-organize">📁 Verificar Organização</button>
      </div>
    </div>

    <div id="dash-alerts" style="display:flex;flex-direction:column;gap:8px"></div>
  `;

  el.querySelector('#dash-refresh')?.addEventListener('click', async () => { await loadMods(); renderDashboard(); toast('Atualizado', 'info', 1500); });
  el.querySelector('#btn-fix-mods')?.addEventListener('click', () => navigate('settings'));
  el.querySelector('#btn-fix-tray')?.addEventListener('click', () => navigate('settings'));
  el.querySelector('#btn-open-mods')?.addEventListener('click', () => window.api.openInExplorer(state.config.modsFolder));
  el.querySelector('#btn-open-tray')?.addEventListener('click', () => window.api.openInExplorer(state.config.trayFolder));
  el.querySelector('#quick-import')?.addEventListener('click', () => navigate('mods'));
  el.querySelector('#quick-conflicts')?.addEventListener('click', () => navigate('conflicts'));
  el.querySelector('#quick-organize')?.addEventListener('click', () => navigate('organizer'));

  // Stat cards → navigate to Mods with the corresponding filter pre-applied
  el.querySelectorAll('.stat-card-link').forEach(card => {
    card.addEventListener('click', () => {
      state.filterStatus = card.dataset.filterStatus || 'all';
      state.filterType   = card.dataset.filterType   || 'all';
      state.filterFolder = 'all';
      state.searchQuery  = '';
      state.galleryPage  = 1;
      navigate('mods');
    });
  });

  // Show alerts from already-completed scan results (or "in progress" hint)
  if (modsOk) renderDashboardAlerts(el);
}

// Renders alerts on the dashboard based on already-completed scan results in state.
// Does NOT trigger any scan — scans are initiated by runStartupChecks() at init().
function renderDashboardAlerts(el) {
  const alertsEl = el.querySelector('#dash-alerts');
  if (!alertsEl) return;

  const alerts = [];

  if (state.misplaced.length > 0) {
    alerts.push({
      type: 'warning', icon: '📁',
      message: `${state.misplaced.length} arquivo(s) em locais incorretos`,
      action: 'organizer', actionLabel: 'Ver e corrigir'
    });
  }

  if (state.emptyFolders.length > 0) {
    alerts.push({
      type: 'warning', icon: '🗂️',
      message: `${state.emptyFolders.length} pasta(s) vazia(s) encontrada(s)`,
      action: 'organizer', actionLabel: 'Ver e corrigir'
    });
  }

  if (state.invalidFiles.length > 0) {
    alerts.push({
      type: 'danger', icon: '🚫',
      message: `${state.invalidFiles.length} arquivo(s) inválido(s) nas pastas de mods`,
      action: 'organizer', actionLabel: 'Ver e remover'
    });
  }

  if (state.conflicts.length > 0) {
    alerts.push({
      type: 'danger', icon: '⚠️',
      message: `${state.conflicts.length} conflito(s) ou duplicata(s) detectado(s)`,
      action: 'conflicts', actionLabel: 'Ver conflitos'
    });
  }

  if (!alertsEl.isConnected) return;

  if (alerts.length === 0) {
    alertsEl.innerHTML = '';
    return;
  }

  alertsEl.innerHTML = alerts.map(a => `
    <div class="notice ${a.type}" style="justify-content:space-between;align-items:center">
      <span>${a.icon} ${escapeHtml(a.message)}</span>
      <button class="btn btn-sm btn-secondary dash-alert-btn" data-page="${a.action}" style="flex-shrink:0">${a.actionLabel} →</button>
    </div>
  `).join('');

  alertsEl.querySelectorAll('.dash-alert-btn').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.page));
  });
}

// Runs all configured startup scans in the background.
// Drives the sidebar indicator and updates the dashboard when done.
// Guarded by _startupChecksRan so it can only execute once per session.
async function runStartupChecks() {
  if (_startupChecksRan) return;
  _startupChecksRan = true;

  const cfg = state.config;
  if (!cfg?.modsFolder) return;

  const checkMisplaced  = cfg.autoCheckMisplaced !== false;
  const checkDuplicates = cfg.autoCheckDuplicates === true;
  if (!checkMisplaced && !checkDuplicates) return;

  // Wait for a full render cycle before starting so the UI is responsive first
  await new Promise(r => setTimeout(r, 300));

  // If another conflicts scan is already running, skip — don't abort organize
  if (state.conflictScanning) return;

  // --- Phase 1: misplaced + empty folders + scattered groups (fast, no file I/O) ---
  if (checkMisplaced && !state.organizeScanning) {
    state.organizeScanning = true;
    startOrganizeIndicator();
    try {
      const [misplaced, emptyFolders, scattered, invalidFiles] = await Promise.all([
        window.api.scanMisplaced(cfg.modsFolder, cfg.trayFolder),
        window.api.scanEmptyFolders(cfg.modsFolder, cfg.trayFolder),
        window.api.scanScatteredGroups(cfg.modsFolder),
        window.api.scanInvalidFiles(cfg.modsFolder, cfg.trayFolder),
      ]);
      state.misplaced    = misplaced;
      state.emptyFolders = emptyFolders;
      state.scattered    = scattered;
      state.invalidFiles = invalidFiles;
    } catch (_) {}
    state.organizeScanning = false;
    stopOrganizeIndicator();
  }

  // --- Phase 2: conflicts/hash (slow — drives the remaining counter) ---
  if (checkDuplicates && !state.conflictScanning) {
    state.conflictScanning = true;
    startConflictIndicator();
    const unsubscribe = window.api.onConflictProgress(({ done, total }) => {
      conflictProgress.remaining = total - done;
      conflictProgress.total     = total;
      updateScanIndicator();
      // Also update in-page progress if user is on conflicts tab
      if (state.currentPage === 'conflicts') {
        const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
        const bar   = document.getElementById('conflict-progress-bar');
        const label = document.getElementById('conflict-progress-label');
        const text  = document.getElementById('conflict-loading-text');
        if (bar)   bar.style.width   = pct + '%';
        if (label) label.textContent = `${done} de ${total} arquivo${total !== 1 ? 's' : ''}`;
        if (text)  text.textContent  = 'Verificando conteúdo duplicado (MD5)…';
      }
    });
    try {
      const result = await window.api.scanConflicts(cfg.modsFolder);
      if (result !== null) state.conflicts = result;
    } catch (_) {}
    unsubscribe();
    state.conflictScanning = false;
    stopConflictIndicator();
  }

  // Refresh dashboard alerts if it's the current page
  const dashEl = document.getElementById('page-dashboard');
  if (dashEl?.classList.contains('active')) {
    renderDashboardAlerts(dashEl);
  }
}

// ─── Mods Page ───────────────────────────────────────────────────────────────

function getFilteredMods() {
  let mods = [...state.mods, ...state.trayFiles];

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    mods = mods.filter(m => m.name.toLowerCase().includes(q));
  }
  // NOTE: active/inactive/partial filters are applied AFTER grouping in renderMods()
  // so partial groups are never split into "only disabled files" here.
  if (state.filterType !== 'all') {
    mods = mods.filter(m => m.type === state.filterType);
  }
  if (state.filterFolder !== 'all') {
    mods = mods.filter(m => m.folder === state.filterFolder);
  }

  mods.sort((a, b) => {
    let va = a[state.sortColumn] ?? '';
    let vb = b[state.sortColumn] ?? '';
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
    if (va > vb) return state.sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  return mods;
}

function getFolders() {
  const allMods = [...state.mods, ...state.trayFiles];
  return [...new Set(allMods.map(m => m.folder))].filter(f => f && f !== '/').sort();
}

function renderMods() {
  const el = document.getElementById('page-mods');
  const allFiltered  = getFilteredMods();
  const folders      = getFolders();
  const allMods      = [...state.mods, ...state.trayFiles];
  const total        = allMods.length;
  const activeCount  = allMods.filter(m => m.enabled).length;
  const pkgCount     = allMods.filter(m => m.type === 'package').length;
  const scriptCount  = allMods.filter(m => m.type === 'script').length;
  const trayCount    = allMods.filter(m => m.type === 'tray').length;
  const selCount     = state.selectedMods.size;
  const hasFilter    = state.searchQuery || state.filterStatus !== 'all'
                     || state.filterType !== 'all' || state.filterFolder !== 'all';

  // Group tray files by GUID, then group mods by prefix before pagination
  let allGrouped = groupModsByPrefix(groupTrayFiles(allFiltered));

  // Apply status filter after grouping — at the group level, using actual file states.
  // This prevents partial groups from being split or misclassified.
  if (state.filterStatus === 'active') {
    allGrouped = allGrouped.filter(m => {
      const files = m._isTrayGroup || m._isModGroup ? m.files : null;
      return files ? files.every(f => f.enabled) : m.enabled;
    });
  } else if (state.filterStatus === 'inactive') {
    allGrouped = allGrouped.filter(m => {
      const files = m._isTrayGroup || m._isModGroup ? m.files : null;
      return files ? !files.some(f => f.enabled) : !m.enabled;
    });
  } else if (state.filterStatus === 'partial') {
    allGrouped = allGrouped.filter(m => {
      const files = m._isTrayGroup || m._isModGroup ? m.files : null;
      if (!files) return false;
      const anyEnabled = files.some(f => f.enabled);
      const allEnabled = files.every(f => f.enabled);
      return anyEnabled && !allEnabled;
    });
  }

  // Pagination — itemsPerPage=Infinity means "show all" (single page)
  const effectivePerPage = isFinite(state.itemsPerPage) ? state.itemsPerPage : allGrouped.length || 1;
  const totalPages = Math.max(1, Math.ceil(allGrouped.length / effectivePerPage));
  if (state.galleryPage > totalPages) state.galleryPage = totalPages;
  const start = (state.galleryPage - 1) * effectivePerPage;
  const mods = allGrouped.slice(start, start + effectivePerPage);

  const isGrid = state.viewMode === 'grid';

  const subtitle = total === 0
    ? 'Nenhum mod encontrado'
    : hasFilter
      ? `${allGrouped.length} de ${total} · ${activeCount} ativos`
      : `${total} mods · ${activeCount} ativos`;

  el.innerHTML = `
    <!-- ── Header ─────────────────────────────────────────────────── -->
    <div class="page-header">
      <div>
        <div class="page-title">Mods</div>
        <div class="page-subtitle">${subtitle}</div>
      </div>
      <div class="header-actions">
        <div class="view-toggle">
          <button class="view-btn ${!isGrid ? 'active' : ''}" id="view-list" title="Lista">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
              <line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/>
              <line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
          </button>
          <button class="view-btn ${isGrid ? 'active' : ''}" id="view-grid" title="Grade">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
            </svg>
          </button>
        </div>
        <button class="btn btn-secondary" id="btn-refresh-mods">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
          </svg>
          Atualizar
        </button>
        <button class="btn btn-primary" id="btn-import">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Importar
        </button>
      </div>
    </div>

    <!-- ── Filter bar ──────────────────────────────────────────────── -->
    <div class="mods-filterbar">
      <!-- Search -->
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input class="search-input" id="search-input" type="text"
               placeholder="Buscar mods…" value="${escapeHtml(state.searchQuery)}">
        ${state.searchQuery ? `<button class="search-clear-btn" id="search-clear">✕</button>` : ''}
      </div>

      <!-- Status chips -->
      <div class="chip-group">
        <button class="chip ${state.filterStatus === 'all'    ? 'chip-on' : ''}" data-fs="all"
          title="Mostrar todos os mods independentemente do status">Todos</button>
        <button class="chip ${state.filterStatus === 'active' ? 'chip-on' : ''}" data-fs="active"
          title="Mostrar apenas mods ativos (habilitados)">
          <span class="chip-dot chip-dot-green"></span>Ativos
        </button>
        <button class="chip ${state.filterStatus === 'inactive' ? 'chip-on' : ''}" data-fs="inactive"
          title="Mostrar apenas mods inativos (desabilitados com .disabled)">
          <span class="chip-dot chip-dot-dim"></span>Inativos
        </button>
        <button class="chip ${state.filterStatus === 'partial' ? 'chip-on' : ''}" data-fs="partial"
          title="Grupos onde apenas alguns arquivos estão ativos">
          <span class="chip-dot chip-dot-partial"></span>Parciais
        </button>
      </div>

      <!-- Type chips -->
      <div class="chip-group">
        <button class="chip ${state.filterType === 'all'     ? 'chip-on' : ''}" data-ft="all"
          title="Mostrar todos os tipos de arquivo">
          <span class="chip-pill">${total}</span>Qualquer
        </button>
        <button class="chip ${state.filterType === 'package' ? 'chip-on' : ''}" data-ft="package"
          title="Mostrar apenas arquivos .package">
          <span class="chip-pill chip-pill-pkg">${pkgCount}</span>.package
        </button>
        <button class="chip ${state.filterType === 'script'  ? 'chip-on' : ''}" data-ft="script"
          title="Mostrar apenas scripts .ts4script">
          <span class="chip-pill chip-pill-scr">${scriptCount}</span>Script
        </button>
        <button class="chip ${state.filterType === 'tray'    ? 'chip-on' : ''}" data-ft="tray"
          title="Mostrar apenas itens do Tray (construção e CAS)">
          <span class="chip-pill chip-pill-tray">${trayCount}</span>Tray
        </button>
      </div>

      <!-- Folder select + extras -->
      <div class="mods-filterbar-end">
        ${folders.length > 0 ? `
          <select class="select-filter" id="filter-folder" style="width:auto;font-size:12px;padding:5px 26px 5px 8px">
            <option value="all">📁 Todas as pastas</option>
            ${folders.map(f => `<option value="${escapeHtml(f)}" ${state.filterFolder===f?'selected':''}>${escapeHtml(f === '/' ? '(raiz)' : f)}</option>`).join('')}
          </select>
        ` : ''}
        ${hasFilter ? `<button class="chip chip-clear" id="clear-filters">✕ Limpar</button>` : ''}
        ${isGrid ? `
          <label class="select-all-label">
            <input type="checkbox" class="checkbox" id="select-all-grid">
            <span>Todos</span>
          </label>
        ` : ''}
        <select class="select-filter" id="items-per-page" style="width:auto;font-size:12px;padding:5px 26px 5px 8px"
          title="Itens por página">
          <option value="Infinity" ${!isFinite(state.itemsPerPage)?'selected':''}>Sem limite</option>
          <option value="30" ${state.itemsPerPage===30?'selected':''}>30/pág</option>
          <option value="50" ${state.itemsPerPage===50?'selected':''}>50/pág</option>
          <option value="100" ${state.itemsPerPage===100?'selected':''}>100/pág</option>
        </select>
      </div>
    </div>

    <!-- ── Drag & Drop hint (static, visible when idle) ───────────────── -->
    <div class="drag-hint" id="drag-hint">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      <span>Arraste arquivos ou pastas (.package, .ts4script, .trayitem, .zip, .rar, .7z) para importar — pastas são percorridas automaticamente</span>
    </div>

    <!-- ── Drag overlay (hidden until drag enters) ─────────────────── -->
    <div class="drop-overlay" id="drop-zone">
      <div class="drop-overlay-inner">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p>Solte para importar</p>
        <small>.package · .ts4script · .zip · .rar · .7z · Tray</small>
      </div>
    </div>

    <!-- ── Content ────────────────────────────────────────────────── -->
    ${isGrid ? renderGallery(mods) : renderTable(mods)}

    <!-- ── Pagination ─────────────────────────────────────────────── -->
    ${totalPages > 1 ? renderPagination(state.galleryPage, totalPages, allGrouped.length) : ''}

    <!-- ── Floating selection bar ─────────────────────────────────── -->
    <div class="sel-bar ${selCount > 0 ? 'sel-bar-show' : ''}" id="sel-bar">
      <span class="sel-bar-count" id="sel-bar-count">
        ${selCount} selecionado${selCount !== 1 ? 's' : ''}
      </span>
      <div class="sel-bar-sep"></div>
      <div class="sel-bar-actions">
        <button class="btn btn-sm btn-secondary" id="btn-enable-all-sel">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg>
          Ativar
        </button>
        <button class="btn btn-sm btn-secondary" id="btn-disable-all-sel">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Desativar
        </button>
        <button class="btn btn-sm btn-danger" id="btn-delete-sel">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
          </svg>
          Deletar
        </button>
        <button class="sel-bar-close" id="btn-deselect" title="Cancelar seleção">✕</button>
      </div>
    </div>
  `;

  isGrid ? setupGalleryEvents(el, mods) : setupModsEvents(el, mods);
}

function renderTable(mods) {
  if (mods.length === 0) return `
    <div class="table-container">
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/>
          <path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
        </svg>
        <h3>Nenhum mod encontrado</h3>
        <p>Tente ajustar os filtros ou importe seus primeiros mods</p>
      </div>
    </div>`;

  return `
    <div class="table-container" id="mods-table-container">
      <table id="mods-table">
        <thead>
          <tr>
            <th style="width:40px;text-overflow:clip"><div style="display:flex;align-items:center;justify-content:center;padding:10px 6px"><input type="checkbox" class="checkbox" id="select-all"></div></th>
            ${renderTh('name', 'Nome')}
            ${renderTh('type', 'Tipo', '110px')}
            ${renderTh('size', 'Tamanho', '90px')}
            ${renderTh('folder', 'Pasta', '140px')}
            ${renderTh('enabled', 'Status', '100px')}
            <th style="width:90px"><div class="th-content">Ações</div></th>
          </tr>
        </thead>
        <tbody>
          ${mods.map(mod => renderModRow(mod)).join('')}
        </tbody>
      </table>
    </div>`;
}


// ─── Tray Grouping ───────────────────────────────────────────────────────────

/**
 * Groups tray files by their GUID (the hex ID after "!" in the filename).
 * Files without a GUID, or non-tray files, are returned as-is.
 * Returns a mixed array of individual mod objects and tray group objects.
 */
function groupTrayFiles(mods) {
  const groups = new Map();   // guid → [mod, ...]
  const result = [];

  for (const mod of mods) {
    if (mod.type === 'tray' && mod.trayGuid) {
      if (!groups.has(mod.trayGuid)) groups.set(mod.trayGuid, []);
      groups.get(mod.trayGuid).push(mod);
    } else {
      result.push(mod);
    }
  }

  for (const [guid, files] of groups) {
    // Single file with a GUID — show as individual item, not a group
    if (files.length === 1) { result.push(files[0]); continue; }

    // Use the .trayitem file as the representative for name/thumbnail
    const primary = files.find(f => f.name.toLowerCase().endsWith('.trayitem'))
                 || files.find(f => f.name.toLowerCase().endsWith('.blueprint'))
                 || files[0];

    const totalSize = files.reduce((s, f) => s + f.size, 0);
    const allEnabled = files.every(f => f.enabled);
    const anyEnabled = files.some(f => f.enabled);

    result.push({
      _isTrayGroup: true,
      trayGuid: guid,
      files,
      // Use primary file for display
      path: primary.path,
      name: primary.name,
      size: totalSize,
      enabled: allEnabled,
      anyEnabled,
      type: 'tray',
      folder: primary.folder,
      lastModified: primary.lastModified,
    });
  }

  return result;
}


// ─── Mod Prefix Grouping ─────────────────────────────────────────────────────

/**
 * Extracts the prefix from a mod filename.
 * Priority 1: [Author Name] bracket prefix — groups files from the same creator
 *   even when filenames use spaces instead of underscores.
 * Priority 2: everything before the first "_" (original behaviour).
 * Returns null if no recognisable prefix or the prefix is too short (< 2 chars).
 */
function getModPrefix(name) {
  const base = name.replace(/\.(disabled)$/i, '').replace(/\.[^.]+$/, '');

  // [Author] or [Author Name] at the start of the filename
  const bracketMatch = base.match(/^\[([^\]]{2,})\]/i);
  if (bracketMatch) return bracketMatch[1].toLowerCase().trim();

  // Fallback: underscore-based prefix
  const idx = base.indexOf('_');
  if (idx < 2) return null;
  return base.slice(0, idx).toLowerCase();
}

/**
 * Groups mods (package + script) with the same filename prefix into a single
 * card. Only creates a group when 2+ files share the same prefix.
 * Tray files are not affected (already grouped by GUID).
 */
function groupModsByPrefix(mods) {
  const prefixMap = new Map(); // prefix → [mod, ...]
  const noPrefix  = [];

  for (const mod of mods) {
    if (mod._isTrayGroup || mod.type === 'tray') { noPrefix.push(mod); continue; }
    const prefix = getModPrefix(mod.name);
    if (!prefix) { noPrefix.push(mod); continue; }
    if (!prefixMap.has(prefix)) prefixMap.set(prefix, []);
    prefixMap.get(prefix).push(mod);
  }

  const result = [...noPrefix];

  for (const [prefix, files] of prefixMap) {
    if (files.length === 1) { result.push(files[0]); continue; } // solo — show normally

    // Use .package as primary if available, else first file
    const primary = files.find(f => f.type === 'package') || files[0];
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    const allEnabled = files.every(f => f.enabled);
    const hasPackage = files.some(f => f.type === 'package');
    const hasScript  = files.some(f => f.type === 'script');
    // Icon/tag reflects what's actually in the group:
    // mixed → package takes precedence visually; script-only → script icon
    const groupType = hasPackage ? 'package' : 'script';

    result.push({
      _isModGroup: true,
      modPrefix: prefix,
      files,
      path: primary.path,
      name: primary.name,
      size: totalSize,
      enabled: allEnabled,
      type: groupType,
      folder: primary.folder,
      lastModified: primary.lastModified,
    });
  }

  return result;
}

function renderGallery(mods) {
  if (mods.length === 0) return `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
        <path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
      </svg>
      <h3>Nenhum mod encontrado</h3>
      <p>Tente ajustar os filtros ou importe seus primeiros mods</p>
    </div>`;

  const cols = [
    { key: 'name',    label: 'Nome'     },
    { key: 'type',    label: 'Tipo'     },
    { key: 'size',    label: 'Tamanho'  },
    { key: 'enabled', label: 'Status'   },
  ];

  const sortBarHtml = `
    <div class="gallery-sort-bar" id="gallery-sort-bar">
      <span class="gallery-sort-label">Ordenar:</span>
      ${cols.map(c => {
        const isActive = state.sortColumn === c.key;
        const arrow = isActive ? (state.sortDir === 'asc' ? '↑' : '↓') : '';
        return `<button class="gallery-sort-btn ${isActive ? 'active' : ''}" data-col="${c.key}">
          ${c.label}${arrow ? `<span class="gallery-sort-arrow" style="font-size:15px;font-weight:700">${arrow}</span>` : ''}
        </button>`;
      }).join('')}
    </div>`;

  return `${sortBarHtml}<div class="gallery-grid" id="gallery-grid">
    ${mods.map(mod => {
      if (mod._isTrayGroup) return renderTrayGroupCard(mod);
      if (mod._isModGroup)  return renderModGroupCard(mod);

      const sel = state.selectedMods.has(mod.path);
      const cached = state.thumbnailCache[thumbKey(mod.path)];
      const canHaveThumb = mod.type === 'package' || mod.type === 'tray';
      const thumbHtml = (cached && cached !== THUMB_LOADING)
        ? `<img class="gallery-thumb" src="${cached}" alt="" loading="lazy">`
        : (cached === null || !canHaveThumb)
          ? `<div class="gallery-thumb-placeholder">${fileIcon(mod.type)}</div>`
          : `<div class="gallery-thumb-loading" data-load="${escapeHtml(mod.path)}" data-cache-key="${escapeHtml(thumbKey(mod.path))}"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div></div>`;

      const typeLabel = mod.type === 'package' ? '.pkg' : mod.type === 'script' ? '.ts4' : 'tray';
      const typeClass = mod.type === 'package' ? 'card-tag-pkg' : mod.type === 'script' ? 'card-tag-scr' : 'card-tag-tray';

      return `
        <div class="gallery-card ${sel ? 'selected' : ''} ${!mod.enabled ? 'card-inactive' : ''}"
             data-path="${escapeHtml(mod.path)}" draggable="false"
             title="Clique para selecionar · Clique direito para opções">
          <input type="checkbox" class="card-check" data-path="${escapeHtml(mod.path)}" ${sel ? 'checked' : ''}>
          <span class="card-type-tag ${typeClass}">${typeLabel}</span>
          ${thumbHtml}
          <div class="gallery-info">
            <div class="gallery-name" title="${escapeHtml(mod.name)}">${escapeHtml(mod.name)}</div>
            <div class="gallery-meta">
              <span>${formatBytes(mod.size)}</span>
              <span class="gallery-status-dot ${mod.enabled ? 'dot-active' : 'dot-inactive'} dot-clickable"
                    data-path="${escapeHtml(mod.path)}"
                    data-tooltip="${mod.enabled ? 'Mod ativo — clique para desativar' : 'Mod inativo — clique para ativar'}"></span>
            </div>
          </div>
        </div>`;
    }).join('')}
  </div>`;
}

/**
 * Retorna o número REAL de arquivos no grupo consultando state.mods/trayFiles
 * sem filtros aplicados. Isso evita que o contador mude quando o tipo ou status
 * está filtrado (ex: filtro "package" excludes scripts do grupo).
 */
function getTrueGroupCount(group) {
  const allMods = [...state.mods, ...state.trayFiles];
  if (group._isTrayGroup) {
    return allMods.filter(m => m.type === 'tray' && m.trayGuid === group.trayGuid).length;
  }
  if (group._isModGroup) {
    return allMods.filter(m => {
      if (m.type === 'tray') return false;
      return getModPrefix(m.name) === group.modPrefix;
    }).length;
  }
  return group.files.length;
}

function renderGroupCard(group, groupKey, typeTag, typeClass, badgeClass, placeholderIcon, displayName) {
  const allPaths = group.files.map(f => f.path);
  const allSel = allPaths.every(p => state.selectedMods.has(p));

  // ── Mosaico de miniaturas do grupo ──────────────────────────────────
  const canHaveThumb = group.type === 'package' || group.type === 'tray';
  let thumbHtml;
  if (canHaveThumb) {
    // Coleta miniaturas já carregadas dos arquivos do grupo
    const readyThumbs = group.files
      .map(f => state.thumbnailCache[thumbKey(f.path)])
      .filter(c => c && c !== THUMB_LOADING);

    // Arquivos ainda aguardando carregamento
    const loadingFiles = group.files.filter(f => {
      const c = state.thumbnailCache[thumbKey(f.path)];
      return c === THUMB_LOADING || c === undefined;
    });

    if (readyThumbs.length >= 2) {
      // Mosaico: máx 9 imagens em grade 3×3
      const slots = readyThumbs.slice(0, 9);
      const cols  = slots.length <= 2 ? slots.length : slots.length <= 4 ? 2 : 3;
      const rows  = Math.ceil(slots.length / cols);
      const imgs  = slots.map(src =>
        `<img src="${src}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`
      ).join('');
      thumbHtml = `
        <div class="gallery-thumb group-thumb-mosaic"
             style="display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);gap:1px;background:#000;">
          ${imgs}
        </div>`;
    } else if (readyThumbs.length === 1) {
      thumbHtml = `<img class="gallery-thumb" src="${readyThumbs[0]}" alt="" loading="lazy">`;
    } else if (loadingFiles.length > 0) {
      // Ainda carregando — mostra spinner usando o primeiro arquivo do grupo
      const firstLoading = loadingFiles[0];
      thumbHtml = `<div class="gallery-thumb-loading" data-load="${escapeHtml(firstLoading.path)}" data-cache-key="${escapeHtml(thumbKey(firstLoading.path))}"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div></div>`;
    } else {
      thumbHtml = `<div class="gallery-thumb-placeholder">${placeholderIcon}</div>`;
    }
  } else {
    thumbHtml = `<div class="gallery-thumb-placeholder">${placeholderIcon}</div>`;
  }

  const idAttr = group._isTrayGroup ? 'data-tray-guid' : 'data-mod-prefix';
  const idVal  = group._isTrayGroup ? group.trayGuid   : group.modPrefix;
  const checkClass = group._isTrayGroup ? 'card-check-group' : 'card-check-mod-group';
  const cardClass  = group._isTrayGroup ? 'tray-group' : 'mod-group';
  const allEnabled  = group.files.every(f => f.enabled);
  const someEnabled = !allEnabled && group.files.some(f => f.enabled);
  const noneEnabled = !allEnabled && !someEnabled;
  const toggleLabel = allEnabled ? '⏸' : '▶';
  const toggleTitle = allEnabled ? 'Desativar grupo' : 'Ativar grupo';
  const statusDotClass = allEnabled ? 'dot-active' : someEnabled ? 'dot-partial' : 'dot-inactive';

  // Build children grid: one child-card per file in the group
  const childrenHtml = group.files.map(f => {
    const fCached = state.thumbnailCache[thumbKey(f.path)];
    const fCanThumb = f.type === 'package' || f.type === 'tray' || (!f.type && /\.(package|trayitem|blueprint|bpi)$/i.test(f.name));
    const fThumb = (fCached && fCached !== THUMB_LOADING)
      ? `<img class="gallery-thumb" src="${fCached}" alt="" loading="lazy">`
      : (fCached === null || !fCanThumb)
        ? `<div class="gallery-thumb-placeholder">${fileIcon(f.type || 'package')}</div>`
        : `<div class="gallery-thumb-loading" data-load="${escapeHtml(f.path)}" data-cache-key="${escapeHtml(thumbKey(f.path))}"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div></div>`;
    const fEnabled = f.enabled !== false;
    return `
      <div class="gallery-card child-card ${!fEnabled ? 'card-inactive' : ''}" data-path="${escapeHtml(f.path)}" draggable="false"
           title="${escapeHtml(f.name)}">
        ${fThumb}
        <div class="gallery-info">
          <div class="gallery-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
          <div class="gallery-meta">
            <span>${formatBytes(f.size || 0)}</span>
            <span class="gallery-status-dot ${fEnabled ? 'dot-active' : 'dot-inactive'} dot-clickable"
                  data-path="${escapeHtml(f.path)}"
                  data-tooltip="${fEnabled ? 'Mod ativo — clique para desativar' : 'Mod inativo — clique para ativar'}"></span>
          </div>
        </div>
      </div>`;
  }).join('');

  const groupFilePaths = JSON.stringify(group.files.map(f => f.path));
  const trueCount = getTrueGroupCount(group);
  const countLabel = trueCount > group.files.length
    ? `${group.files.length}/${trueCount}` // filtro ativo: mostra visíveis/total
    : String(trueCount);
  return `
    <div class="group-card-wrapper ${state.expandedGroups.has(groupKey) ? 'is-expanded' : ''}" ${idAttr}="${escapeHtml(idVal)}">
      <div class="gallery-card ${cardClass} ${noneEnabled ? 'card-inactive' : ''}" ${idAttr}="${escapeHtml(idVal)}"
           draggable="false"
           data-group-files="${escapeHtml(groupFilePaths)}"
           title="Clique para selecionar · Clique direito para gerenciar os ${trueCount} itens do grupo">
        <input type="checkbox" class="card-check ${checkClass}" ${idAttr}="${escapeHtml(idVal)}" ${allSel ? 'checked' : ''}>
        <span class="card-type-tag ${typeClass}">${typeTag}</span>
        <span class="${badgeClass}" title="${trueCount} arquivo${trueCount !== 1 ? 's' : ''}">${countLabel}</span>
        ${thumbHtml}
        <div class="gallery-info">
          <div class="gallery-name" title="${escapeHtml(group.name)}">${escapeHtml(displayName)}</div>
          <div class="gallery-meta">
            <span>${formatBytes(group.size)}</span>
            <div class="gallery-meta-actions">
              <button class="group-expand-btn" ${idAttr}="${escapeHtml(idVal)}"
                      data-tooltip="${state.expandedGroups.has(groupKey) ? 'Fechar' : 'Ver arquivos do grupo'}">${state.expandedGroups.has(groupKey) ? '▴' : '▾'}</button>
              <span class="gallery-status-dot ${statusDotClass} dot-clickable dot-clickable-group"
                    ${idAttr}="${escapeHtml(idVal)}"
                    data-tooltip="${allEnabled ? 'Todos ativos — clique para desativar o grupo' : someEnabled ? 'Parcialmente ativo — clique para ativar todos' : 'Todos inativos — clique para ativar o grupo'}"></span>
            </div>
          </div>
        </div>
      </div>
      <div class="group-children-grid" style="${state.expandedGroups.has(groupKey) ? '' : 'display:none'}">${childrenHtml}</div>
    </div>`;
}

function renderTrayGroupCard(group) {
  const displayName = group.name.replace(/^[0-9a-fx]+![0-9a-fx]+\./i, '').replace(/\.trayitem$/i, '') || group.name;
  return renderGroupCard(group, 'tray:' + group.trayGuid, 'tray', 'card-tag-tray', 'tray-group-badge', '🏠', displayName);
}

function renderPagination(current, total, itemCount) {
  const pages = [];
  const delta = 2;
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || (i >= current - delta && i <= current + delta)) {
      pages.push(i);
    }
  }

  let html = '<div class="pagination">';
  html += `<button class="page-btn" id="page-prev" ${current === 1 ? 'disabled' : ''}>‹</button>`;

  let prev = null;
  for (const p of pages) {
    if (prev && p - prev > 1) html += `<span class="pagination-info">…</span>`;
    html += `<button class="page-btn ${p === current ? 'active' : ''}" data-page="${p}">${p}</button>`;
    prev = p;
  }

  html += `<button class="page-btn" id="page-next" ${current === total ? 'disabled' : ''}>›</button>`;
  html += `<span class="pagination-info">${itemCount} itens</span>`;
  html += '</div>';
  return html;
}

// ─── Handlers comuns a grade E lista ─────────────────────────────────────────
function setupCommonModsEvents(el) {
  // View toggle
  el.querySelector('#view-list')?.addEventListener('click', () => { state.viewMode = 'list'; state.galleryPage = 1; renderMods(); });
  el.querySelector('#view-grid')?.addEventListener('click', () => { state.viewMode = 'grid'; state.galleryPage = 1; renderMods(); });

  // Import & refresh
  el.querySelector('#btn-import')?.addEventListener('click', importFiles);
  el.querySelector('#btn-refresh-mods')?.addEventListener('click', async () => { await loadMods(); renderMods(); toast('Lista atualizada', 'info', 1500); });


  // Search input
  el.querySelector('#search-input')?.addEventListener('input', e => {
    state.searchQuery = e.target.value;
    const pos = e.target.selectionStart;
    state.galleryPage = 1;
    renderMods();
    const ni = document.getElementById('search-input');
    if (ni) { ni.focus(); ni.setSelectionRange(pos, pos); }
  });
  el.querySelector('#search-clear')?.addEventListener('click', () => {
    state.searchQuery = ''; state.galleryPage = 1; renderMods();
    document.getElementById('search-input')?.focus();
  });

  // Status chips
  el.querySelectorAll('[data-fs]').forEach(btn => {
    btn.addEventListener('click', () => { state.filterStatus = btn.dataset.fs; state.galleryPage = 1; renderMods(); });
  });

  // Type chips
  el.querySelectorAll('[data-ft]').forEach(btn => {
    btn.addEventListener('click', () => { state.filterType = btn.dataset.ft; state.galleryPage = 1; renderMods(); });
  });

  // Folder select
  el.querySelector('#filter-folder')?.addEventListener('change', e => { state.filterFolder = e.target.value; state.galleryPage = 1; renderMods(); });

  // Clear all filters
  el.querySelector('#clear-filters')?.addEventListener('click', () => {
    state.searchQuery = ''; state.filterStatus = 'all'; state.filterType = 'all';
    state.filterFolder = 'all'; state.galleryPage = 1; renderMods();
  });

  // Items per page (both list and grid modes)
  el.querySelector('#items-per-page')?.addEventListener('change', e => {
    const val = e.target.value;
    state.itemsPerPage = val === 'Infinity' ? Infinity : parseInt(val);
    state.galleryPage = 1; renderMods();
  });

  // Pagination
  el.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => { state.galleryPage = parseInt(btn.dataset.page); renderMods(); });
  });
  el.querySelector('#page-prev')?.addEventListener('click', () => { if (state.galleryPage > 1) { state.galleryPage--; renderMods(); } });
  el.querySelector('#page-next')?.addEventListener('click', () => { state.galleryPage++; renderMods(); });

  // Drag-and-drop overlay — attached only once per page element lifetime
  // (el.innerHTML changes on each renderMods but el itself persists in the DOM,
  //  so addEventListener without a guard would accumulate duplicate handlers)
  const dz = el.querySelector('#drop-zone');
  if (dz && !el._eventsAttached) {
    el._eventsAttached = true;

    let dragDepth = 0;
    el.addEventListener('dragenter', e => {
      e.preventDefault();
      // Only show overlay for external file drags from the OS, not internal card drags
      if (!e.dataTransfer.types.includes('Files')) return;
      if (++dragDepth === 1) dz.classList.add('drop-overlay-show');
    });
    el.addEventListener('dragleave', e => {
      // Only hide when leaving el itself (not a child element)
      if (!el.contains(e.relatedTarget)) {
        dragDepth = 0;
        dz.classList.remove('drop-overlay-show');
      }
    });
    el.addEventListener('dragover', e => e.preventDefault());
    el.addEventListener('drop', async e => {
      e.preventDefault();
      dragDepth = 0;
      // Re-query dz each time so we always get the live node after re-renders
      el.querySelector('#drop-zone')?.classList.remove('drop-overlay-show');
      // Ignore internal DOM drags (card rearranging etc.)
      if (!e.dataTransfer.types.includes('Files')) return;

      let paths = [];

      // Check if any dropped item is a directory — if so, always use the FileSystem
      // API path so that folders are recursively expanded into their file contents.
      // The directFiles path cannot handle folders: the folder itself arrives as a
      // File object with no extension, hits the unsupported-format filter in doImport
      // and is silently skipped instead of being walked.
      const items = [...(e.dataTransfer.items || [])];
      const hasDirectory = items.some(item => item.webkitGetAsEntry?.()?.isDirectory);

      if (!hasDirectory) {
        // Fast path: all items are plain files — map directly to filesystem paths
        const directFiles = [...(e.dataTransfer.files || [])];
        if (directFiles.length > 0) {
          paths = directFiles.map(f => window.api.getPathForFile(f)).filter(Boolean);
        }
      }

      // Folder path (or fallback): use FileSystem API to recurse into dropped folders
      if (!paths.length && items.length > 0) {
        const allFiles = await collectDroppedFiles(e.dataTransfer.items);
        paths = allFiles.map(f => window.api.getPathForFile(f)).filter(Boolean);
      }

      if (paths.length) await doImport(paths);
    });
  }

  // Sel-bar deselect
  el.querySelector('#btn-deselect')?.addEventListener('click', () => {
    state.selectedMods.clear();
    el.querySelectorAll('.card-check, .row-check').forEach(c => {
      c.checked = false;
      c.closest('.gallery-card, tr')?.classList.remove('selected');
    });
    refreshSelBar(el);
  });

  // Batch enable
  el.querySelector('#btn-enable-all-sel')?.addEventListener('click', async () => {
    const sel = [...state.selectedMods];
    if (!sel.length) { toast('Selecione ao menos um mod', 'warning'); return; }
    const targets = sel.filter(p => { const m = [...state.mods, ...state.trayFiles].find(m => m.path === p); return m && !m.enabled; });
    if (!targets.length) { toast('Nenhum mod inativo selecionado', 'warning'); return; }
    // Desabilita todos os botões da sel-bar durante a operação para evitar condição de corrida
    el.querySelectorAll('.sel-bar button').forEach(b => { b.disabled = true; });
    try {
      const results = [];
      for (const p of targets) results.push(await window.api.toggleMod(p));
      await loadMods(); state.selectedMods.clear(); renderMods();
      toast(`${targets.length} mod(s) ativados`, 'success');
      // Use newPath returned by each toggleMod so undo operates on the renamed file
      const newPaths = results.filter(r => r.success).map(r => r.newPath);
      pushUndo(`Ativar ${newPaths.length} mod(s)`, async () => {
        for (const p of newPaths) await window.api.toggleMod(p);
        await loadMods(); renderMods();
        logAction('restore', { count: newPaths.length, label: `Desfazer ativação em lote` });
      }, 'toggle_on', { count: newPaths.length, source: 'batch' });
    } catch (e) { toast('Erro ao ativar mods: ' + e.message, 'error'); }
  });

  // Batch disable
  el.querySelector('#btn-disable-all-sel')?.addEventListener('click', async () => {
    const sel = [...state.selectedMods];
    if (!sel.length) { toast('Selecione ao menos um mod', 'warning'); return; }
    const targets = sel.filter(p => { const m = [...state.mods, ...state.trayFiles].find(m => m.path === p); return m && m.enabled; });
    if (!targets.length) { toast('Nenhum mod ativo selecionado', 'warning'); return; }
    // Desabilita todos os botões da sel-bar durante a operação para evitar condição de corrida
    el.querySelectorAll('.sel-bar button').forEach(b => { b.disabled = true; });
    try {
      const results = [];
      for (const p of targets) results.push(await window.api.toggleMod(p));
      await loadMods(); state.selectedMods.clear(); renderMods();
      toast(`${targets.length} mod(s) desativados`, 'success');
      // Use newPath returned by each toggleMod so undo operates on the renamed file
      const newPaths = results.filter(r => r.success).map(r => r.newPath);
      pushUndo(`Desativar ${newPaths.length} mod(s)`, async () => {
        for (const p of newPaths) await window.api.toggleMod(p);
        await loadMods(); renderMods();
        logAction('restore', { count: newPaths.length, label: `Desfazer desativação em lote` });
      }, 'toggle_off', { count: newPaths.length, source: 'batch' });
    } catch (e) { toast('Erro ao desativar mods: ' + e.message, 'error'); }
  });

  // Batch delete
  el.querySelector('#btn-delete-sel')?.addEventListener('click', () => {
    const sel = [...state.selectedMods];
    if (!sel.length) { toast('Selecione ao menos um mod', 'warning'); return; }
    openModal('Confirmar Exclusão em Lote',
      `<p>Tem certeza que deseja mover <strong>${sel.length}</strong> mod(s) selecionado(s) para a lixeira?</p>`,
      [
        { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
        { label: `Mover ${sel.length} para lixeira`, cls: 'btn-danger', action: async () => {
          const results = await window.api.trashModsBatch(sel);
          const failed = results.filter(r => !r.success).length;
          const deleted = results.length - failed;
          await loadMods(); state.selectedMods.clear(); renderMods();
          updateTrashBadge();
          toast(`${deleted} mod(s) movidos para a lixeira${failed ? `, ${failed} com erro` : ''}`, failed ? 'warning' : 'success');
          if (deleted > 0) {
            const trashed = results.filter(r => r.success);
            pushUndo(`Excluir ${deleted} mod(s)`, async () => {
              for (const r of trashed) await window.api.restoreModFromTrash(r.trashPath, r.originalPath);
              await loadMods(); renderMods();
              toast(`${trashed.length} mod(s) restaurados`, 'success');
              logAction('restore', { count: trashed.length, source: 'batch', label: 'Restaurar exclusão em lote' });
            }, 'delete', { count: deleted, source: 'batch', trashPaths: trashed.map(r => r.trashPath) });
          }
        }}
      ]
    );
  });
}

function refreshSelBar(el) {
  const bar = el.querySelector('#sel-bar');
  if (!bar) return;
  if (state.selectedMods.size === 0) {
    bar.classList.remove('sel-bar-show');
    return;
  }

  // Conta itens visuais: cada grupo (tray ou mod) selecionado conta como 1
  const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
  let visualCount = 0;
  const accounted = new Set();

  for (const item of allGrouped) {
    if (item._isTrayGroup || item._isModGroup) {
      const filePaths = item.files.map(f => f.path);
      if (filePaths.some(p => state.selectedMods.has(p))) {
        visualCount++;
        filePaths.forEach(p => accounted.add(p));
      }
    } else if (state.selectedMods.has(item.path)) {
      visualCount++;
      accounted.add(item.path);
    }
  }
  // Itens selecionados não cobertos pelo agrupamento (edge case)
  for (const p of state.selectedMods) {
    if (!accounted.has(p)) visualCount++;
  }

  bar.classList.add('sel-bar-show');
  const cEl = bar.querySelector('#sel-bar-count');
  if (cEl) cEl.textContent = `${visualCount} selecionado${visualCount !== 1 ? 's' : ''}`;
}

// ─── Group Overlay ────────────────────────────────────────────────────────────

/**
 * Opens a modal overlay showing all files inside a group (tray or mod-prefix).
 * Allows toggling individual files, and consolidating them to one folder when needed.
 */
function showGroupCtxMenu(x, y, group) {
  closeCtxMenu();

  const svgList = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
  const svgGrid = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`;

  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  menu.innerHTML = `
    <div class="ctx-item" id="ctx-group-list">${svgList} Ver arquivos do grupo</div>
    <div class="ctx-item" id="ctx-group-grid">${svgGrid} Ver em modo grade</div>`;

  document.body.appendChild(menu);
  _ctxMenu = menu;

  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const ww = window.innerWidth,  wh = window.innerHeight;
  menu.style.left = (x + mw > ww ? ww - mw - 6 : x) + 'px';
  menu.style.top  = (y + mh > wh ? wh - mh - 6 : y) + 'px';

  menu.querySelector('#ctx-group-list').addEventListener('click', () => {
    closeCtxMenu();
    openGroupOverlay(group);
  });
  menu.querySelector('#ctx-group-grid').addEventListener('click', () => {
    closeCtxMenu();
    openGroupGridOverlay(group);
  });
}

function openGroupGridOverlay(group) {
  const isTray = group._isTrayGroup;
  const displayTitle = isTray
    ? (group.name.replace(/^[0-9a-fx]+![0-9a-fx]+\./i, '').replace(/\.trayitem$/i, '') || group.name)
    : (group.modPrefix || group.name);

  const cardsHtml = group.files.map(f => {
    const fCached = state.thumbnailCache[thumbKey(f.path)];
    const fCanThumb = f.type === 'package' || f.type === 'tray' || (!f.type && /\.(package|trayitem|blueprint|bpi)$/i.test(f.name));
    const fThumb = (fCached && fCached !== THUMB_LOADING)
      ? `<img class="gallery-thumb" src="${fCached}" alt="" loading="lazy">`
      : (fCached === null || !fCanThumb)
        ? `<div class="gallery-thumb-placeholder">${fileIcon(f.type || 'package')}</div>`
        : `<div class="gallery-thumb-loading" data-load="${escapeHtml(f.path)}" data-cache-key="${escapeHtml(thumbKey(f.path))}"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div></div>`;
    const fTypeLabel = f.type === 'package' ? '.pkg' : f.type === 'script' ? '.ts4' : 'tray';
    const fTypeClass = f.type === 'package' ? 'card-tag-pkg' : f.type === 'script' ? 'card-tag-scr' : 'card-tag-tray';
    const fEnabled = f.enabled !== false;
    return `
      <div class="gallery-card child-card group-grid-card ${!fEnabled ? 'card-inactive' : ''}" data-path="${escapeHtml(f.path)}">
        <span class="card-type-tag ${fTypeClass}">${fTypeLabel}</span>
        ${fThumb}
        <div class="gallery-info">
          <div class="gallery-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
          <div class="gallery-meta">
            <span>${formatBytes(f.size || 0)}</span>
            <span class="gallery-status-dot ${fEnabled ? 'dot-active' : 'dot-inactive'} dot-clickable"
                  data-path="${escapeHtml(f.path)}"
                  data-tooltip="${fEnabled ? 'Mod ativo — clique para desativar' : 'Mod inativo — clique para ativar'}"></span>
          </div>
        </div>
      </div>`;
  }).join('');

  const bodyHtml = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;max-height:480px;overflow-y:auto;padding:2px">
      ${cardsHtml}
    </div>`;

  openModal(`Grupo: ${displayTitle} (${group.files.length} arquivos)`, bodyHtml, [
    { label: 'Fechar', cls: 'btn-secondary', action: () => {} }
  ]);

  // Dot toggle dentro do modal
  document.querySelectorAll('.group-grid-card .dot-clickable').forEach(dot => {
    dot.addEventListener('click', async e => {
      e.stopPropagation();
      const card = dot.closest('.group-grid-card');
      const fp = card?.dataset.path;
      if (!fp) return;
      const result = await window.api.toggleMod(fp);
      if (result.success) {
        card.dataset.path = result.newPath;
        dot.dataset.path  = result.newPath;
        await loadMods();
        const f = [...state.mods, ...state.trayFiles].find(m => m.path === result.newPath);
        if (f) {
          dot.className = `gallery-status-dot ${f.enabled ? 'dot-active' : 'dot-inactive'} dot-clickable`;
          dot.dataset.tooltip = f.enabled ? 'Mod ativo — clique para desativar' : 'Mod inativo — clique para ativar';
          card.classList.toggle('card-inactive', !f.enabled);
        }
        renderMods();
      } else { toast('Erro ao alternar mod', 'error'); }
    });
  });

  // Contexto individual nos cards da grade do modal
  document.querySelectorAll('.group-grid-card').forEach(card => {
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, card.dataset.path, {
        onDelete: async (filePath) => {
          const allMods = [...state.mods, ...state.trayFiles];
          const f = allMods.find(m => m.path === filePath);
          const name = f?.name || filePath.split(/[\/]/).pop();
          openModal('Confirmar Exclusão',
            `<p>Mover <strong>${escapeHtml(name)}</strong> para a lixeira?</p>`,
            [
              { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
              { label: 'Mover para lixeira', cls: 'btn-danger', action: async () => {
                const results = await window.api.trashModsBatch([filePath]);
                if (results[0]?.success) {
                  closeModal();
                  await loadMods(); renderMods();
                  updateTrashBadge();
                  toast(`"${name}" movido para a lixeira`, 'success');
                } else toast('Erro ao excluir: ' + (results[0]?.error || ''), 'error');
              }}
            ]
          );
        }
      });
    });
  });
}

function openGroupOverlay(group) {
  // Bug fix: remove the mousedown listener left by a previous openGroupOverlay call.
  // Without this, each reopening stacks another listener on modal-body, corrupting rubber band.
  if (_cleanupModalRubberBand) { _cleanupModalRubberBand(); _cleanupModalRubberBand = null; }
  // Reset ghost-click flag so the first drag in the new modal session works correctly.
  _rubberBand.didSelect = false;
  // Auto-detectar: se algum arquivo já tem miniatura carregada → grade, senão → lista
  const hasThumbs = group.files.some(f => {
    const c = state.thumbnailCache[thumbKey(f.path)];
    return c && c !== THUMB_LOADING;
  });
  const initialView = hasThumbs ? 'grid' : 'list';

  const isTray = group._isTrayGroup;
  const displayTitle = isTray
    ? (group.name.replace(/^[0-9a-fx]+![0-9a-fx]+\./i, '').replace(/\.trayitem$/i, '') || group.name)
    : (group.modPrefix || group.name);

  const folders = [...new Set(group.files.map(f => f.folder))];
  const multiFolder = folders.length > 1;
  const primaryFolder = group.files[0].folder;
  const canConsolidate = multiFolder && group.files.every(f => {
    if (f.type === 'script') return primaryFolder === '/' || (primaryFolder.split(/[/\\]/).length <= 1);
    return true;
  });

  function buildListHtml() {
    return group.files.map(f => {
      const fTypeLabel = f.type === 'package' ? '.pkg' : f.type === 'script' ? '.ts4' : 'tray';
      const fTypeClass = f.type === 'package' ? 'card-tag-pkg' : f.type === 'script' ? 'card-tag-scr' : 'card-tag-tray';
      return `
        <div class="group-overlay-row" data-path="${escapeHtml(f.path)}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:var(--r-sm);background:var(--surface-2);margin-bottom:6px;cursor:pointer">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary)">${escapeHtml(f.name)}</div>
            <div style="font-size:11px;color:var(--text-disabled);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(f.folder === '/' ? '(raiz)' : f.folder)}</div>
          </div>
          <span style="font-size:11.5px;color:var(--text-secondary);flex-shrink:0">${formatBytes(f.size)}</span>
          <span class="${fTypeClass}" style="flex-shrink:0;font-size:9.5px;font-weight:700;padding:2px 5px;border-radius:3px">${fTypeLabel}</span>
          <span class="badge ${f.enabled ? 'badge-active' : 'badge-inactive'}" style="flex-shrink:0">${f.enabled ? 'Ativo' : 'Inativo'}</span>
        </div>`;
    }).join('');
  }

  function buildGridHtml() {
    return group.files.map(f => {
      const fCached = state.thumbnailCache[thumbKey(f.path)];
      const fCanThumb = f.type === 'package' || f.type === 'tray' || (!f.type && /\.(package|trayitem|blueprint|bpi)$/i.test(f.name));
      const fThumb = (fCached && fCached !== THUMB_LOADING)
        ? `<img class="gallery-thumb" src="${fCached}" alt="" loading="lazy">`
        : (fCached === null || !fCanThumb)
          ? `<div class="gallery-thumb-placeholder">${fileIcon(f.type || 'package')}</div>`
          : `<div class="gallery-thumb-loading" data-load="${escapeHtml(f.path)}" data-cache-key="${escapeHtml(thumbKey(f.path))}"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div></div>`;
      const fTypeLabel = f.type === 'package' ? '.pkg' : f.type === 'script' ? '.ts4' : 'tray';
      const fTypeClass = f.type === 'package' ? 'card-tag-pkg' : f.type === 'script' ? 'card-tag-scr' : 'card-tag-tray';
      const fEnabled = f.enabled !== false;
      return `
        <div class="gallery-card child-card group-overlay-grid-card ${!fEnabled ? 'card-inactive' : ''}" data-path="${escapeHtml(f.path)}">
          <span class="card-type-tag ${fTypeClass}">${fTypeLabel}</span>
          ${fThumb}
          <div class="gallery-info">
            <div class="gallery-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
            <div class="gallery-meta">
              <span>${formatBytes(f.size || 0)}</span>
              <span class="gallery-status-dot ${fEnabled ? 'dot-active' : 'dot-inactive'} dot-clickable"
                    data-path="${escapeHtml(f.path)}"
                    data-tooltip="${fEnabled ? 'Mod ativo — clique para desativar' : 'Mod inativo — clique para ativar'}"></span>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  const svgList = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
  const svgGrid = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`;

  const bodyHtml = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      ${multiFolder && !canConsolidate ? `<div style="font-size:12px;color:var(--text-disabled)">ℹ️ Arquivos em pastas diferentes</div>` : '<div></div>'}
      <div style="display:flex;align-items:center;gap:8px">
        <span id="group-overlay-sel-count" style="display:none;font-size:11.5px;color:var(--text-accent);font-weight:600"></span>
        <div class="view-toggle" id="group-overlay-view-toggle">
          <button class="view-btn ${initialView === 'list' ? 'active' : ''}" data-view="list" title="Lista">${svgList}</button>
          <button class="view-btn ${initialView === 'grid' ? 'active' : ''}" data-view="grid" title="Grade">${svgGrid}</button>
        </div>
      </div>
    </div>
    <div id="group-overlay-sel-bar" style="display:none;align-items:center;gap:6px;margin-bottom:10px;padding:7px 10px;border-radius:var(--r-sm);background:var(--accent-subtle);border:1px solid var(--accent-subtle2)">
      <span id="group-overlay-sel-bar-label" style="font-size:12px;font-weight:600;color:var(--text-accent);flex:1"></span>
      <button class="btn btn-secondary" id="group-overlay-btn-enable" style="padding:3px 10px;font-size:11.5px;display:flex;align-items:center;gap:5px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg>Ativar</button>
      <button class="btn btn-secondary" id="group-overlay-btn-disable" style="padding:3px 10px;font-size:11.5px;display:flex;align-items:center;gap:5px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>Desativar</button>
      <button class="btn btn-danger"    id="group-overlay-btn-trash"   style="padding:3px 10px;font-size:11.5px;display:flex;align-items:center;gap:5px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>Lixeira</button>
    </div>
    <div id="group-overlay-content"></div>`;

  openModal(`Grupo: ${displayTitle} (${group.files.length} arquivos)`, bodyHtml, [
    { label: 'Fechar', cls: 'btn-secondary', action: () => {} }
  ]);

  let currentView = initialView;
  const contentEl = document.getElementById('group-overlay-content');

  // ── Local selection state for the modal ──────────────────────────────
  const modalSelected = new Set(); // Set<filePath>

  function updateSelCount() {
    const countEl = document.getElementById('group-overlay-sel-count');
    const bar     = document.getElementById('group-overlay-sel-bar');
    const barLabel= document.getElementById('group-overlay-sel-bar-label');
    if (!countEl || !bar) return;
    if (modalSelected.size === 0) {
      countEl.style.display = 'none';
      bar.style.display = 'none';
    } else {
      const n = modalSelected.size;
      const label = `${n} selecionado${n > 1 ? 's' : ''}`;
      countEl.style.display = '';
      countEl.textContent = label;
      bar.style.display = 'flex';
      if (barLabel) barLabel.textContent = label;
    }
  }

  // Wire action buttons (attached once after openModal)
  setTimeout(() => {
    document.getElementById('group-overlay-btn-enable')?.addEventListener('click', async () => {
      const allMods = [...state.mods, ...state.trayFiles];
      const targets = [...modalSelected].filter(p => { const m = allMods.find(m => m.path === p); return m && !m.enabled; });
      if (!targets.length) { toast('Nenhum mod inativo selecionado', 'warning'); return; }
      // Desabilita botões de ação do overlay durante a operação
      ['group-overlay-btn-enable','group-overlay-btn-disable','group-overlay-btn-trash'].forEach(id => {
        const b = document.getElementById(id); if (b) b.disabled = true;
      });
      const results = [];
      for (const p of targets) results.push(await window.api.toggleMod(p));
      await loadMods();
      refreshGroupFiles(results);
      renderMods();
      clearOverlaySelection();
      renderView(currentView);
      toast(`${targets.length} mod(s) ativados`, 'success');
      const newPaths = results.filter(r => r.success).map(r => r.newPath);
      pushUndo(`Ativar ${newPaths.length} mod(s)`, async () => {
        for (const p of newPaths) await window.api.toggleMod(p);
        await loadMods(); renderMods();
      }, 'toggle_on', { count: newPaths.length, source: 'group-modal' });
    });

    document.getElementById('group-overlay-btn-disable')?.addEventListener('click', async () => {
      const allMods = [...state.mods, ...state.trayFiles];
      const targets = [...modalSelected].filter(p => { const m = allMods.find(m => m.path === p); return m && m.enabled; });
      if (!targets.length) { toast('Nenhum mod ativo selecionado', 'warning'); return; }
      // Desabilita botões de ação do overlay durante a operação
      ['group-overlay-btn-enable','group-overlay-btn-disable','group-overlay-btn-trash'].forEach(id => {
        const b = document.getElementById(id); if (b) b.disabled = true;
      });
      const results = [];
      for (const p of targets) results.push(await window.api.toggleMod(p));
      await loadMods();
      refreshGroupFiles(results);
      renderMods();
      clearOverlaySelection();
      renderView(currentView);
      toast(`${targets.length} mod(s) desativados`, 'success');
      const newPaths = results.filter(r => r.success).map(r => r.newPath);
      pushUndo(`Desativar ${newPaths.length} mod(s)`, async () => {
        for (const p of newPaths) await window.api.toggleMod(p);
        await loadMods(); renderMods();
      }, 'toggle_off', { count: newPaths.length, source: 'group-modal' });
    });

    document.getElementById('group-overlay-btn-trash')?.addEventListener('click', () => {
      const sel = [...modalSelected];
      if (!sel.length) return;
      openModal('Confirmar Exclusão em Lote',
        `<p>Mover <strong>${sel.length}</strong> arquivo(s) para a lixeira?</p>`,
        [
          { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
          { label: `Mover ${sel.length} para lixeira`, cls: 'btn-danger', action: async () => {
            const results = await window.api.trashModsBatch(sel);
            const failed  = results.filter(r => !r.success).length;
            const deleted = results.length - failed;
            await loadMods(); renderMods(); updateTrashBadge();
            // Remove deleted files from group.files so subsequent re-renders are correct
            const deletedPaths = new Set(results.filter(r => r.success).map(r => r.originalPath || r.trashPath));
            group.files = group.files.filter(f => !deletedPaths.has(f.path));
            clearOverlaySelection();
            renderView(currentView);
            toast(`${deleted} arquivo(s) movidos para a lixeira${failed ? `, ${failed} com erro` : ''}`, failed ? 'warning' : 'success');
            if (deleted > 0) {
              const trashed = results.filter(r => r.success);
              pushUndo(`Excluir ${deleted} arquivo(s)`, async () => {
                for (const r of trashed) await window.api.restoreModFromTrash(r.trashPath, r.originalPath);
                await loadMods(); renderMods();
                toast(`${trashed.length} arquivo(s) restaurados`, 'success');
              }, 'delete', { count: deleted, source: 'group-modal', trashPaths: trashed.map(r => r.trashPath) });
            }
            // Refresh modal content to reflect removed items
            renderView(currentView);
          }}
        ]
      );
    });
  }, 0);

  function selectOverlayItem(el, add = true) {
    const fp = el.dataset.path;
    if (!fp) return;
    if (add) {
      modalSelected.add(fp);
      el.classList.add('selected');
    } else {
      modalSelected.delete(fp);
      el.classList.remove('selected');
    }
    updateSelCount();
  }

  function clearOverlaySelection() {
    modalSelected.clear();
    contentEl.querySelectorAll('.group-overlay-row.selected, .group-overlay-grid-card.selected').forEach(el => el.classList.remove('selected'));
    updateSelCount();
  }

  // Rubber band for the modal — reuses the shared _rubberBand state
  function initModalRubberBand(allowOnItems) {
    const scrollEl = document.getElementById('modal-body');

    function ensureRect() {
      // Rect é position:fixed no body — não precisa estar dentro do container de scroll
      if (!_rubberBand.rect || !_rubberBand.rect.isConnected) {
        _rubberBand.rect = document.createElement('div');
        _rubberBand.rect.className = 'rubber-band-rect';
        document.body.appendChild(_rubberBand.rect);
      }
    }

    const onMousedown = e => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, a')) return;
      // In list mode, don't start drag on the row itself (only on empty space)
      if (!allowOnItems && e.target.closest('.group-overlay-row, .group-overlay-grid-card')) return;

      const cr = scrollEl.getBoundingClientRect();
      const startX = e.clientX - cr.left + scrollEl.scrollLeft;
      const startY = e.clientY - cr.top  + scrollEl.scrollTop;
      let started = false;
      const THRESHOLD = 6;

      // Auto-scroll state
      const SCROLL_ZONE  = 40;
      const SCROLL_SPEED = 10;
      let lastMouseClientX = e.clientX;
      let lastMouseClientY = e.clientY;
      let autoScrollRaf = null;

      const updateRect = () => {
        if (!started || !_rubberBand.active) return;
        const x = Math.min(lastMouseClientX, _rubberBand.startClientX);
        const y = Math.min(lastMouseClientY, _rubberBand.startClientY);
        const w = Math.abs(lastMouseClientX - _rubberBand.startClientX);
        const h = Math.abs(lastMouseClientY - _rubberBand.startClientY);
        if (_rubberBand.rect) _rubberBand.rect.style.cssText = `display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
      };

      const autoScrollStep = () => {
        const r = scrollEl.getBoundingClientRect();
        const relY = lastMouseClientY - r.top;
        const relX = lastMouseClientX - r.left;
        let dy = 0, dx = 0;
        if (relY < SCROLL_ZONE)                dy = -SCROLL_SPEED * (1 - relY / SCROLL_ZONE);
        else if (relY > r.height - SCROLL_ZONE) dy =  SCROLL_SPEED * (1 - (r.height - relY) / SCROLL_ZONE);
        if (relX < SCROLL_ZONE)                dx = -SCROLL_SPEED * (1 - relX / SCROLL_ZONE);
        else if (relX > r.width  - SCROLL_ZONE) dx =  SCROLL_SPEED * (1 - (r.width  - relX) / SCROLL_ZONE);
        if (dx || dy) {
          scrollEl.scrollLeft += dx;
          scrollEl.scrollTop  += dy;
          updateRect();
          autoScrollRaf = requestAnimationFrame(autoScrollStep);
        } else {
          autoScrollRaf = null;
        }
      };

      const stopAutoScroll = () => {
        if (autoScrollRaf) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = null; }
      };

      const onMove = ev => {
        lastMouseClientX = ev.clientX;
        lastMouseClientY = ev.clientY;

        const r = scrollEl.getBoundingClientRect();
        const curX = ev.clientX - r.left + scrollEl.scrollLeft;
        const curY = ev.clientY - r.top  + scrollEl.scrollTop;

        if (!started) {
          if (Math.abs(curX - startX) < THRESHOLD && Math.abs(curY - startY) < THRESHOLD) return;
          started = true;
          _rubberBand.active = true;
          _rubberBand.startX = startX;
          _rubberBand.startY = startY;
          _rubberBand.startClientX = e.clientX;
          _rubberBand.startClientY = e.clientY;
          _rubberBand.didSelect = false;
          document.body.style.userSelect = 'none';
          if (!e.ctrlKey && !e.metaKey) clearOverlaySelection();
          ensureRect();
        }

        updateRect();

        const r2 = scrollEl.getBoundingClientRect();
        const relY = ev.clientY - r2.top;
        const relX = ev.clientX - r2.left;
        const nearEdge = relY < SCROLL_ZONE || relY > r2.height - SCROLL_ZONE ||
                         relX < SCROLL_ZONE || relX > r2.width  - SCROLL_ZONE;
        if (nearEdge && !autoScrollRaf) autoScrollRaf = requestAnimationFrame(autoScrollStep);
        if (!nearEdge) stopAutoScroll();
      };

      const onUp = ev => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        stopAutoScroll();
        document.body.style.userSelect = '';

        if (!started || !_rubberBand.active) return;
        _rubberBand.active = false;
        if (_rubberBand.rect) _rubberBand.rect.style.display = 'none';

        const r = scrollEl.getBoundingClientRect();
        const curX = ev.clientX - r.left + scrollEl.scrollLeft;
        const curY = ev.clientY - r.top  + scrollEl.scrollTop;
        const selL = Math.min(curX, _rubberBand.startX), selR = Math.max(curX, _rubberBand.startX);
        const selT = Math.min(curY, _rubberBand.startY), selB = Math.max(curY, _rubberBand.startY);

        const selector = currentView === 'list' ? '.group-overlay-row' : '.group-overlay-grid-card';
        contentEl.querySelectorAll(selector).forEach(item => {
          const ir = item.getBoundingClientRect();
          const iL = ir.left - r.left + scrollEl.scrollLeft;
          const iT = ir.top  - r.top  + scrollEl.scrollTop;
          const iR = iL + ir.width, iB = iT + ir.height;
          if (iL < selR && iR > selL && iT < selB && iB > selT) {
            selectOverlayItem(item, true);
          }
        });
        _rubberBand.didSelect = true;
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    scrollEl.addEventListener('mousedown', onMousedown);

    // Ghost-click prevention
    scrollEl.addEventListener('click', e => {
      if (_rubberBand.didSelect) {
        _rubberBand.didSelect = false;
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    return () => scrollEl.removeEventListener('mousedown', onMousedown);
  }


  // Syncs group.files paths/enabled state with the freshly-loaded state after a toggle.
  // After toggleMod, the file is renamed (.disabled suffix added or removed), so we match
  // by the old path → result.newPath mapping and fall back to name-based lookup.
  function refreshGroupFiles(toggleResults) {
    const allCurrent = [...state.mods, ...state.trayFiles];
    // Build old→new path map from toggle results
    const pathMap = {};
    for (const r of (toggleResults || [])) {
      if (r.success && r.newPath) pathMap[r.oldPath || ''] = r.newPath;
    }
    group.files = group.files.map(f => {
      const newPath = pathMap[f.path];
      const lookup = newPath || f.path;
      const fresh = allCurrent.find(m => m.path === lookup);
      return fresh ? fresh : (newPath ? { ...f, path: newPath, enabled: !f.enabled } : f);
    });
  }

  function renderView(view) {
    currentView = view;
    // Don't clear modalSelected — preserve selection across list/grid mode switches.
    // Just update the toggle button state.
    document.querySelectorAll('#group-overlay-view-toggle .view-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    if (view === 'list') {
      contentEl.style.cssText = '';
      contentEl.innerHTML = buildListHtml();
      // Re-apply selection visually from the in-memory set
      contentEl.querySelectorAll('.group-overlay-row').forEach(el => {
        if (modalSelected.has(el.dataset.path)) el.classList.add('selected');
      });
      wireListEvents();
    } else {
      contentEl.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;padding:2px';
      contentEl.innerHTML = buildGridHtml();
      // Re-apply selection visually from the in-memory set
      contentEl.querySelectorAll('.group-overlay-grid-card').forEach(el => {
        if (modalSelected.has(el.dataset.path)) el.classList.add('selected');
      });
      wireGridEvents();
      loadVisibleThumbnails(document.getElementById('modal-body'));
    }
    // Re-attach rubber band after content swap (module-level var so old listener is always removed)
    if (_cleanupModalRubberBand) _cleanupModalRubberBand();
    _cleanupModalRubberBand = initModalRubberBand(true);
  }

  document.getElementById('group-overlay-view-toggle').addEventListener('click', e => {
    const btn = e.target.closest('[data-view]');
    if (btn && btn.dataset.view !== currentView) renderView(btn.dataset.view);
  });

  function wireListEvents() {
    document.querySelectorAll('.group-overlay-row').forEach(row => {
      row.addEventListener('contextmenu', e => {
        e.preventDefault();
        const fp = row.dataset.path;
        showCtxMenu(e.clientX, e.clientY, fp, {
          onDelete: async (filePath) => {
            const allMods = [...state.mods, ...state.trayFiles];
            const f = allMods.find(m => m.path === filePath);
            const name = f?.name || filePath.split(/[\/]/).pop();
            openModal('Confirmar Exclusão',
              `<p>Mover <strong>${escapeHtml(name)}</strong> para a lixeira?</p>`,
              [
                { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
                { label: 'Mover para lixeira', cls: 'btn-danger', action: async () => {
                  const results = await window.api.trashModsBatch([filePath]);
                  if (results[0]?.success) {
                    const { trashPath, originalPath } = results[0];
                    closeModal();
                    await loadMods(); renderMods();
                    updateTrashBadge();
                    toast(`"${name}" movido para a lixeira`, 'success');
                    pushUndo(`Excluir ${name}`, async () => {
                      await window.api.restoreModFromTrash(trashPath, originalPath);
                      await loadMods(); renderMods();
                      toast('Mod restaurado', 'success');
                      logAction('restore', { name, label: `Restaurar ${name}` });
                    }, 'delete', { name, source: 'group-overlay', trashPaths: [trashPath] });
                  } else toast('Erro ao excluir: ' + (results[0]?.error || ''), 'error');
                }}
              ]
            );
          }
        });
      });
      row.addEventListener('click', async e => {
        // Ctrl/Meta+click → toggle selection, no toggle
        if (e.ctrlKey || e.metaKey) {
          selectOverlayItem(row, !modalSelected.has(row.dataset.path));
          return;
        }
        // Click on already-selected row with others selected → clear selection
        if (modalSelected.size > 1 && modalSelected.has(row.dataset.path)) {
          clearOverlaySelection();
          return;
        }
        // Plain click with no drag → toggle mod
        const fp = row.dataset.path;
        const result = await window.api.toggleMod(fp);
        if (result.success) {
          await loadMods();
          refreshGroupFiles([result]);
          renderMods();
          renderView(currentView);
        } else { toast('Erro ao alternar mod', 'error'); }
      });
    });
  }

  function wireGridEvents() {
    document.querySelectorAll('.group-overlay-grid-card .dot-clickable').forEach(dot => {
      dot.addEventListener('click', async e => {
        e.stopPropagation();
        const card = dot.closest('.group-overlay-grid-card');
        const fp = card?.dataset.path;
        if (!fp) return;
        const result = await window.api.toggleMod(fp);
        if (result.success) {
          await loadMods();
          refreshGroupFiles([result]);
          renderMods();
          renderView(currentView);
        } else { toast('Erro ao alternar mod', 'error'); }
      });
    });
    document.querySelectorAll('.group-overlay-grid-card').forEach(card => {
      card.addEventListener('contextmenu', e => {
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, card.dataset.path, {
          onDelete: async (filePath) => {
            const allMods = [...state.mods, ...state.trayFiles];
            const f = allMods.find(m => m.path === filePath);
            const name = f?.name || filePath.split(/[\/]/).pop();
            openModal('Confirmar Exclusão',
              `<p>Mover <strong>${escapeHtml(name)}</strong> para a lixeira?</p>`,
              [
                { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
                { label: 'Mover para lixeira', cls: 'btn-danger', action: async () => {
                  const results = await window.api.trashModsBatch([filePath]);
                  if (results[0]?.success) {
                    closeModal();
                    await loadMods(); renderMods();
                    updateTrashBadge();
                    toast(`"${name}" movido para a lixeira`, 'success');
                  } else toast('Erro ao excluir: ' + (results[0]?.error || ''), 'error');
                }}
              ]
            );
          }
        });
      });
    });
  }

  renderView(initialView);
}

// ─── Rubber Band Selection ────────────────────────────────────────────────────

let _rubberBand = { active: false, startX: 0, startY: 0, startClientX: 0, startClientY: 0, rect: null, didSelect: false };
// Module-level cleanup for the modal rubber band — needed because openGroupOverlay can be
// called multiple times and each call must remove the previous session's mousedown listener.
let _cleanupModalRubberBand = null;

/**
 * @param container       - Element that holds the cards (gallery-grid or table-container)
 * @param getCards        - () => NodeList/Array of selectable card/row elements
 * @param selectCard      - Optional (card) => void called when a card enters the selection
 * @param allowOnCards    - If true, rubber band can start on top of a card (grid mode).
 *                          A 6px drag threshold prevents accidental activation on plain clicks.
 */
function initRubberBand(container, getCards, selectCard, allowOnCards = false) {
  // The element that actually scrolls — .page in grid mode, the container itself in list mode
  function getScrollEl() { return container.closest('.page') || container; }

  // Create (or reuse) the rubber band rect on document.body.
  // Using position:fixed means the rect is outside the scroll container's layout flow,
  // so it never expands scrollHeight or causes scrollbars during drag.
  function ensureRect() {
    if (!_rubberBand.rect || !_rubberBand.rect.isConnected) {
      _rubberBand.rect = document.createElement('div');
      _rubberBand.rect.className = 'rubber-band-rect';
      document.body.appendChild(_rubberBand.rect);
    }
  }

  container.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.gallery-sort-bar') || e.target.closest('.sel-bar')) return;
    // Nunca iniciar no cabeçalho da tabela
    if (e.target.closest('thead')) return;
    // In list mode, don't start on row cells (clicks handle selection there)
    if (!allowOnCards && e.target.closest('.gallery-card')) return;
    // Never start on interactive controls inside cards
    if (e.target.closest('input, button, a')) return;

    const scrollEl = getScrollEl();
    const cr = scrollEl.getBoundingClientRect();
    const startX = e.clientX - cr.left + scrollEl.scrollLeft;
    const startY = e.clientY - cr.top  + scrollEl.scrollTop;

    let started = false; // becomes true once drag threshold is crossed
    const THRESHOLD = 6; // px

    // Auto-scroll state
    const SCROLL_ZONE  = 40; // px from edge to start auto-scrolling
    const SCROLL_SPEED = 10; // px per animation frame
    let lastMouseClientX = e.clientX;
    let lastMouseClientY = e.clientY;
    let autoScrollRaf = null;

    // Redraws the rubber-band rect using viewport (client) coordinates.
    // The rect uses position:fixed so client coords map directly — no scroll offset needed.
    const updateRect = () => {
      if (!started || !_rubberBand.active) return;
      const x = Math.min(lastMouseClientX, _rubberBand.startClientX);
      const y = Math.min(lastMouseClientY, _rubberBand.startClientY);
      const w = Math.abs(lastMouseClientX - _rubberBand.startClientX);
      const h = Math.abs(lastMouseClientY - _rubberBand.startClientY);
      if (_rubberBand.rect) _rubberBand.rect.style.cssText = `display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    };

    // Auto-scroll loop: scrolls the container when the cursor is near its edge
    const autoScrollStep = () => {
      const r = scrollEl.getBoundingClientRect();
      const relY = lastMouseClientY - r.top;
      const relX = lastMouseClientX - r.left;
      let dy = 0, dx = 0;
      if (relY < SCROLL_ZONE)           dy = -SCROLL_SPEED * (1 - relY / SCROLL_ZONE);
      else if (relY > r.height - SCROLL_ZONE) dy =  SCROLL_SPEED * (1 - (r.height - relY) / SCROLL_ZONE);
      if (relX < SCROLL_ZONE)           dx = -SCROLL_SPEED * (1 - relX / SCROLL_ZONE);
      else if (relX > r.width  - SCROLL_ZONE) dx =  SCROLL_SPEED * (1 - (r.width  - relX) / SCROLL_ZONE);
      if (dx || dy) {
        scrollEl.scrollLeft += dx;
        scrollEl.scrollTop  += dy;
        updateRect();
        autoScrollRaf = requestAnimationFrame(autoScrollStep);
      } else {
        autoScrollRaf = null;
      }
    };

    const stopAutoScroll = () => {
      if (autoScrollRaf) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = null; }
    };

    const onMove = ev => {
      lastMouseClientX = ev.clientX;
      lastMouseClientY = ev.clientY;

      const r = scrollEl.getBoundingClientRect();
      const curX = ev.clientX - r.left + scrollEl.scrollLeft;
      const curY = ev.clientY - r.top  + scrollEl.scrollTop;

      // Activate rubber band only after threshold to avoid disrupting plain clicks
      if (!started) {
        if (Math.abs(curX - startX) < THRESHOLD && Math.abs(curY - startY) < THRESHOLD) return;
        started = true;
        _rubberBand.active = true;
        _rubberBand.startX = startX;
        _rubberBand.startY = startY;
        _rubberBand.startClientX = e.clientX; // viewport coords for fixed-position visual rect
        _rubberBand.startClientY = e.clientY;
        _rubberBand.didSelect = false;

        // Bug fix: prevent text selection during drag
        document.body.style.userSelect = 'none';

        // Clear selection when rubber band starts (unless Ctrl/Meta held)
        if (!e.ctrlKey && !e.metaKey) {
          state.selectedMods.clear();
          container.querySelectorAll('.gallery-card.selected, tr.selected').forEach(el => {
            el.classList.remove('selected');
            const cb = el.querySelector('.card-check, .row-check');
            if (cb) cb.checked = false;
          });
          refreshSelBar(document.getElementById('page-mods'));
        }

        ensureRect();
      }

      updateRect();

      // Kick off auto-scroll if cursor is near the edge
      const r2 = scrollEl.getBoundingClientRect();
      const relY = ev.clientY - r2.top;
      const relX = ev.clientX - r2.left;
      const nearEdge = relY < SCROLL_ZONE || relY > r2.height - SCROLL_ZONE ||
                       relX < SCROLL_ZONE || relX > r2.width  - SCROLL_ZONE;
      if (nearEdge && !autoScrollRaf) autoScrollRaf = requestAnimationFrame(autoScrollStep);
      if (!nearEdge) stopAutoScroll();
    };


    const onUp = ev => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      stopAutoScroll();
      document.body.style.userSelect = '';

      if (!started || !_rubberBand.active) return;
      _rubberBand.active = false;
      if (_rubberBand.rect) _rubberBand.rect.style.display = 'none';

      const r = scrollEl.getBoundingClientRect();
      const curX = ev.clientX - r.left + scrollEl.scrollLeft;
      const curY = ev.clientY - r.top  + scrollEl.scrollTop;
      const selL = Math.min(curX, _rubberBand.startX), selR = Math.max(curX, _rubberBand.startX);
      const selT = Math.min(curY, _rubberBand.startY), selB = Math.max(curY, _rubberBand.startY);

      const cards = getCards();
      cards.forEach(card => {
        const cr2 = card.getBoundingClientRect();
        const cL = cr2.left - r.left + scrollEl.scrollLeft;
        const cT = cr2.top  - r.top  + scrollEl.scrollTop;
        const cR = cL + cr2.width, cB = cT + cr2.height;
        if (cL < selR && cR > selL && cT < selB && cB > selT) {
          if (selectCard) {
            selectCard(card);
          } else {
            const p = card.dataset.path;
            if (p) {
              state.selectedMods.add(p);
              card.classList.add('selected');
              const cb = card.querySelector('.card-check, .row-check');
              if (cb) cb.checked = true;
            }
          }
        }
      });
      _rubberBand.didSelect = true;
      refreshSelBar(document.getElementById('page-mods'));
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Prevent ghost click on cards after a rubber band selection ends on top of a card
  container.addEventListener('click', e => {
    if (_rubberBand.didSelect) {
      _rubberBand.didSelect = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

function setupGalleryEvents(el, mods) {
  setupCommonModsEvents(el);

  // Gallery sort bar
  el.querySelectorAll('.gallery-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const col = btn.dataset.col;
      if (state.sortColumn === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortColumn = col;
        state.sortDir = 'asc';
      }
      state.galleryPage = 1;
      renderMods();
    });
  });

  // Select all
  el.querySelector('#select-all-grid')?.addEventListener('change', e => {
    state.selectedMods.clear();
    if (e.target.checked) mods.forEach(m => {
      if (m._isTrayGroup || m._isModGroup) m.files.forEach(f => state.selectedMods.add(f.path));
      else state.selectedMods.add(m.path);
    });
    el.querySelectorAll('.card-check').forEach(c => {
      c.checked = e.target.checked;
      c.closest('.gallery-card').classList.toggle('selected', e.target.checked);
    });
    refreshSelBar(el);
  });

  // Card checkbox — individual files
  el.querySelectorAll('.card-check:not(.card-check-group):not(.card-check-mod-group)').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const p = cb.dataset.path;
      cb.checked ? state.selectedMods.add(p) : state.selectedMods.delete(p);
      cb.closest('.gallery-card').classList.toggle('selected', cb.checked);
      refreshSelBar(el);
    });
  });

  // Card checkbox — mod groups (selects/deselects all files in group)
  el.querySelectorAll('.card-check-mod-group').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const prefix = cb.dataset.modPrefix;
      const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
      const group = allGrouped.find(g => g._isModGroup && g.modPrefix === prefix);
      if (!group) return;
      group.files.forEach(f => {
        cb.checked ? state.selectedMods.add(f.path) : state.selectedMods.delete(f.path);
      });
      cb.closest('.gallery-card').classList.toggle('selected', cb.checked);
      refreshSelBar(el);
    });
  });

  // Card checkbox — tray groups (selects/deselects all files in group)
  el.querySelectorAll('.card-check-group').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const guid = cb.dataset.trayGuid;
      const allGrouped = groupTrayFiles([...state.mods, ...state.trayFiles]);
      const group = allGrouped.find(g => g._isTrayGroup && g.trayGuid === guid);
      if (!group) return;
      group.files.forEach(f => {
        cb.checked ? state.selectedMods.add(f.path) : state.selectedMods.delete(f.path);
      });
      cb.closest('.gallery-card').classList.toggle('selected', cb.checked);
      refreshSelBar(el);
    });
  });

  // Expand button ▾ → toggle children grid
  el.querySelectorAll('.group-expand-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const wrapper = btn.closest('.group-card-wrapper');
      if (!wrapper) return;
      const isExpanded = wrapper.classList.toggle('is-expanded');
      btn.textContent = isExpanded ? '▴' : '▾';
      btn.dataset.tooltip = isExpanded ? 'Fechar' : 'Ver arquivos do grupo';
      const grid = wrapper.querySelector('.group-children-grid');
      if (grid) {
        grid.style.display = isExpanded ? '' : 'none';
        if (isExpanded) loadVisibleThumbnails(el);
      }
      // Persist expanded state so re-renders (toggle, filter, etc.) keep the group open
      const guid   = wrapper.dataset.trayGuid;
      const prefix = wrapper.dataset.modPrefix;
      const key = guid ? 'tray:' + guid : (prefix ? 'mod:' + prefix : null);
      if (key) { isExpanded ? state.expandedGroups.add(key) : state.expandedGroups.delete(key); }
    });
  });

  // Card click on group → LEFT CLICK = select/deselect, RIGHT CLICK = open overlay
  el.querySelectorAll('.gallery-card.mod-group, .gallery-card.tray-group').forEach(card => {
    // Left click → select
    card.addEventListener('click', e => {
      if (e.target.classList.contains('card-check') || e.target.classList.contains('card-check-group') || e.target.classList.contains('card-check-mod-group')) return;
      if (e.target.classList.contains('dot-clickable')) return;
      if (e.target.closest('.group-expand-btn')) return;
      const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
      const guid   = card.dataset.trayGuid;
      const prefix = card.dataset.modPrefix;
      const group = guid
        ? allGrouped.find(g => g._isTrayGroup && g.trayGuid === guid)
        : allGrouped.find(g => g._isModGroup  && g.modPrefix === prefix);
      if (!group) return;
      const allPaths = group.files.map(f => f.path);
      const allSel = allPaths.every(p => state.selectedMods.has(p));
      allPaths.forEach(p => { allSel ? state.selectedMods.delete(p) : state.selectedMods.add(p); });
      card.classList.toggle('selected', !allSel);
      const cb = card.querySelector('.card-check, .card-check-group, .card-check-mod-group');
      if (cb) cb.checked = !allSel;
      refreshSelBar(el);
    });
    // Right click → abre interface com toggle lista/grade
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
      const guid   = card.dataset.trayGuid;
      const prefix = card.dataset.modPrefix;
      const group = guid
        ? allGrouped.find(g => g._isTrayGroup && g.trayGuid === guid)
        : allGrouped.find(g => g._isModGroup  && g.modPrefix === prefix);
      if (group) openGroupOverlay(group);
    });
  });

  // Card click → SELECT/DESELECT (individual cards)
  // Ctrl/Meta = add/remove from multi-select; plain click = toggle this card's selection
  el.querySelectorAll('.gallery-card:not(.tray-group):not(.mod-group)').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.classList.contains('card-check') || e.target.classList.contains('dot-clickable')) return;
      const p = card.dataset.path;
      if (!p) return;
      const isSelected = state.selectedMods.has(p);
      if (e.ctrlKey || e.metaKey) {
        isSelected ? state.selectedMods.delete(p) : state.selectedMods.add(p);
      } else {
        isSelected ? state.selectedMods.delete(p) : state.selectedMods.add(p);
      }
      card.classList.toggle('selected', state.selectedMods.has(p));
      const cb = card.querySelector('.card-check');
      if (cb) cb.checked = state.selectedMods.has(p);
      refreshSelBar(el);
    });
  });

  // Status dot → enable/disable individual mod (individual cards + child cards)
  el.querySelectorAll('.dot-clickable:not(.dot-clickable-group)').forEach(dot => {
    dot.addEventListener('click', async e => {
      e.stopPropagation();
      const result = await window.api.toggleMod(dot.dataset.path);
      if (result.success) {
        await loadMods(); renderMods();
        const allMods = [...state.mods, ...state.trayFiles];
        const mod = allMods.find(m => m.path === result.newPath);
        const nowEnabled = mod?.enabled ?? false;
        const modName = mod?.name || result.newPath.split(/[\/]/).pop();
        const toggleAgain = async () => { await window.api.toggleMod(result.newPath); await loadMods(); renderMods(); };
        pushUndo(`${nowEnabled ? 'Ativar' : 'Desativar'} ${modName}`,
          toggleAgain,
          nowEnabled ? 'toggle_on' : 'toggle_off', { name: modName },
          toggleAgain);
      } else toast('Erro ao alternar mod', 'error');
    });
  });

  // Status dot → enable/disable all files in a group
  el.querySelectorAll('.dot-clickable-group').forEach(dot => {
    dot.addEventListener('click', async e => {
      e.stopPropagation();
      const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
      const group = dot.dataset.trayGuid
        ? allGrouped.find(g => g._isTrayGroup && g.trayGuid === dot.dataset.trayGuid)
        : allGrouped.find(g => g._isModGroup  && g.modPrefix === dot.dataset.modPrefix);
      if (!group) return;
      try {
        const allEnabled = group.files.every(f => f.enabled);
        const results = [];
        for (const f of group.files) {
          if (allEnabled ? f.enabled : !f.enabled) results.push(await window.api.toggleMod(f.path));
        }
        await loadMods(); renderMods();
        const newPaths = results.filter(r => r.success).map(r => r.newPath);
        pushUndo(`${allEnabled ? 'Desativar' : 'Ativar'} grupo ${group.name}`, async () => {
          for (const p of newPaths) await window.api.toggleMod(p);
          await loadMods(); renderMods();
        }, allEnabled ? 'toggle_off' : 'toggle_on', { name: group.name, count: newPaths.length, type: 'group' });
      } catch (err) { toast('Erro ao alternar grupo', 'error'); }
    });
  });

  // Rubber band (click-drag) selection on gallery grid
  const grid = el.querySelector('#gallery-grid');
  if (grid) {
    initRubberBand(grid, () => grid.querySelectorAll('.gallery-card'), card => {
      // Individual mod card
      const p = card.dataset.path;
      if (p) {
        state.selectedMods.add(p);
        card.classList.add('selected');
        const cb = card.querySelector('.card-check');
        if (cb) cb.checked = true;
        return;
      }
      // Group card (mod-group or tray-group)
      const prefix = card.dataset.modPrefix;
      const guid   = card.dataset.trayGuid;
      if (prefix || guid) {
        const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
        const group = guid
          ? allGrouped.find(g => g._isTrayGroup && g.trayGuid === guid)
          : allGrouped.find(g => g._isModGroup  && g.modPrefix === prefix);
        if (group) {
          group.files.forEach(f => state.selectedMods.add(f.path));
          card.classList.add('selected');
          const cb = card.querySelector('.card-check');
          if (cb) cb.checked = true;
        }
      }
    }, /* allowOnCards = */ true);
    // Block drag on any element inside the grid (covers <img> loaded dynamically)
    grid.addEventListener('dragstart', e => e.preventDefault());
    attachCtxMenu(grid);
  }

  // Load thumbnails
  loadVisibleThumbnails(el);
}

function renderModGroupCard(group) {
  const typeTag   = group.type === 'package' ? '.pkg' : '.ts4';
  const typeClass = group.type === 'package' ? 'card-tag-pkg' : 'card-tag-scr';
  const badgeClass = group.type === 'script'
    ? 'tray-group-badge mod-group-badge mod-group-badge-script'
    : 'tray-group-badge mod-group-badge';
  return renderGroupCard(group, 'mod:' + group.modPrefix, typeTag, typeClass,
    badgeClass, fileIcon(group.type), group.name);
}

async function loadVisibleThumbnails(el) {
  // After loading a thumbnail, update any group card mosaics that include that file
  function updateGroupMosaics(loadedPath) {
    document.querySelectorAll('.gallery-card[data-group-files]').forEach(card => {
      let filePaths;
      try { filePaths = JSON.parse(card.dataset.groupFiles); } catch { return; }
      if (!filePaths.includes(loadedPath)) return;

      const readyThumbs = filePaths
        .map(p => state.thumbnailCache[thumbKey(p)])
        .filter(c => c && c !== THUMB_LOADING);

      if (readyThumbs.length === 0) return; // nothing loaded yet

      // Find the current thumb element inside this card
      const existing = card.querySelector('.gallery-thumb, .gallery-thumb-loading, .gallery-thumb-placeholder');
      if (!existing) return;

      if (readyThumbs.length === 1) {
        // Single thumbnail: only upgrade if still showing a spinner/placeholder
        if (existing.classList.contains('gallery-thumb')) return; // already showing an image
        const img = document.createElement('img');
        img.className = 'gallery-thumb';
        img.src = readyThumbs[0];
        img.alt = '';
        img.loading = 'lazy';
        existing.replaceWith(img);
        return;
      }

      const slots = readyThumbs.slice(0, 9);
      const cols  = slots.length <= 2 ? slots.length : slots.length <= 4 ? 2 : 3;
      const rows  = Math.ceil(slots.length / cols);
      // Don't replace if it's already a mosaic with the same count
      if (existing.classList.contains('group-thumb-mosaic') &&
          existing.querySelectorAll('img').length === Math.min(readyThumbs.length, 9)) return;
      const mosaic = document.createElement('div');
      mosaic.className = 'gallery-thumb group-thumb-mosaic';
      mosaic.style.cssText = `display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);gap:1px;background:#000;`;
      slots.forEach(src => {
        const img = document.createElement('img');
        img.src = src; img.alt = '';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        mosaic.appendChild(img);
      });
      existing.replaceWith(mosaic);
    });
  }

  const loaders = [...el.querySelectorAll('[data-load]')].filter(loader => {
    const hiddenGrid = loader.closest('.group-children-grid');
    return !hiddenGrid || hiddenGrid.style.display !== 'none';
  });

  // Bug fix: group cards only put a spinner for the FIRST file, so the rest
  // of the group's files never get queued. Collect all file paths from visible
  // group cards (data-group-files) and add any uncached ones as DOM-less loads.
  // This lets updateGroupMosaics build the mosaic once they resolve.
  const groupFilesToLoad = new Set();
  el.querySelectorAll('.gallery-card[data-group-files]').forEach(card => {
    // Skip if the card itself is inside a hidden grid
    const hiddenGrid = card.closest('.group-children-grid');
    if (hiddenGrid && hiddenGrid.style.display === 'none') return;
    try {
      JSON.parse(card.dataset.groupFiles).forEach(p => groupFilesToLoad.add(p));
    } catch { /* ignore malformed */ }
  });

  // Collect all files that still need loading, marking them as in-progress
  // atomically before any await — this prevents duplicate IPC calls across
  // concurrent loadVisibleThumbnails instances that can be triggered by rapid
  // renderMods() calls (filter changes, searches, mod toggles, etc.).
  // Uses data-cache-key (normalized, .disabled-stripped) as the cache key so
  // that toggling a mod doesn't bust the thumbnail cache.
  const toLoad = [];
  for (const loader of loaders) {
    const filePath = loader.dataset.load;
    const cacheKey = loader.dataset.cacheKey || thumbKey(filePath);
    const cached = state.thumbnailCache[cacheKey];
    groupFilesToLoad.delete(filePath); // already handled via DOM loader

    if (cached === undefined) {
      // Not yet loaded — queue for async fetch
      state.thumbnailCache[cacheKey] = THUMB_LOADING;
      toLoad.push({ filePath, cacheKey });
    } else if (cached !== THUMB_LOADING) {
      // Already resolved (hit or miss) but this DOM element (e.g. a child
      // card that was hidden when the parent group card loaded) still shows
      // the spinner — update it immediately without a new IPC call.
      if (cached) {
        const img = document.createElement('img');
        img.className = 'gallery-thumb';
        img.src = cached;
        img.alt = '';
        img.loading = 'lazy';
        loader.replaceWith(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'gallery-thumb-placeholder';
        const allFiles = [...state.mods, ...state.trayFiles];
        const allIndividual = allFiles.flatMap(m => (m._isModGroup || m._isTrayGroup) ? m.files : [m]);
        const modEntry = allIndividual.find(m => thumbKey(m.path) === cacheKey);
        ph.textContent = modEntry ? fileIcon(modEntry.type) : '📦';
        loader.replaceWith(ph);
      }
      updateGroupMosaics(filePath);
    }
    // if THUMB_LOADING: already in-flight, will be updated when the Promise resolves
  }

  // Enqueue remaining group files that had no DOM loader (the hidden child-card
  // spinners were filtered out). Loading them in background lets updateGroupMosaics
  // build the mosaic correctly without requiring the user to open the group grid.
  for (const filePath of groupFilesToLoad) {
    const cacheKey = thumbKey(filePath);
    if (state.thumbnailCache[cacheKey] === undefined) {
      state.thumbnailCache[cacheKey] = THUMB_LOADING;
      toLoad.push({ filePath, cacheKey });
    }
  }

  // Load all thumbnails in PARALLEL so that a slow file doesn't block the
  // rest, and so that a new renderMods() call mid-loop doesn't leave items
  // permanently stuck as THUMB_LOADING without anyone awaiting their result.
  await Promise.all(toLoad.map(async ({ filePath, cacheKey }) => {
    const thumb = await window.api.getThumbnail(filePath);
    state.thumbnailCache[cacheKey] = thumb ?? null;

    // Update DOM in place without a full re-render.
    // Use document.querySelectorAll (not el.querySelector) so that thumbnails
    // are applied even when 'el' has become stale after a mid-flight re-render.
    const targets = document.querySelectorAll(`[data-load="${CSS.escape(filePath)}"]`);
    if (!targets.length) {
      // Element no longer in DOM — still call updateGroupMosaics so group cards are refreshed
      updateGroupMosaics(filePath);
      return;
    }

    targets.forEach(stillThere => {
    if (thumb) {
      const img = document.createElement('img');
      img.className = 'gallery-thumb';
      img.src = thumb;
      img.alt = '';
      img.loading = 'lazy';
      stillThere.replaceWith(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'gallery-thumb-placeholder';
      // Use the correct icon for this file type instead of always 📦
      const allFiles = [...state.mods, ...state.trayFiles];
      const allIndividual = allFiles.flatMap(m => (m._isModGroup || m._isTrayGroup) ? m.files : [m]);
      const modEntry = allIndividual.find(m => thumbKey(m.path) === cacheKey);
      ph.textContent = modEntry ? fileIcon(modEntry.type) : '📦';
      stillThere.replaceWith(ph);
    }
    });
    // After updating this thumbnail, upgrade any group card mosaics that include it
    updateGroupMosaics(filePath);
  }));
}

function renderTh(col, label, width = '') {
  const isActive = state.sortColumn === col;
  const arrow = isActive ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
  return `
    <th ${width ? `style="width:${width}"` : ''}>
      <div class="th-content" data-sort="${col}">
        ${label}
        <span class="sort-arrow ${isActive ? 'active' : ''}">${arrow}</span>
      </div>
      <div class="col-resize-handle"></div>
    </th>`;
}

function renderModRow(mod) {
  if (mod._isTrayGroup) return renderTrayGroupRow(mod);
  if (mod._isModGroup)  return renderModGroupRow(mod);

  const sel = state.selectedMods.has(mod.path);
  return `
    <tr class="${!mod.enabled ? 'disabled' : ''} ${sel ? 'selected' : ''}" data-path="${escapeHtml(mod.path)}">
      <td style="text-align:center;padding:9px 6px"><input type="checkbox" class="checkbox row-check" data-path="${escapeHtml(mod.path)}" ${sel ? 'checked' : ''}></td>
      <td><div class="cell-name"><span class="file-icon">${fileIcon(mod.type)}</span><span title="${escapeHtml(mod.path)}">${escapeHtml(mod.name)}</span></div></td>
      <td>${typeBadge(mod.type)}</td>
      <td>${formatBytes(mod.size)}</td>
      <td title="${escapeHtml(mod.folder)}">${escapeHtml(mod.folder === '/' ? '(raiz)' : mod.folder)}</td>
      <td>${statusBadge(mod.enabled)}</td>
      <td>
        <div style="display:flex;gap:4px;align-items:center">
          <button class="btn btn-sm ${mod.enabled ? 'btn-secondary' : 'btn-primary'} toggle-mod-btn"
            data-path="${escapeHtml(mod.path)}" title="${mod.enabled ? 'Desativar' : 'Ativar'}">
            ${mod.enabled ? '⏸' : '▶'}
          </button>
          <button class="btn btn-sm btn-danger delete-mod-btn" data-path="${escapeHtml(mod.path)}" title="Apagar arquivo">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
          </button>
        </div>
      </td>
    </tr>`;
}

function renderGroupRow(group, idAttr, idVal, badgeEmoji) {
  const allPaths = group.files.map(f => f.path);
  const allSel = allPaths.every(p => state.selectedMods.has(p));
  const groupKey = group._isTrayGroup ? 'tray:' + group.trayGuid : 'mod:' + group.modPrefix;
  const isExpanded = state.expandedGroups.has(groupKey);
  const allEnabled  = group.files.every(f => f.enabled);
  const someEnabled = !allEnabled && group.files.some(f => f.enabled);
  const noneEnabled = !allEnabled && !someEnabled;

  const childRows = isExpanded ? group.files.map(f => {
    const fSel = state.selectedMods.has(f.path);
    return `<tr class="child-row ${!f.enabled ? 'disabled' : ''} ${fSel ? 'selected' : ''}" data-path="${escapeHtml(f.path)}">
      <td style="text-align:center;padding:9px 6px">
        <input type="checkbox" class="checkbox row-check" data-path="${escapeHtml(f.path)}" ${fSel ? 'checked' : ''}>
      </td>
      <td>
        <div class="cell-name" style="padding-left:20px">
          <span style="color:var(--text-disabled);font-size:12px;margin-right:4px;flex-shrink:0">↳</span>
          <span class="file-icon">${fileIcon(f.type)}</span>
          <span title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</span>
        </div>
      </td>
      <td>${typeBadge(f.type)}</td>
      <td>${formatBytes(f.size)}</td>
      <td title="${escapeHtml(f.folder)}">${escapeHtml(f.folder === '/' ? '(raiz)' : f.folder)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          ${statusBadge(f.enabled)}

        </div>
      </td>
      <td>
        <div style="display:flex;gap:4px;align-items:center">
          <button class="btn btn-sm ${f.enabled ? 'btn-secondary' : 'btn-primary'} toggle-mod-btn"
            data-path="${escapeHtml(f.path)}">${f.enabled ? '⏸' : '▶'}</button>
          <button class="btn btn-sm btn-danger delete-mod-btn" data-path="${escapeHtml(f.path)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('') : '';

  return `
    <tr class="group-row ${noneEnabled ? 'disabled' : ''} ${allSel ? 'selected' : ''} ${isExpanded ? 'is-expanded' : ''}"
        data-${idAttr}="${escapeHtml(idVal)}" style="cursor:pointer">
      <td style="text-align:center;padding:9px 6px">
        <input type="checkbox" class="checkbox row-check-group" data-${idAttr}="${escapeHtml(idVal)}" ${allSel ? 'checked' : ''}>
      </td>
      <td>
        <div class="cell-name">
          <span class="file-icon">${badgeEmoji}</span>
          <span title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
          ${(() => { const tc = getTrueGroupCount(group); const lbl = tc > group.files.length ? `${group.files.length}/${tc}` : String(tc); return `<span class="group-row-badge">${lbl} arquivo${tc !== 1 ? 's' : ''}</span>`; })()}
        </div>
      </td>
      <td>${typeBadge(group.type)}</td>
      <td>${formatBytes(group.size)}</td>
      <td title="${escapeHtml(group.folder)}">${escapeHtml(group.folder === '/' ? '(raiz)' : group.folder)}</td>
      <td>${statusBadge(group.enabled, someEnabled)}</td>
      <td>
        <div style="display:flex;gap:4px;align-items:center">
          <button class="btn btn-sm ${group.enabled ? 'btn-secondary' : 'btn-primary'} toggle-group-btn"
            data-${idAttr}="${escapeHtml(idVal)}">${group.enabled ? '⏸' : '▶'}</button>
          <button class="btn btn-sm btn-danger delete-group-btn"
            data-${idAttr}="${escapeHtml(idVal)}" title="Apagar todos os arquivos do grupo">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
          </button>
        </div>
      </td>
    </tr>${childRows}`;
}

function renderTrayGroupRow(group) {
  return renderGroupRow(group, 'tray-guid', group.trayGuid, '🏠');
}

function renderModGroupRow(group) {
  return renderGroupRow(group, 'mod-prefix', group.modPrefix, fileIcon(group.type));
}

function setupModsEvents(el, mods) {
  setupCommonModsEvents(el);

  // Sorting
  el.querySelectorAll('[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (state.sortColumn === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortColumn = col;
        state.sortDir = 'asc';
      }
      renderMods();
    });
  });

  // Column resize
  const table = el.querySelector('#mods-table');
  if (table) initColumnResize(table);

  // Select all
  const selectAll = el.querySelector('#select-all');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      state.selectedMods.clear();
      if (selectAll.checked) mods.forEach(m => {
        if (m._isTrayGroup || m._isModGroup) m.files.forEach(f => state.selectedMods.add(f.path));
        else state.selectedMods.add(m.path);
      });
      el.querySelectorAll('.row-check').forEach(c => c.checked = selectAll.checked);
      el.querySelectorAll('tbody tr').forEach(r => r.classList.toggle('selected', selectAll.checked));
      refreshSelBar(el);
    });
  }

  // Row checkboxes
  el.querySelectorAll('.row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const p = cb.dataset.path;
      if (cb.checked) state.selectedMods.add(p);
      else state.selectedMods.delete(p);
      cb.closest('tr').classList.toggle('selected', cb.checked);
      refreshSelBar(el);
    });
  });

  // Checkbox — group rows (tray or mod prefix)
  el.querySelectorAll('.row-check-group').forEach(cb => {
    cb.addEventListener('change', () => {
      const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
      const group = cb.dataset.trayGuid
        ? allGrouped.find(g => g._isTrayGroup && g.trayGuid === cb.dataset.trayGuid)
        : allGrouped.find(g => g._isModGroup  && g.modPrefix === cb.dataset.modPrefix);
      if (!group) return;
      group.files.forEach(f => {
        cb.checked ? state.selectedMods.add(f.path) : state.selectedMods.delete(f.path);
      });
      cb.closest('tr').classList.toggle('selected', cb.checked);
      refreshSelBar(el);
    });
  });

  // Click on group row header → expand/collapse
  el.querySelectorAll('tr.group-row').forEach(row => {
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
      const group = row.dataset.trayGuid
        ? allGrouped.find(g => g._isTrayGroup && g.trayGuid === row.dataset.trayGuid)
        : allGrouped.find(g => g._isModGroup  && g.modPrefix === row.dataset.modPrefix);
      if (group) openGroupOverlay(group);
    });
    row.addEventListener('click', e => {
      if (e.target.closest('.toggle-group-btn') || e.target.closest('.row-check-group') || e.target.closest('.delete-group-btn')) return;
      const guid   = row.dataset.trayGuid;
      const prefix = row.dataset.modPrefix;
      const key = guid ? 'tray:' + guid : 'mod:' + prefix;
      const scrollTop = document.getElementById('mods-table-container')?.scrollTop || 0;
      if (state.expandedGroups.has(key)) state.expandedGroups.delete(key);
      else state.expandedGroups.add(key);
      renderMods();
      requestAnimationFrame(() => {
        const container = document.getElementById('mods-table-container');
        if (container) container.scrollTop = scrollTop;
      });
    });
  });

  // Toggle group rows
  el.querySelectorAll('.toggle-group-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
      const group = btn.dataset.trayGuid
        ? allGrouped.find(g => g._isTrayGroup && g.trayGuid === btn.dataset.trayGuid)
        : allGrouped.find(g => g._isModGroup  && g.modPrefix === btn.dataset.modPrefix);
      if (!group) return;
      try {
        const allEnabled = group.files.every(f => f.enabled);
        const results = [];
        for (const f of group.files) {
          if (allEnabled ? f.enabled : !f.enabled) results.push(await window.api.toggleMod(f.path));
        }
        await loadMods(); renderMods();
        const newPaths = results.filter(r => r.success).map(r => r.newPath);
        pushUndo(`${allEnabled ? 'Desativar' : 'Ativar'} grupo ${group.name}`, async () => {
          for (const p of newPaths) await window.api.toggleMod(p);
          await loadMods(); renderMods();
        }, allEnabled ? 'toggle_off' : 'toggle_on', { name: group.name, count: newPaths.length, type: 'group' });
      } catch (err) { toast('Erro ao alternar conjunto', 'error'); }
    });
  });

  // Toggle individual mod
  el.querySelectorAll('.toggle-mod-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const result = await window.api.toggleMod(btn.dataset.path);
      if (result.success) {
        await loadMods(); renderMods();
        const allMods = [...state.mods, ...state.trayFiles];
        const mod = allMods.find(m => m.path === result.newPath);
        const nowEnabled = mod?.enabled ?? false;
        const modName = mod?.name || result.newPath.split(/[\/]/).pop();
        const toggleAgain = async () => { await window.api.toggleMod(result.newPath); await loadMods(); renderMods(); };
        pushUndo(`${nowEnabled ? 'Ativar' : 'Desativar'} ${modName}`,
          toggleAgain,
          nowEnabled ? 'toggle_on' : 'toggle_off', { name: modName },
          toggleAgain);
      } else toast('Erro ao alternar mod: ' + result.error, 'error');
    });
  });

  // Delete individual (list mode) — uses internal trash for undo
  el.querySelectorAll('.delete-mod-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const filePath = btn.dataset.path;
      const allMods  = [...state.mods, ...state.trayFiles];
      const name = allMods.find(m => m.path === filePath)?.name || filePath;
      openModal('Confirmar Exclusão',
        `<p>Tem certeza que deseja mover <strong>${escapeHtml(name)}</strong> para a lixeira?</p>`,
        [
          { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
          { label: 'Mover para lixeira', cls: 'btn-danger', action: async () => {
            const results = await window.api.trashModsBatch([filePath]);
            if (results[0]?.success) {
              const { trashPath, originalPath } = results[0];
              await loadMods(); renderMods();
              updateTrashBadge();
              toast('Mod movido para a lixeira', 'success');
              pushUndo(`Excluir ${name}`, async () => {
                await window.api.restoreModFromTrash(trashPath, originalPath);
                await loadMods(); renderMods();
                toast('Mod restaurado', 'success');
                logAction('restore', { name, label: `Restaurar ${name}` });
              }, 'delete', { name, trashPaths: [trashPath] });
            } else {
              toast('Erro ao excluir: ' + (results[0]?.error || ''), 'error');
            }
          }}
        ]
      );
    });
  });

  // Delete group in list mode — uses internal trash for undo
  el.querySelectorAll('.delete-group-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
      const group = btn.dataset.trayGuid
        ? allGrouped.find(g => g._isTrayGroup && g.trayGuid === btn.dataset.trayGuid)
        : allGrouped.find(g => g._isModGroup  && g.modPrefix === btn.dataset.modPrefix);
      if (!group) return;
      // Derive paths from the re-fetched full group (all mods, regardless of filter)
      const paths = group.files.map(f => f.path);
      const fileCount = paths.length; // authoritative count — matches what will be deleted
      openModal('Confirmar Exclusão do Grupo',
        `<p>Tem certeza que deseja mover <strong>${fileCount} arquivo(s)</strong> do grupo <strong>${escapeHtml(group.name)}</strong> para a lixeira?</p>`,
        [
          { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
          { label: `Mover ${fileCount} para lixeira`, cls: 'btn-danger', action: async () => {
            const results = await window.api.trashModsBatch(paths);
            const failed  = results.filter(r => !r.success).length;
            const deleted = results.length - failed;
            await loadMods(); renderMods();
            updateTrashBadge();
            toast(`${deleted} arquivo(s) movidos para lixeira${failed ? `, ${failed} com erro` : ''}`, failed ? 'warning' : 'success');
            if (deleted > 0) {
              const trashed = results.filter(r => r.success);
              pushUndo(`Excluir grupo ${group.name}`, async () => {
                for (const r of trashed) await window.api.restoreModFromTrash(r.trashPath, r.originalPath);
                await loadMods(); renderMods();
                toast(`${trashed.length} arquivo(s) restaurados`, 'success');
                logAction('restore', { count: trashed.length, name: group.name, label: `Restaurar grupo ${group.name}` });
              }, 'delete', { count: deleted, name: group.name, type: 'group', trashPaths: trashed.map(r => r.trashPath) });
            }
          }}
        ]
      );
    });
  });

  // Rubber band selection in table (includes group-rows + expanded child-rows)
  const tableContainer = el.querySelector('#mods-table-container');
  if (tableContainer) {
    initRubberBand(
      tableContainer,
      // All selectable rows: individual rows, child-rows (expanded groups), and group header rows
      () => tableContainer.querySelectorAll('tr[data-path], tr.group-row'),
      // Custom selectCard: group-rows select all their files; plain rows select the single file
      (card) => {
        if (card.classList.contains('group-row')) {
          const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
          const group = card.dataset.trayGuid
            ? allGrouped.find(g => g._isTrayGroup && g.trayGuid === card.dataset.trayGuid)
            : allGrouped.find(g => g._isModGroup  && g.modPrefix === card.dataset.modPrefix);
          if (group) {
            group.files.forEach(f => state.selectedMods.add(f.path));
            card.classList.add('selected');
            const cb = card.querySelector('.row-check-group');
            if (cb) cb.checked = true;
          }
        } else {
          const p = card.dataset.path;
          if (p) {
            state.selectedMods.add(p);
            card.classList.add('selected');
            const cb = card.querySelector('.row-check');
            if (cb) cb.checked = true;
          }
        }
      }
    );
    attachCtxMenu(tableContainer);
  }
}

// Recursively collects all File objects from a DataTransferItemList,
// descending into folders via the FileSystem API (webkitGetAsEntry).
async function collectDroppedFiles(items) {
  const files = [];
  const MAX_DEPTH = 10; // QA: limite de profundidade para evitar loop em estruturas muito aninhadas

  function readEntry(entry, depth = 0) {
    return new Promise(resolve => {
      if (entry.isFile) {
        entry.file(f => { files.push(f); resolve(); }, () => resolve());
      } else if (entry.isDirectory && depth < MAX_DEPTH) {
        const reader = entry.createReader();
        const readAll = () => {
          reader.readEntries(async entries => {
            if (!entries.length) return resolve();
            await Promise.all(entries.map(e => readEntry(e, depth + 1)));
            readAll(); // readEntries returns max 100 at a time — keep reading
          }, () => resolve());
        };
        readAll();
      } else {
        resolve();
      }
    });
  }

  const entries = [...items]
    .map(item => item.webkitGetAsEntry?.())
    .filter(Boolean);

  await Promise.all(entries.map(readEntry));
  return files;
}

async function importFiles() {
  const files = await window.api.openFilesDialog();
  if (!files.length) return;
  await doImport(files);
}

async function doImport(filePaths) {
  if (!state.config?.modsFolder || !state.config?.trayFolder) {
    toast('Configure as pastas Mods e Tray primeiro', 'warning');
    navigate('settings');
    return;
  }

  const SUPPORTED_EXTS = new Set([
    '.package', '.ts4script',
    '.trayitem', '.blueprint', '.bpi', '.hhi', '.sgi', '.householdbinary', '.room', '.rmi',
    '.zip', '.rar', '.7z'
  ]);

  // Use getRealExtension logic to handle .disabled files correctly
  function getImportExt(p) {
    const base = p.split(/[\\/]/).pop() || '';
    const withoutDisabled = base.endsWith('.disabled') ? base.slice(0, -'.disabled'.length) : base;
    const dot = withoutDisabled.lastIndexOf('.');
    return dot === -1 ? '' : withoutDisabled.slice(dot).toLowerCase();
  }

  const supported = filePaths.filter(p => SUPPORTED_EXTS.has(getImportExt(p)));
  const skipped   = filePaths.length - supported.length;

  if (!supported.length) {
    toast(
      skipped === 1
        ? 'Nenhum mod encontrado. Use .package, .ts4script, arquivos de Tray ou .zip/.rar/.7z'
        : `Nenhum mod encontrado entre os ${skipped} arquivo(s) verificado(s). Formatos aceitos: .package, .ts4script, .trayitem, .zip/.rar/.7z`,
      'warning'
    );
    return;
  }

  if (skipped > 0) {
    toast(`${skipped} arquivo(s) ignorado(s) (formato não suportado) — importando os ${supported.length} válido(s)`, 'info');
  }

  toast(`Importando ${supported.length} arquivo(s)...`, 'info', 2000);
  try {
    const result = await window.api.importFiles(supported, state.config.modsFolder, state.config.trayFolder);
    await loadMods();
    if (state.currentPage === 'mods') renderMods();
    if (state.currentPage === 'dashboard') renderDashboard();

    if (result.imported.length > 0 && result.errors.length > 0) {
      toast(`${result.imported.length} importado(s), ${result.errors.length} com erro`, 'warning');
    } else if (result.imported.length > 0) {
      toast(`${result.imported.length} arquivo(s) importado(s) com sucesso`, 'success');
    } else if (result.errors.length > 0) {
      toast(`Falha ao importar: ${result.errors[0]?.error || 'erro desconhecido'}`, 'error');
    }

    if (result.imported.length > 0) {
      const importedPaths = result.imported;
      pushUndo(`Importar ${result.imported.length} arquivo(s)`, async () => {
        const trashResults = await window.api.trashModsBatch(importedPaths);
        const ok = trashResults.filter(r => r.success).length;
        await loadMods();
        updateTrashBadge();
        if (state.currentPage === 'mods') renderMods();
        if (state.currentPage === 'dashboard') renderDashboard();
        toast(`${ok} arquivo(s) importado(s) removido(s)`, 'info');
      }, 'import', { count: result.imported.length });
    }
  } catch (e) {
    toast('Erro ao importar: ' + (e.message || 'falha inesperada'), 'error');
  }
}

// ─── Conflicts Page ───────────────────────────────────────────────────────────

async function renderConflicts() {
  // Não cancelar scan em andamento ao navegar — o progresso continua e é exibido aqui
  // A sidebar é suprimida enquanto esta aba está aberta (via updateScanIndicator)
  updateScanIndicator();

  const el = document.getElementById('page-conflicts');
  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Conflitos</div>
        <div class="page-subtitle">Detecte arquivos duplicados ou conflitantes</div>
      </div>
      <div class="header-actions">
        <button class="btn btn-primary" id="btn-scan-conflicts">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Escanear Conflitos
        </button>
      </div>
    </div>
    <div class="notice info">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <div>
        <strong>Tipos de conflitos detectados:</strong> arquivos com mesmo nome, duplicatas por conteúdo (hash MD5) e duplicatas geradas pelo sistema operacional (ex: arquivo (2).package).
      </div>
    </div>
    <div id="conflicts-result"></div>
  `;

  el.querySelector('#btn-scan-conflicts').addEventListener('click', () => runConflictScan(el));

  // Se um scan de conflitos já está em andamento, reconectar o progresso in-page
  if (state.conflictScanning) {
    const resultEl = el.querySelector('#conflicts-result');
    resultEl.innerHTML = `
      <div class="loading-state" id="conflict-loading">
        <div class="spinner"></div>
        <div class="loading-text" id="conflict-loading-text">Escaneando conflitos…</div>
        <div class="conflict-progress-wrap">
          <div class="conflict-progress-bar-bg">
            <div class="conflict-progress-bar" id="conflict-progress-bar" style="width:0%"></div>
          </div>
          <span class="conflict-progress-label" id="conflict-progress-label">Aguardando…</span>
        </div>
        <button class="btn btn-secondary btn-sm" id="btn-cancel-scan" style="margin-top:8px">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="#f85149" stroke="none">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
          </svg>
          Parar
        </button>
      </div>`;

    document.getElementById('btn-cancel-scan')?.addEventListener('click', () => {
      window.api.cancelConflictScan();
    });

    // Populate initial progress from conflictProgress state (background scan already running)
    if (conflictProgress.total > 0) {
      const done = conflictProgress.total - conflictProgress.remaining;
      const pct  = Math.round((done / conflictProgress.total) * 100);
      const bar   = document.getElementById('conflict-progress-bar');
      const label = document.getElementById('conflict-progress-label');
      if (bar)   bar.style.width   = pct + '%';
      if (label) label.textContent = `${done} de ${conflictProgress.total} arquivo${conflictProgress.total !== 1 ? 's' : ''}`;
    }

    // Subscribe to live progress — background scan already calls onConflictProgress
    // and will update the in-page elements directly (see runStartupChecks)
    // We just need to wait for completion and render results
    (async () => {
      await new Promise(resolve => {
        const interval = setInterval(() => {
          if (!state.conflictScanning) { clearInterval(interval); resolve(); }
        }, 300);
      });
      if (state.currentPage === 'conflicts') renderConflictResults(el);
    })();
    return;
  }

  // Organize scan running — show a waiting state, will auto-refresh when done
  if (organizeProgress.running) {
    const resultEl = el.querySelector('#conflicts-result');
    resultEl.innerHTML = `
      <div class="loading-state" id="conflict-loading">
        <div class="spinner"></div>
        <div class="loading-text" id="conflict-loading-text">Aguardando verificação de organização terminar…</div>
        <div class="conflict-progress-wrap">
          <div class="conflict-progress-bar-bg">
            <div class="conflict-progress-bar" id="conflict-progress-bar" style="width:0%;animation:scan-pulse 1.8s ease-in-out infinite"></div>
          </div>
          <span class="conflict-progress-label" id="conflict-progress-label">Fase 1 de 2 em andamento…</span>
        </div>
      </div>`;

    (async () => {
      await new Promise(resolve => {
        const interval = setInterval(() => {
          if (!organizeProgress.running) { clearInterval(interval); resolve(); }
        }, 300);
      });
      if (state.currentPage === 'conflicts') renderConflicts();
    })();
    return;
  }

  if (state.conflicts.length > 0) renderConflictResults(el);
}

async function runConflictScan(el) {
  if (!state.config?.modsFolder) { toast('Configure a pasta Mods primeiro', 'warning'); return; }
  if (state.conflictScanning) {
    toast('Uma verificação de conflitos já está em andamento', 'warning', 2500);
    return;
  }
  state.conflictScanning = true;
  startConflictIndicator();

  // Update header button to disabled state while scanning
  const scanBtn = el.querySelector('#btn-scan-conflicts');
  if (scanBtn) { scanBtn.disabled = true; scanBtn.style.opacity = '0.5'; }

  // Wire up sidebar stop button
  const sidebarStop = document.getElementById('scan-indicator-stop');
  if (sidebarStop) {
    sidebarStop.onclick = () => {
      window.api.cancelConflictScan();
    };
  }

  const resultEl = el.querySelector('#conflicts-result');

  resultEl.innerHTML = `
    <div class="loading-state" id="conflict-loading">
      <div class="spinner"></div>
      <div class="loading-text" id="conflict-loading-text">Escaneando conflitos…</div>
      <div class="conflict-progress-wrap">
        <div class="conflict-progress-bar-bg">
          <div class="conflict-progress-bar" id="conflict-progress-bar" style="width:0%"></div>
        </div>
        <span class="conflict-progress-label" id="conflict-progress-label">Aguardando…</span>
      </div>
      <button class="btn btn-secondary btn-sm" id="btn-cancel-scan" style="margin-top:8px">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="#f85149" stroke="none">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
        </svg>
        Parar
      </button>
    </div>`;

  // Wire up the stop button
  document.getElementById('btn-cancel-scan')?.addEventListener('click', () => {
    window.api.cancelConflictScan();
  });

  // Subscribe to progress events from the main process
  const unsubscribe = window.api.onConflictProgress(({ done, total, phase }) => {
    conflictProgress.total     = total;
    conflictProgress.remaining = total - done;
    updateScanIndicator();

    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const bar   = document.getElementById('conflict-progress-bar');
    const label = document.getElementById('conflict-progress-label');
    const text  = document.getElementById('conflict-loading-text');
    if (bar)   bar.style.width = pct + '%';
    if (label) label.textContent = `${done} de ${total} arquivo${total !== 1 ? 's' : ''}`;
    if (text)  text.textContent  = phase === 'hashes'
      ? 'Verificando conteúdo duplicado (MD5)…'
      : 'Verificando nomes duplicados…';
  });

  try {
    const result = await window.api.scanConflicts(state.config.modsFolder);

    // null means the scan was cancelled
    if (result === null) {
      resultEl.innerHTML = `
        <div class="notice info" style="justify-content:space-between;align-items:center">
          <span>⏹ Escaneamento cancelado.</span>
          <button class="btn btn-sm btn-primary" id="btn-retry-scan">Escanear novamente</button>
        </div>`;
      el.querySelector('#btn-retry-scan')?.addEventListener('click', () => runConflictScan(el));
      return;
    }

    state.conflicts = result;
    renderConflictResults(el);
  } catch (e) {
    resultEl.innerHTML = `<div class="notice danger">Erro ao escanear: ${escapeHtml(e.message)}</div>`;
  } finally {
    unsubscribe();
    state.conflictScanning = false;
    stopConflictIndicator();
    if (scanBtn) { scanBtn.disabled = false; scanBtn.style.opacity = ''; }
  }
}

function renderConflictResults(el) {
  const resultEl = el.querySelector('#conflicts-result');
  if (!state.conflicts.length) {
    resultEl.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <h3>Nenhum conflito encontrado!</h3>
        <p>Seus mods parecem estar em ordem.</p>
      </div>`;
    return;
  }

  resultEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <span class="section-title">${state.conflicts.length} conflito(s) encontrado(s)</span>
      <button class="btn btn-secondary btn-sm" id="btn-dismiss-all">Dispensar Todos</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px" id="conflict-list">
      ${state.conflicts.map((c, i) => renderConflictCard(c, i)).join('')}
    </div>
  `;

  // Wire up events
  el.querySelectorAll('.conflict-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const filePath = btn.dataset.path;
      const idx = parseInt(btn.dataset.conflict);
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      openModal('Confirmar Exclusão',
        `<p>Deletar o arquivo:<br><strong>${escapeHtml(filePath)}</strong>?</p>`,
        [
          { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
          { label: 'Deletar', cls: 'btn-danger', action: async () => {
            const result = await window.api.conflictMoveToTrash(filePath);
            if (!result.success) { toast('Erro ao deletar: ' + (result.error || ''), 'error'); return; }
            const trashPath = result.to;
            const removedConflict = state.conflicts[idx];
            state.conflicts.splice(idx, 1);
            await loadMods();
            renderConflictResults(el);
            toast('Arquivo deletado', 'success');
            updateTrashBadge();
            pushUndo(`Deletar ${fileName}`, async () => {
              await window.api.conflictRestoreFromTrash(trashPath, filePath);
              await loadMods();
              // Restore conflict entry so card reappears without requiring a rescan
              if (!state.conflicts.find(c => c.id === removedConflict.id)) {
                state.conflicts.push(removedConflict);
              }
              renderConflictResults(el);
              toast('Arquivo restaurado', 'success');
              logAction('restore', { name: fileName, label: `Restaurar ${fileName}` });
            }, 'delete', { name: fileName, source: 'conflicts', trashPaths: [trashPath] });
          }}
        ]
      );
    });
  });

  el.querySelector('#btn-dismiss-all')?.addEventListener('click', () => {
    state.conflicts = [];
    renderConflictResults(el);
  });
}

function renderConflictCard(conflict, idx) {
  const typeLabel = { 'same-name': 'Mesmo Nome', 'hash-duplicate': 'Conteúdo Idêntico', 'os-duplicate': 'Duplicata do Sistema' }[conflict.type] || conflict.type;
  const typeCls = conflict.type === 'hash-duplicate' ? 'badge-conflict' : 'badge-warn';

  return `
    <div class="conflict-card">
      <div class="conflict-header">
        <span class="badge ${typeCls}">${typeLabel}</span>
        <span style="font-size:12px;color:var(--text-secondary)">${conflict.files.length} arquivos</span>
        ${conflict.hash ? `<span style="font-size:11px;color:var(--text-disabled)">MD5: ${conflict.hash.slice(0,16)}...</span>` : ''}
      </div>
      <div class="conflict-body">
        ${conflict.files.map(f => `
          <div class="conflict-file-row">
            <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
              <span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary)">${escapeHtml(f.name)}</span>
              <span style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-disabled)" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
            </div>
            <span style="font-size:11.5px;color:var(--text-secondary);flex-shrink:0">${formatBytes(f.size)}</span>
            ${statusBadge(f.enabled)}
            <button class="btn btn-sm btn-danger conflict-delete-btn" data-path="${escapeHtml(f.path)}" data-conflict="${idx}" title="Excluir arquivo">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
            </button>
          </div>
        `).join('')}
      </div>
    </div>`;
}

// ─── Organizer Page ───────────────────────────────────────────────────────────

async function renderOrganizer() {
  const el = document.getElementById('page-organizer');
  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Organização Automática</div>
        <div class="page-subtitle">Detecta e corrige arquivos fora do lugar, pastas vazias, grupos espalhados e arquivos inválidos</div>
      </div>
      <div class="header-actions">
        <button class="btn btn-primary" id="btn-scan-organize">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          Escanear
        </button>
      </div>
    </div>

    <div class="card" style="display:flex;flex-direction:column;gap:12px">
      <div class="card-title">O que o Organizar faz</div>
      <div class="notice info">
        <div>
          <strong>Arquivos mal posicionados</strong> — detecta arquivos no lugar errado: .ts4script muito fundo, arquivos de Tray dentro de Mods e vice-versa.<br>
          <strong>Grupos dispersos</strong> — encontra mods com o mesmo prefixo espalhados em pastas diferentes, ou soltos na raiz sem pasta própria, e oferece consolidá-los.<br>
          <strong>Pastas vazias</strong> — lista subpastas sem nenhum arquivo dentro (incluindo subpastas aninhadas) para remoção.
        </div>
      </div>
    </div>

    <div id="organize-result"></div>
  `;

  el.querySelector('#btn-scan-organize').addEventListener('click', () => runOrganizeScan(el));

  // If an organize scan is already running (manual or background), show loading and wait
  if (state.organizeScanning || organizeProgress.running) {
    const resultEl = el.querySelector('#organize-result');
    resultEl.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <div class="loading-text">Verificando organização e pastas vazias...</div>
      </div>`;

    (async () => {
      await new Promise(resolve => {
        const interval = setInterval(() => {
          if (!state.organizeScanning && !organizeProgress.running) {
            clearInterval(interval); resolve();
          }
        }, 300);
      });
      if (state.currentPage === 'organizer') renderOrganizeResults(el);
    })();
    return;
  }

  if (state.misplaced.length > 0 || state.emptyFolders.length > 0 || state.scattered.length > 0) renderOrganizeResults(el);
}

async function runOrganizeScan(el) {
  if (!state.config?.modsFolder) { toast('Configure a pasta Mods primeiro', 'warning'); return; }
  if (state.organizeScanning) {
    toast('Uma verificação de organização já está em andamento', 'warning', 2500); return;
  }

  state.organizeScanning = true;
  startOrganizeIndicator();

  const scanBtn = el?.querySelector('#btn-scan-organize');
  if (scanBtn) { scanBtn.disabled = true; scanBtn.style.opacity = '0.5'; }

  const resultEl = el?.querySelector('#organize-result');
  if (resultEl) resultEl.innerHTML = `<div class="loading-state"><div class="spinner"></div><div class="loading-text">Verificando organização e pastas vazias...</div></div>`;

  try {
    [state.misplaced, state.emptyFolders, state.scattered, state.invalidFiles] = await Promise.all([
      window.api.scanMisplaced(state.config.modsFolder, state.config.trayFolder),
      window.api.scanEmptyFolders(state.config.modsFolder, state.config.trayFolder),
      window.api.scanScatteredGroups(state.config.modsFolder),
      window.api.scanInvalidFiles(state.config.modsFolder, state.config.trayFolder),
    ]);
    const totalIssues = state.misplaced.length + state.emptyFolders.length
                      + state.scattered.length + state.invalidFiles.length;
    if (state.currentPage === 'organizer' && el) renderOrganizeResults(el);
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<div class="notice danger">Erro ao escanear: ${escapeHtml(e.message)}</div>`;
  } finally {
    state.organizeScanning = false;
    stopOrganizeIndicator();
    if (scanBtn) { scanBtn.disabled = false; scanBtn.style.opacity = ''; }
  }
}

function renderOrganizeResults(el) {
  const resultEl = el.querySelector('#organize-result');
  const hasMisplaced = state.misplaced.length > 0;
  const hasEmpty     = state.emptyFolders.length > 0;
  const hasScattered = state.scattered.length > 0;
  const hasInvalid   = state.invalidFiles.length > 0;

  if (!hasMisplaced && !hasEmpty && !hasScattered && !hasInvalid) {
    resultEl.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <h3>Tudo organizado!</h3>
        <p>Nenhum arquivo fora do lugar e nenhuma pasta vazia encontrada.</p>
      </div>`;
    return;
  }

  let html = '';

  // ── Misplaced files section ──────────────────────────────────────────────
  if (hasMisplaced) {
    html += `
      <div class="card organize-section">
        <div class="organize-section-header">
          <div>
            <span class="section-title">Arquivos fora do lugar</span>
            <span class="organize-section-count">${state.misplaced.length}</span>
          </div>
          <button class="btn btn-primary btn-sm" id="btn-fix-all">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg>
            Corrigir Todos
          </button>
        </div>
        <div class="organize-rows" id="misplaced-list">
          ${state.misplaced.map((item, i) => {
            const itemExt = item.name.replace(/\.disabled$/i, '').match(/\.[^.]+$/)?.[0]?.toLowerCase();
            const itemIcon = itemExt === '.ts4script' ? fileIcon('script')
                           : ['.trayitem','.blueprint','.bpi','.hhi','.sgi','.householdbinary','.room','.rmi'].includes(itemExt) ? fileIcon('tray')
                           : fileIcon('package');
            return `
            <div class="misplaced-row" data-index="${i}">
              <span class="file-icon">${itemIcon}</span>
              <div class="misplaced-info">
                <div class="misplaced-name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</div>
                <div class="misplaced-issue">⚠ ${escapeHtml(item.issue)}</div>
              </div>
              <span class="misplaced-arrow">→</span>
              <div class="misplaced-dest" title="${escapeHtml(item.suggestedDest)}">${escapeHtml(item.suggestedDest)}</div>
              <span style="font-size:11.5px;color:var(--text-secondary);flex-shrink:0">${formatBytes(item.size)}</span>
              <button class="btn btn-sm btn-primary fix-one-btn" data-index="${i}">Corrigir</button>
            </div>
          `}).join('')}
        </div>
      </div>`;
  }

  // ── Scattered groups section ─────────────────────────────────────────────
  if (hasScattered) {
    html += `
      <div class="card organize-section">
        <div class="organize-section-header">
          <div>
            <span class="section-title">Grupos dispersos</span>
            <span class="organize-section-count organize-section-count-warn">${state.scattered.length}</span>
          </div>
          <button class="btn btn-primary btn-sm" id="btn-consolidate-all-scattered">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="8 17 12 21 16 17"/><line x1="12" y1="3" x2="12" y2="21"/>
            </svg>
            Consolidar Todos
          </button>
        </div>
        <div style="margin-bottom:10px;font-size:12.5px;color:var(--text-secondary)">
          Grupos de mods com arquivos espalhados em pastas diferentes, ou agrupados soltos na raiz sem pasta própria. Consolidar organiza tudo numa pasta única.
        </div>
        <div class="organize-rows" id="scattered-list">
          ${state.scattered.map((group, i) => `
            <div class="misplaced-row scattered-group-row" data-index="${i}" style="cursor:pointer" title="Clique para ver os arquivos do grupo">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex-shrink:0;color:var(--accent-light)">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
              <div class="misplaced-info">
                <div class="misplaced-name" title="${escapeHtml(group.name)}">${escapeHtml(group.prefix)} <span style="color:var(--text-secondary);font-weight:400">(${group.files.length} arquivos)</span></div>
                <div class="misplaced-issue" style="color:var(--text-disabled)">
                  ${group.folders.map(f => escapeHtml(f === '/' ? '(raiz)' : f)).join(' · ')}
                  <span style="margin-left:6px;color:var(--accent-light)">→ ${escapeHtml(
                    group.targetFolder === '/' && group.folders.length === 1
                      ? `pasta "${group.prefix}" (nova)`
                      : group.targetFolder === '/' ? '(raiz)' : group.targetFolder
                  )}</span>
                </div>
              </div>
              <span style="font-size:11.5px;color:var(--text-secondary);flex-shrink:0">${formatBytes(group.totalSize)}</span>
              <button class="btn btn-sm btn-primary consolidate-one-btn" data-index="${i}">Consolidar</button>
            </div>
          `).join('')}
        </div>
      </div>`;
  }

  // ── Empty folders section ────────────────────────────────────────────────
  if (hasEmpty) {
    html += `
      <div class="card organize-section">
        <div class="organize-section-header">
          <div>
            <span class="section-title">Pastas vazias</span>
            <span class="organize-section-count organize-section-count-warn">${state.emptyFolders.length}</span>
          </div>
          <button class="btn btn-danger btn-sm" id="btn-delete-all-empty">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
            </svg>
            Apagar Todas
          </button>
        </div>
        <div class="organize-rows" id="empty-folders-list">
          ${state.emptyFolders.map((folder, i) => `
            <div class="empty-folder-row" data-index="${i}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex-shrink:0;color:var(--text-disabled)">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
              </svg>
              <div class="misplaced-info">
                <div class="misplaced-name" title="${escapeHtml(folder.path)}">${escapeHtml(folder.name)}</div>
                <div class="misplaced-issue" style="color:var(--text-disabled)">📁 ${escapeHtml(folder.relativePath)}</div>
              </div>
              <button class="btn btn-sm btn-danger delete-empty-btn" data-index="${i}" title="Apagar pasta vazia">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
              </button>
            </div>
          `).join('')}
        </div>
      </div>`;
  }

  // ── Invalid files section ────────────────────────────────────────────────
  if (hasInvalid) {
    const archiveCount = state.invalidFiles.filter(f => f.category === 'archive').length;
    const unknownCount = state.invalidFiles.filter(f => f.category === 'unknown').length;
    const subtitle = [
      archiveCount ? `${archiveCount} compactado(s)` : '',
      unknownCount ? `${unknownCount} desconhecido(s)` : '',
    ].filter(Boolean).join(' · ');

    html += `
      <div class="card organize-section">
        <div class="organize-section-header">
          <div>
            <span class="section-title">Arquivos inválidos</span>
            <span class="organize-section-count organize-section-count-danger">${state.invalidFiles.length}</span>
            ${subtitle ? `<span style="font-size:11.5px;color:var(--text-secondary);margin-left:6px">${subtitle}</span>` : ''}
          </div>
          <button class="btn btn-danger btn-sm" id="btn-delete-all-invalid">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
            </svg>
            Mover Todos para Lixeira
          </button>
        </div>
        <div class="organize-rows" id="invalid-files-list">
          ${state.invalidFiles.map((item, i) => {
            const isArchive = item.category === 'archive';
            const iconColor = isArchive ? 'var(--warning)' : 'var(--danger)';
            const folderLabel = item.folderType === 'tray' ? 'Tray' : 'Mods';
            return `
            <div class="invalid-file-row" data-index="${i}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex-shrink:0;color:${iconColor}">
                ${isArchive
                  ? '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'
                  : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}
              </svg>
              <div class="misplaced-info">
                <div class="misplaced-name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</div>
                <div class="misplaced-issue" style="color:${iconColor}">⚠ ${escapeHtml(item.reason)}</div>
                <div style="font-size:11px;color:var(--text-disabled)">📁 ${escapeHtml(folderLabel)}${item.folder !== '/' ? ' / ' + escapeHtml(item.folder) : ''}</div>
              </div>
              <span style="font-size:11.5px;color:var(--text-secondary);flex-shrink:0">${formatBytes(item.size)}</span>
              <button class="btn btn-sm btn-subtle show-invalid-in-explorer-btn" data-index="${i}" title="Mostrar no Explorer">📂</button>
              <button class="btn btn-sm btn-danger delete-invalid-btn" data-index="${i}" title="Mover para lixeira">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
              </button>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  resultEl.innerHTML = html;

  // ── Invalid files event handlers ─────────────────────────────────────────
  el.querySelector('#btn-delete-all-invalid')?.addEventListener('click', () => {
    const total = state.invalidFiles.length;
    openModal(
      'Mover Arquivos Inválidos para Lixeira',
      `<p>Mover <strong>${total} arquivo(s) inválido(s)</strong> para a lixeira interna?</p>
       <p style="font-size:12.5px;color:var(--text-secondary)">Você poderá restaurá-los pela aba Lixeira se necessário.</p>`,
      [
        { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
        { label: `Mover ${total} para Lixeira`, cls: 'btn-danger', action: async () => {
          const paths = state.invalidFiles.map(f => f.path);
          const results = await window.api.deleteInvalidFiles(paths);
          const ok = results.filter(r => r.success).length;
          const trashed = results.filter(r => r.success);
          state.invalidFiles = state.invalidFiles.filter((_, i) => !results[i]?.success);
          renderOrganizeResults(el);
          updateTrashBadge();
          toast(`${ok} arquivo(s) movidos para a lixeira`, ok < total ? 'warning' : 'success');
          if (ok > 0) {
            pushUndo(`Excluir ${ok} arquivo(s) inválido(s)`, async () => {
              for (const r of trashed) {
                if (r.trashPath && r.originalPath) {
                  await window.api.trashRestore(r.trashPath, r.originalPath);
                }
              }
              await loadMods();
              if (state.config?.modsFolder) {
                state.invalidFiles = await window.api.scanInvalidFiles(
                  state.config.modsFolder, state.config.trayFolder);
              }
              if (state.currentPage === 'organizer') renderOrganizeResults(el);
              updateTrashBadge();
              logAction('restore', { count: ok, label: `Restaurar ${ok} arquivo(s) inválido(s)` });
            }, 'delete', { count: ok, source: 'invalid-files', trashPaths: trashed.filter(r => r.trashPath).map(r => r.trashPath) });
          }
        }}
      ]
    );
  });

  el.querySelectorAll('.delete-invalid-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx  = parseInt(btn.dataset.index);
      const item = state.invalidFiles[idx];
      if (!item) return;
      const results = await window.api.deleteInvalidFiles([item.path]);
      if (results[0]?.success) {
        const { trashPath, originalPath } = results[0];
        state.invalidFiles.splice(idx, 1);
        renderOrganizeResults(el);
        updateTrashBadge();
        toast(`"${item.name}" movido para a lixeira`, 'success');
        pushUndo(`Excluir "${item.name}"`, async () => {
          if (trashPath && originalPath) {
            await window.api.trashRestore(trashPath, originalPath);
          }
          await loadMods();
          if (state.config?.modsFolder) {
            state.invalidFiles = await window.api.scanInvalidFiles(
              state.config.modsFolder, state.config.trayFolder);
          }
          if (state.currentPage === 'organizer') renderOrganizeResults(el);
          updateTrashBadge();
          logAction('restore', { name: item.name, label: `Restaurar "${item.name}"` });
        }, 'delete', { name: item.name, source: 'invalid-files', trashPaths: [trashPath] });
      } else {
        toast('Erro ao mover para lixeira: ' + (results[0]?.error || ''), 'error');
      }
    });
  });

  el.querySelectorAll('.show-invalid-in-explorer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx  = parseInt(btn.dataset.index);
      const item = state.invalidFiles[idx];
      if (item) window.api.showItemInFolder(item.path);
    });
  });
  el.querySelector('#btn-fix-all')?.addEventListener('click', async () => {
    // Desabilita todos os botões de correção durante a operação
    const fixAllBtn = el.querySelector('#btn-fix-all');
    if (fixAllBtn) { fixAllBtn.disabled = true; fixAllBtn.textContent = 'Corrigindo…'; }
    el.querySelectorAll('.fix-one-btn').forEach(b => { b.disabled = true; });
    try {
    const results = await window.api.fixMisplaced(state.misplaced);
    const ok = results.filter(r => r.success).length;
    state.misplaced = state.misplaced.filter((_, i) => !results[i]?.success);
    await loadMods();
    renderOrganizeResults(el);
    toast(`${ok} arquivo(s) corrigido(s)`, 'success');
    pushUndo(`Mover ${ok} arquivo(s)`, async () => {
      for (const r of results) {
        if (r.success) await window.api.moveMod(r.to, r.from);
      }
      await loadMods();
      renderOrganizeResults(el);
      logAction('restore', { count: ok, label: `Desfazer correção de ${ok} arquivo(s)` });
    }, 'move', { count: ok, source: 'organizer-fix-all' });
    } catch (e) {
      toast('Erro ao corrigir arquivos: ' + (e.message || ''), 'error');
      if (fixAllBtn) { fixAllBtn.disabled = false; fixAllBtn.textContent = 'Corrigir Tudo'; }
      el.querySelectorAll('.fix-one-btn').forEach(b => { b.disabled = false; });
    }
  });

  el.querySelectorAll('.fix-one-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const fixAllBtn = el.querySelector('#btn-fix-all');
      if (fixAllBtn) fixAllBtn.disabled = true;
      const idx = parseInt(btn.dataset.index);
      const item = state.misplaced[idx];
      try {
      const result = await window.api.fixOneMisplaced(item);
      if (result.success) {
        const from = result.from; const to = result.to;
        state.misplaced.splice(idx, 1);
        await loadMods();
        renderOrganizeResults(el);
        toast('Arquivo movido com sucesso', 'success');
        pushUndo(`Mover ${item.name}`, async () => {
          await window.api.moveMod(to, from);
          await loadMods();
          renderOrganizeResults(el);
          logAction('restore', { name: item.name, label: `Desfazer movimentação de ${item.name}` });
        }, 'move', { name: item.name, source: 'organizer-fix-one' });
      } else {
        toast('Erro ao mover arquivo: ' + (result.error || ''), 'error');
        btn.disabled = false;
        if (fixAllBtn) fixAllBtn.disabled = false;
      }
      } catch (e) {
        toast('Erro ao mover arquivo: ' + (e.message || ''), 'error');
        btn.disabled = false;
        if (fixAllBtn) fixAllBtn.disabled = false;
      }
    });
  });

  // ── Scattered groups event handlers ──────────────────────────────────────
  async function consolidateGroup(group) {
    const cfg = state.config;
    if (!cfg?.modsFolder) return { moved: 0, targetAbs: group.targetFolderAbs, movedMap: [] };

    const sep = cfg.modsFolder.includes('\\') ? '\\' : '/';
    let targetAbs = group.targetFolderAbs;
    let createNewFolder = false;

    // Se o destino calculado é a raiz, criar subpasta nomeada pelo prefixo
    // (máx. 1 nível de profundidade — válido tanto para .package quanto para .ts4script)
    if (group.targetFolder === '/') {
      targetAbs = cfg.modsFolder + sep + group.prefix;
      createNewFolder = true;
    }

    // Quais arquivos precisam mover: ao criar nova pasta, todos; caso contrário só os que estão fora
    const filesToMove = createNewFolder
      ? [...group.files]
      : group.files.filter(f => f.folder !== group.targetFolder);

    // Captura mapa originalPath → newPath ANTES de qualquer operação de disco
    const movedMap = filesToMove.map(f => ({
      originalPath: f.path,
      newPath: targetAbs + sep + f.name,
    }));

    let moved = 0;
    for (const { originalPath, newPath } of movedMap) {
      const result = await window.api.moveMod(originalPath, newPath);
      if (result.success) moved++;
    }

    await loadMods();
    return { moved, targetAbs, movedMap };
  }

  el.querySelectorAll('.consolidate-one-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index);
      const group = state.scattered[idx];
      const destLabel = group.targetFolder === '/' ? `pasta "${group.prefix}" (nova)` : group.targetFolder;
      const moveCount = group.targetFolder === '/' ? group.files.length : group.files.filter(f => f.folder !== group.targetFolder).length;
      openModal(
        `Consolidar grupo "${group.prefix}"`,
        `<p>Mover <strong>${moveCount} arquivo(s)</strong> para <strong>${escapeHtml(destLabel)}</strong>?</p>`,
        [
          { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
          { label: 'Consolidar', cls: 'btn-primary', action: async () => {
            const { moved, movedMap } = await consolidateGroup(group);
            if (moved > 0) {
              state.scattered.splice(idx, 1);
              renderOrganizeResults(el);
              toast(`${moved} arquivo(s) consolidados em "${group.prefix}"`, 'success');
              pushUndo(
                `Consolidar "${group.prefix}" (${moved} arquivo${moved !== 1 ? 's' : ''})`,
                async () => {
                  for (const { newPath, originalPath } of movedMap) {
                    await window.api.moveMod(newPath, originalPath);
                  }
                  await loadMods();
                  if (state.config?.modsFolder) {
                    state.scattered = await window.api.scanScatteredGroups(state.config.modsFolder);
                  }
                  if (state.currentPage === 'organizer') renderOrganizeResults(el);
                },
                'consolidate',
                { count: moved, name: group.prefix }
              );
            } else {
              toast('Nenhum arquivo precisava ser movido', 'info');
            }
          }}
        ]
      );
    });
  });

  // Click on a scattered row (outside the Consolidar button) → open group overlay
  el.querySelectorAll('.scattered-group-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.consolidate-one-btn')) return;
      const idx = parseInt(row.dataset.index);
      const scattered = state.scattered[idx];
      if (!scattered) return;

      // Enrich scattered files with type + enabled from state.mods
      const allMods = [...state.mods, ...state.trayFiles];
      const enrichedFiles = scattered.files.map(f => {
        const live = allMods.find(m => m.path === f.path);
        return {
          path:    f.path,
          name:    f.name,
          folder:  f.folder,
          size:    f.size,
          type:    live?.type    ?? (f.name.match(/\.ts4script(\.disabled)?$/i) ? 'script' : 'package'),
          enabled: live?.enabled ?? !f.name.endsWith('.disabled'),
        };
      });

      openGroupOverlay({
        _isTrayGroup: false,
        _isModGroup:  true,
        modPrefix:    scattered.prefix,
        name:         scattered.name,
        files:        enrichedFiles,
      });
    });
  });

  el.querySelector('#btn-consolidate-all-scattered')?.addEventListener('click', () => {
    const total = state.scattered.reduce((s, g) => {
      return s + (g.targetFolder === '/' ? g.files.length : g.files.filter(f => f.folder !== g.targetFolder).length);
    }, 0);
    const groupCount = state.scattered.length;
    openModal(
      'Consolidar Todos os Grupos',
      `<p>Mover <strong>${total} arquivo(s)</strong> para reorganizar <strong>${groupCount} grupo(s)</strong> dispersos?</p>`,
      [
        { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
        { label: `Consolidar ${groupCount} grupos`, cls: 'btn-primary', action: async () => {
          let totalMoved = 0;
          const allMovedMap = [];
          for (const group of [...state.scattered]) {
            const { moved, movedMap } = await consolidateGroup(group);
            totalMoved += moved;
            if (moved > 0) allMovedMap.push(...movedMap);
          }
          state.scattered = [];
          renderOrganizeResults(el);
          toast(`${totalMoved} arquivo(s) consolidados com sucesso`, 'success');
          pushUndo(
            `Consolidar ${groupCount} grupo${groupCount !== 1 ? 's' : ''} (${totalMoved} arquivo${totalMoved !== 1 ? 's' : ''})`,
            async () => {
              for (const { newPath, originalPath } of allMovedMap) {
                await window.api.moveMod(newPath, originalPath);
              }
              await loadMods();
              if (state.config?.modsFolder) {
                state.scattered = await window.api.scanScatteredGroups(state.config.modsFolder);
              }
              if (state.currentPage === 'organizer') renderOrganizeResults(el);
            },
            'consolidate',
            { count: totalMoved, groups: groupCount }
          );
        }}
      ]
    );
  });

  // ── Empty folders event handlers ─────────────────────────────────────────
  el.querySelector('#btn-delete-all-empty')?.addEventListener('click', () => {
    const count = state.emptyFolders.length;
    openModal(
      'Apagar Todas as Pastas Vazias',
      `<p>Tem certeza que deseja apagar <strong>${count} pasta(s) vazia(s)</strong>?</p>`,
      [
        { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
        { label: `Apagar ${count} pasta(s)`, cls: 'btn-danger', action: async () => {
          const toDelete = [...state.emptyFolders];
          const paths = toDelete.map(f => f.path);
          const results = await window.api.deleteEmptyFolders(paths);
          const ok = results.filter(r => r.success).length;
          const failed = results.length - ok;
          const deletedFolders = toDelete.filter((_, i) => results[i]?.success);
          state.emptyFolders = state.emptyFolders.filter((_, i) => !results[i]?.success);
          renderOrganizeResults(el);
          toast(`${ok} pasta(s) apagada(s)${failed ? `, ${failed} com erro` : ''}`, failed ? 'warning' : 'success');
          if (ok > 0) {
            const deletedPaths = deletedFolders.map(f => f.path);
            pushUndo(`Apagar ${ok} pasta(s) vazia(s)`, async () => {
              const restoreResults = await window.api.restoreEmptyFolders(deletedPaths);
              const restored = restoreResults.filter(r => r.success).length;
              const failed   = restoreResults.length - restored;
              // Re-adiciona as pastas restauradas ao estado para que apareçam na UI
              const restoredFolders = deletedFolders.filter((_, i) => restoreResults[i]?.success);
              state.emptyFolders = [...state.emptyFolders, ...restoredFolders];
              if (state.currentPage === 'organizer') renderOrganizeResults(el);
              toast(
                failed
                  ? `${restored} pasta(s) recriada(s), ${failed} com erro`
                  : `${restored} pasta(s) vazia(s) restauradas`,
                failed ? 'warning' : 'success'
              );
              logAction('restore', { count: restored, label: `Desfazer apagar ${restored} pasta(s) vazia(s)` });
            }, 'delete', { count: ok, source: 'empty-folders', type: 'folder' });
          }
        }}
      ]
    );
  });

  el.querySelectorAll('.delete-empty-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      const folder = state.emptyFolders[idx];
      openModal(
        'Apagar Pasta Vazia',
        `<p>Tem certeza que deseja apagar a pasta:</p>
         <p style="margin-top:8px;word-break:break-all"><strong>${escapeHtml(folder.path)}</strong></p>`,
        [
          { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
          { label: 'Apagar', cls: 'btn-danger', action: async () => {
            const results = await window.api.deleteEmptyFolders([folder.path]);
            if (results[0]?.success) {
              state.emptyFolders.splice(idx, 1);
              renderOrganizeResults(el);
              toast('Pasta apagada', 'success');
              const folderPath = folder.path;
              pushUndo(`Apagar pasta "${folder.name}"`, async () => {
                const restoreResults = await window.api.restoreEmptyFolders([folderPath]);
                if (restoreResults[0]?.success) {
                  state.emptyFolders = [...state.emptyFolders, folder];
                  if (state.currentPage === 'organizer') renderOrganizeResults(el);
                  toast(`Pasta "${folder.name}" recriada`, 'success');
                  logAction('restore', { name: folder.name, label: `Desfazer apagar pasta "${folder.name}"` });
                } else {
                  toast('Erro ao recriar pasta: ' + (restoreResults[0]?.error || ''), 'error');
                }
              }, 'delete', { name: folder.name, source: 'empty-folders', type: 'folder' });
            } else {
              toast('Erro ao apagar pasta: ' + (results[0]?.error || ''), 'error');
            }
          }}
        ]
      );
    });
  });
}

// ─── Manual Page ──────────────────────────────────────────────────────────────

function renderManual() {
  const el = document.getElementById('page-manual');

  // Reutilizável: cabeçalho de seção com separador visual
  function sectionLabel(text) {
    return `<div style="margin:28px 0 12px;display:flex;align-items:center;gap:10px">
      <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.7px;color:var(--text-disabled)">${text}</span>
      <div style="flex:1;height:1px;background:var(--border)"></div>
    </div>`;
  }

  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Manual</div>
        <div class="page-subtitle">Guia de referência dos recursos do gerenciador</div>
      </div>
    </div>

    ${sectionLabel('Aba Mods')}

    <!-- ── Grade e Lista ──────────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">🖱️ Interações com Cards — Grade e Lista</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">

        <strong style="color:var(--text-primary)">Cards individuais (Grade)</strong><br>
        · <strong>Clique esquerdo</strong> — seleciona/deseleciona o card<br>
        · <strong>Clique direito</strong> — menu de contexto: abrir pasta ou excluir<br>
        · <strong>Bolinha colorida</strong> — ativa ou desativa o mod (suporta Desfazer)<br><br>

        <strong style="color:var(--text-primary)">Linhas individuais (Lista)</strong><br>
        · <strong>Clique na linha</strong> — ativa ou desativa o mod diretamente<br>
        · <strong>Clique na checkbox</strong> — adiciona/remove da seleção sem alterar o estado<br>
        · <strong>Clique direito</strong> — menu de contexto: abrir pasta ou excluir<br>
        · <strong>Botões ▶ / ⏸</strong> — ativa/desativa; <strong>🗑</strong> move para a lixeira<br><br>

        <strong style="color:var(--text-primary)">Seleção por área (Rubber Band)</strong><br>
        · <strong>Grade:</strong> arraste em qualquer lugar — seleciona todos os cards que o retângulo tocar<br>
        · <strong>Lista:</strong> arraste no espaço vazio entre linhas para selecionar um intervalo<br>
        · <strong>Ctrl + clique</strong> — adiciona ou remove um item da seleção sem limpá-la<br>
        · Um novo arraste limpa a seleção anterior (exceto com Ctrl pressionado)
      </div>
    </div>

    <!-- ── Grupos ─────────────────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">📦 Grupos de Mods</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">

        Mods são agrupados automaticamente quando dois ou mais arquivos compartilham o mesmo prefixo de nome.<br><br>

        <strong style="color:var(--text-primary)">Critérios de agrupamento</strong><br>
        · <strong>Prefixo por sublinhado</strong> — tudo antes do primeiro <code>_</code> no nome:<br>
        <span style="margin-left:16px"><code>ModFicticio_roupas_v1.package</code> + <code>ModFicticio_addon.package</code> → grupo <em>modficticio</em></span><br>
        · <strong>Prefixo por colchetes</strong> — <code>[Autor]</code> no início do nome:<br>
        <span style="margin-left:16px"><code>[CriadorExemplo] cabelos naturais.package</code> + <code>[CriadorExemplo] olhos.package</code> → grupo <em>CriadorExemplo</em></span><br>
        · <strong>Arquivos de Tray</strong> — agrupados pelo GUID (código hexadecimal após <code>!</code> no nome)<br><br>

        <strong style="color:var(--text-primary)">Interações com cards de grupo</strong><br>
        · <strong>Clique esquerdo</strong> — seleciona/deseleciona todos os arquivos do grupo<br>
        · <strong>Clique direito</strong> — abre a janela de detalhes do grupo<br>
        · <strong>Botão ▾ / ▴</strong> (Grade) — expande/colapsa os cards filhos em linha<br>
        · <strong>Bolinha colorida</strong> — ativa ou desativa o grupo inteiro (suporta Desfazer)<br>
        · <strong>Miniatura</strong> — mosaico com até 9 imagens (grade 3×3) dos arquivos do grupo<br><br>

        <strong style="color:var(--text-primary)">Janela de detalhes do grupo</strong> (clique direito no card)<br>
        · Abre em <strong>grade</strong> se o grupo tiver miniaturas, ou em <strong>lista</strong> caso contrário<br>
        · Toggle lista/grade no canto superior direito da janela<br>
        · Clique em um item individual (sem seleção ativa) para ativar/desativar<br>
        · Clique direito em qualquer item para abrir a pasta ou excluir<br>
        · Seleção por área e Ctrl + clique funcionam dentro da janela<br><br>

        <strong style="color:var(--text-primary)">Barra de ações da janela</strong> (aparece ao selecionar itens)<br>
        · <strong>✓ Ativar</strong> — ativa os inativos selecionados (com Desfazer)<br>
        · <strong>— Desativar</strong> — desativa os ativos selecionados (com Desfazer)<br>
        · <strong>🗑 Lixeira</strong> — move os selecionados para a lixeira após confirmação (com Desfazer)
      </div>
    </div>

    <!-- ── Seleção múltipla ───────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">☑️ Seleção Múltipla e Barra de Ações</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        Com um ou mais itens selecionados na grade ou lista, a <strong>barra de seleção</strong> aparece na parte inferior da tela:<br><br>
        · <strong>✓ Ativar</strong> — ativa todos os mods inativos da seleção<br>
        · <strong>— Desativar</strong> — desativa todos os mods ativos da seleção<br>
        · <strong>🗑 Deletar</strong> — move os selecionados para a lixeira após confirmação<br>
        · <strong>✕</strong> — cancela a seleção<br><br>
        Todas as ações em lote suportam <strong>Desfazer</strong>. Grupos selecionados incluem automaticamente todos os seus arquivos nas ações.
      </div>
    </div>

    ${sectionLabel('Recursos Gerais')}

    <!-- ── Desfazer ───────────────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">⏮️ Sistema de Desfazer</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        A barra de desfazer aparece automaticamente na parte inferior da tela após ações reversíveis. Ações suportadas:<br><br>
        · Ativar / desativar mods — individual, grupo ou em lote<br>
        · Exclusão de arquivos — individual, grupo, em lote ou pela janela de grupo<br>
        · Organização e consolidação — mover arquivos entre pastas<br>
        · Importação de mods<br><br>
        Clique em <strong>↩ Desfazer</strong> dentro de 5 segundos para reverter, ou <strong>✕</strong> para dispensar.<br>
        A barra é ocultada automaticamente quando itens são enviados à lixeira do sistema (ação permanente).
      </div>
    </div>

    <!-- ── Filtros ────────────────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">🔍 Filtros e Busca</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        <strong style="color:var(--text-primary)">Filtro de status</strong><br>
        · <strong>Ativos / Inativos</strong> — exibe apenas mods no estado selecionado<br>
        · <strong>Parciais</strong> — exibe grupos onde parte dos arquivos está ativa e parte inativa; útil para identificar configurações inconsistentes<br><br>
        <strong style="color:var(--text-primary)">Filtro de tipo</strong> — .package, Script ou Tray<br><br>
        <strong style="color:var(--text-primary)">Filtro de pasta</strong> — exibe apenas mods de uma subpasta específica dentro da pasta Mods<br><br>
        <strong style="color:var(--text-primary)">Busca</strong> — filtra por nome em tempo real; compatível com todos os outros filtros simultaneamente
      </div>
    </div>

    ${sectionLabel('Organização')}

    <!-- ── Grupos dispersos ──────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">📁 Consolidar Grupos Dispersos</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        Um grupo é considerado "disperso" quando seus arquivos estão distribuídos em pastas diferentes dentro da pasta Mods. A consolidação os reúne em uma única pasta.<br><br>
        <strong style="color:var(--text-primary)">Como consolidar</strong><br>
        · <strong>Aba Organizar</strong> — seção "Grupos dispersos": botão <em>Consolidar</em> individual ou <em>Consolidar Todos</em><br>
        · <strong>Janela do grupo</strong> (clique direito no card) — botão <em>Consolidar</em> na barra de aviso interna, exibida quando os arquivos estão em pastas diferentes<br><br>
        Os arquivos são movidos para a pasta onde está o maior número de arquivos do grupo. Se todos estiverem na raiz, uma subpasta com o nome do prefixo é criada automaticamente. Esta ação suporta Desfazer.
      </div>
    </div>

    <!-- ── Sincronização ─────────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">🔄 Sincronização em Tempo Real</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        O gerenciador detecta automaticamente alterações feitas por programas externos (Explorer, extratores, etc.) em dois momentos:<br><br>
        · Ao retornar o foco para a janela após ela ter ficado em segundo plano<br>
        · Periodicamente a cada 30 segundos enquanto a aba Mods estiver aberta<br><br>
        Quando uma mudança é detectada, a lista é recarregada sem interromper o uso. O evento fica registrado na aba <strong>Histórico</strong> com o número de arquivos adicionados ou removidos.
      </div>
    </div>

    ${sectionLabel('Referência')}

    <!-- ── Formatos ──────────────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">📥 Formatos Suportados na Importação</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        Arraste arquivos ou pastas para a aba Mods, ou use o botão <strong>Importar</strong>. Pastas são percorridas automaticamente (todos os subníveis).<br><br>
        <strong style="color:var(--text-primary)">Mods</strong><br>
        <code>.package</code> · <code>.ts4script</code><br><br>
        <strong style="color:var(--text-primary)">Tray</strong><br>
        <code>.trayitem</code> · <code>.blueprint</code> · <code>.bpi</code> · <code>.hhi</code> · <code>.sgi</code> · <code>.householdbinary</code> · <code>.room</code> · <code>.rmi</code><br><br>
        <strong style="color:var(--text-primary)">Compactados (extraídos automaticamente)</strong><br>
        <code>.zip</code> · <code>.rar</code> · <code>.7z</code>
      </div>
    </div>

    <!-- ── Regras do TS4 ─────────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">📋 Regras de Subpastas do The Sims 4</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        O jogo impõe limites de profundidade de pasta que o gerenciador leva em conta ao verificar a organização:<br><br>
        · <strong>.package</strong> — aceitos em até 5 níveis de subpasta dentro de Mods<br>
        · <strong>.ts4script</strong> — aceitos em no máximo 1 nível de subpasta (ex: <code>Mods\Scripts\mod.ts4script</code>)<br>
        · <strong>Tray</strong> — devem estar na pasta Tray, não em Mods<br>
        · Não crie uma pasta chamada <code>Mods</code> dentro da pasta Mods
      </div>
    </div>
  `;
}

// ─── History Page ─────────────────────────────────────────────────────────────

function renderHistory() {
  const el = document.getElementById('page-history');

  // ── Sort state (persiste entre re-renders via closure em state)
  if (!state.historySort) state.historySort = { col: 'time', dir: 'desc' };
  const { col: sortCol, dir: sortDir } = state.historySort;

  const pad = n => String(n).padStart(2, '0');
  const formatTime = date => {
    const d = new Date(date);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} — ${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
  };

  const TYPE_META = {
    toggle_on:   { label: 'Ativado',          color: 'var(--success)',        icon: '▶',  page: 'mods'      },
    toggle_off:  { label: 'Desativado',        color: 'var(--text-secondary)', icon: '⏸', page: 'mods'      },
    delete:      { label: 'Excluído',          color: 'var(--danger)',         icon: '🗑', page: null        },
    import:      { label: 'Importado',         color: 'var(--accent)',         icon: '📥', page: 'mods'      },
    move:        { label: 'Movido',            color: 'var(--accent-light)',   icon: '📁', page: 'organizer' },
    consolidate: { label: 'Consolidado',       color: 'var(--accent-light)',   icon: '📦', page: 'organizer' },
    restore:     { label: 'Restaurado',        color: 'var(--warning)',        icon: '↩',  page: 'mods'      },
    scan:        { label: 'Verificação',       color: 'var(--text-disabled)',  icon: '🔍', page: null        },
    fs_change:   { label: 'Alteração externa', color: 'var(--warning)',        icon: '🔄', page: 'mods'      },
    action:      { label: 'Ação',              color: 'var(--text-secondary)', icon: '•',  page: null        },
  };

  // Override scan page based on source
  const scanPage = src => src === 'conflicts' ? 'conflicts' : src === 'organizer' ? 'organizer' : null;

  const SOURCE_LABELS = {
    batch:               'Seleção múltipla',
    'group-overlay':     'Janela de grupo',
    conflicts:           'Conflitos',
    organizer:           'Organizar',
    'organizer-fix-all': 'Organizar — Corrigir todos',
    'organizer-fix-one': 'Organizar — Corrigir um',
    'empty-folders':     'Organizar — Pastas vazias',
    'invalid-files':     'Organizar — Arquivos inválidos',
  };

  function buildDetail(entry) {
    const d = entry.details || {};
    const parts = [];
    if (d.label && !d.name) parts.push(escapeHtml(d.label));
    if (d.name)  parts.push(`<strong>${escapeHtml(d.name)}</strong>`);
    if (d.count !== undefined && d.count !== 1) parts.push(`<span style="color:var(--text-secondary)">(${d.count} arquivo${d.count !== 1 ? 's' : ''})</span>`);
    if (d.groups !== undefined) parts.push(`<span style="color:var(--text-disabled)">${d.groups} grupo${d.groups !== 1 ? 's' : ''}</span>`);
    if (d.type === 'group') parts.push('<span class="badge badge-partial" style="font-size:10px">grupo</span>');
    if (d.type === 'folder') parts.push('<span class="badge badge-warn" style="font-size:10px">pasta</span>');
    if (d.source && SOURCE_LABELS[d.source]) parts.push(`<span style="font-size:11px;color:var(--text-disabled)">via ${escapeHtml(SOURCE_LABELS[d.source])}</span>`);
    if (d.detail) parts.push(`<span style="color:var(--text-secondary)">${escapeHtml(d.detail)}</span>`);
    return parts.join(' ');
  }

  function getNavPage(entry) {
    if (entry.type === 'scan') return scanPage(entry.details?.source);
    const meta = TYPE_META[entry.type];
    if (!meta?.page) return null;
    // delete from conflicts → navigate to conflicts
    if (entry.type === 'delete' && entry.details?.source === 'conflicts') return 'conflicts';
    if (entry.type === 'delete' && entry.details?.source?.startsWith('organizer')) return 'organizer';
    if (entry.type === 'delete' && entry.details?.source?.includes('invalid')) return 'organizer';
    if (entry.type === 'delete' && entry.details?.source === 'empty-folders') return 'organizer';
    if (entry.type === 'delete') return 'mods';
    return meta.page;
  }

  const PAGE_LABELS = { mods: 'Mods', conflicts: 'Conflitos', organizer: 'Organizar', dashboard: 'Início' };

  // ── Sort logic
  const sortedLog = [...state.actionLog].sort((a, b) => {
    let va, vb;
    if (sortCol === 'time') {
      va = new Date(a.timestamp).getTime();
      vb = new Date(b.timestamp).getTime();
    } else if (sortCol === 'action') {
      const ma = TYPE_META[a.type] || TYPE_META.action;
      const mb = TYPE_META[b.type] || TYPE_META.action;
      va = ma.label; vb = mb.label;
    } else {
      va = vb = 0;
    }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const thArrow = col => {
    if (sortCol !== col) return `<span class="sort-arrow sort-arrow-none">⇅</span>`;
    return sortDir === 'asc'
      ? `<span class="sort-arrow sort-arrow-asc">↑</span>`
      : `<span class="sort-arrow sort-arrow-desc">↓</span>`;
  };

  const undoableCount = state.actionLog.filter(e => e.undoFn && !e.undone).length;

  const rows = state.actionLog.length === 0
    ? `<div class="empty-state" style="padding:40px 0">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <h3>Nenhuma ação registrada</h3>
        <p>As ações realizadas nesta sessão aparecerão aqui</p>
      </div>`
    : `<div class="table-container">
        <table id="history-table">
          <thead>
            <tr>
              <th style="width:155px" data-sort-col="time">
                <div class="th-content">Horário ${thArrow('time')}</div>
                <div class="col-resize-handle"></div>
              </th>
              <th style="width:120px" data-sort-col="action">
                <div class="th-content">Ação ${thArrow('action')}</div>
                <div class="col-resize-handle"></div>
              </th>
              <th>
                <div class="th-content">Detalhes</div>
                <div class="col-resize-handle"></div>
              </th>
              <th style="width:195px">
                <div class="th-content" style="justify-content:center">Ações</div>
              </th>
            </tr>
          </thead>
          <tbody>
            ${sortedLog.map((entry, sortedIdx) => {
              const origIdx = state.actionLog.indexOf(entry);
              const meta    = TYPE_META[entry.type] || TYPE_META.action;
              const detail  = buildDetail(entry);
              const canUndo = entry.undoFn && !entry.undone;
              const canRedo = entry.undone  && entry.redoFn;
              const navPage = getNavPage(entry);
              const undoneRow = entry.undone ? 'history-row-undone' : '';

              const navBtn = navPage
                ? `<button class="btn btn-sm btn-subtle history-nav-btn" data-page="${navPage}" data-history-idx="${origIdx}"
                     title="Ir para aba ${escapeHtml(PAGE_LABELS[navPage] || navPage)}">
                     → ${escapeHtml(PAGE_LABELS[navPage] || navPage)}
                   </button>`
                : '';

              const actionBtn = canRedo
                ? `<button class="btn btn-sm btn-primary history-redo-btn" data-history-idx="${origIdx}"
                     title="Refazer esta ação">↺ Refazer</button>`
                : canUndo
                  ? `<button class="btn btn-sm btn-secondary history-undo-btn" data-history-idx="${origIdx}"
                       title="${escapeHtml(entry.details?.label || 'Desfazer esta ação')}">↩ Desfazer</button>`
                  : entry.details?.permanent
                    ? `<span style="font-size:11px;color:var(--danger)" title="Item enviado para a lixeira do sistema">🗑 permanente</span>`
                    : entry.undone
                      ? `<span style="font-size:11px;color:var(--text-disabled)">desfeito</span>`
                      : `<span style="font-size:11px;color:var(--text-disabled)">—</span>`;

              return `
                <tr class="${undoneRow}" data-history-idx="${origIdx}">
                  <td style="font-size:12px;color:var(--text-disabled);white-space:nowrap">${formatTime(entry.timestamp)}</td>
                  <td>
                    <span style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;color:${meta.color}">
                      <span>${meta.icon}</span>${escapeHtml(meta.label)}
                    </span>
                  </td>
                  <td style="font-size:13px;color:var(--text-primary)">${detail}</td>
                  <td>
                    <div style="display:flex;gap:5px;align-items:center;justify-content:center;flex-wrap:wrap">
                      ${actionBtn}
                      ${navBtn}
                    </div>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Histórico</div>
        <div class="page-subtitle">${state.actionLog.length} ação(ões) nesta sessão${undoableCount > 0 ? ` · <span style="color:var(--accent-light)">${undoableCount} reversível(is)</span>` : ''}</div>
      </div>
      <div class="header-actions">
        ${state.actionLog.length > 0 ? `<button class="btn btn-secondary btn-sm" id="btn-clear-history">Limpar histórico</button>` : ''}
      </div>
    </div>
    ${rows}
  `;

  // ── Clear history
  el.querySelector('#btn-clear-history')?.addEventListener('click', () => {
    state.actionLog = [];
    renderHistory();
    toast('Histórico limpo', 'info', 1500);
  });

  // ── Sort by column header click
  el.querySelectorAll('th[data-sort-col]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', e => {
      if (e.target.closest('.col-resize-handle')) return;
      const col = th.dataset.sortCol;
      if (state.historySort.col === col) {
        state.historySort.dir = state.historySort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.historySort.col = col;
        state.historySort.dir = 'asc';
      }
      renderHistory();
    });
  });

  // ── Column resize
  const histTable = el.querySelector('#history-table');
  if (histTable) initColumnResize(histTable);

  // ── Navigate to related page
  el.querySelectorAll('.history-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      if (!page) return;
      state.currentPage = page;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
      document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
      const renderers = { dashboard: renderDashboard, mods: renderMods, conflicts: renderConflicts,
                          organizer: renderOrganizer, manual: renderManual,
                          history: renderHistory, trash: renderTrash, settings: renderSettings };
      renderers[page]?.();
    });
  });

  // ── Undo from history row
  el.querySelectorAll('.history-undo-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx   = parseInt(btn.dataset.historyIdx);
      const entry = state.actionLog[idx];
      if (!entry || entry.undone || !entry.undoFn) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        await entry.undoFn();
        entry.undone = true;
        const stackIdx = state.undoStack.findIndex(s => s.label === (entry.details?.label || entry.type));
        if (stackIdx !== -1) state.undoStack.splice(stackIdx, 1);
        toast('Ação desfeita', 'info');
        renderHistory();
      } catch (e) {
        btn.disabled = false; btn.textContent = '↩ Desfazer';
        toast('Erro ao desfazer: ' + e.message, 'error');
      }
    });
  });

  // ── Redo from history row
  el.querySelectorAll('.history-redo-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx   = parseInt(btn.dataset.historyIdx);
      const entry = state.actionLog[idx];
      if (!entry || !entry.undone || !entry.redoFn) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        await entry.redoFn();
        entry.undone = false;
        toast('Ação refeita', 'info');
        renderHistory();
      } catch (e) {
        btn.disabled = false; btn.textContent = '↺ Refazer';
        toast('Erro ao refazer: ' + e.message, 'error');
      }
    });
  });
}

// ─── Trash Page ───────────────────────────────────────────────────────────────

async function renderTrash() {
  const el = document.getElementById('page-trash');
  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Lixeira</div>
        <div class="page-subtitle" id="trash-subtitle">Carregando…</div>
      </div>
      <div class="header-actions" id="trash-header-actions"></div>
    </div>
    <div id="trash-list-container">
      <div class="loading-state"><div class="spinner"></div></div>
    </div>`;

  const items = await window.api.trashList();
  renderTrashList(el, items);
}

function renderTrashList(el, items) {
  // Sincroniza o badge do nav sempre que a lista da lixeira muda
  updateTrashBadge();

  const subtitle = el.querySelector('#trash-subtitle');
  const actions  = el.querySelector('#trash-header-actions');
  const container = el.querySelector('#trash-list-container');

  const totalSize = items.reduce((s, i) => s + (i.size || 0), 0);
  subtitle.textContent = items.length === 0
    ? 'Nenhum item na lixeira'
    : `${items.length} item(ns) · ${formatBytes(totalSize)}`;

  actions.innerHTML = items.length > 0 ? `
    <button class="btn btn-secondary btn-sm" id="btn-trash-restore-all">↩ Restaurar Todos</button>
    <button class="btn btn-danger btn-sm" id="btn-trash-empty">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
        <path d="M10 11v6"/><path d="M14 11v6"/>
        <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
      </svg>
      Esvaziar Lixeira
    </button>` : '';

  if (items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
        </svg>
        <h3>Lixeira vazia</h3>
        <p>Arquivos excluídos da aba Mods e de Conflitos aparecerão aqui.</p>
      </div>`;
    return;
  }

  const SOURCE_LABEL = { mods: 'Mods', conflicts: 'Conflitos', 'invalid-files': 'Arquivos inválidos', unknown: '—' };
  const pad = n => String(n).padStart(2, '0');
  const formatDate = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // ── Ordenação da lixeira ──────────────────────────────────────────────────
  const sortedItems = [...items].sort((a, b) => {
    const { col, dir } = trashSort;
    let va, vb;
    if (col === 'name')      { va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); }
    else if (col === 'source') { va = SOURCE_LABEL[a.source] || a.source || ''; vb = SOURCE_LABEL[b.source] || b.source || ''; }
    else if (col === 'trashedAt') { va = a.trashedAt || ''; vb = b.trashedAt || ''; }
    else if (col === 'size') { va = a.size || 0; vb = b.size || 0; }
    else { va = ''; vb = ''; }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });

  function trashTh(col, label, width = '') {
    const isActive = trashSort.col === col;
    const arrow = isActive ? (trashSort.dir === 'asc' ? '↑' : '↓') : '↕';
    return `
      <th ${width ? `style="width:${width}"` : ''}>
        <div class="th-content trash-sort-th" data-sort="${col}" style="cursor:pointer;user-select:none">
          ${label}
          <span class="sort-arrow ${isActive ? 'active' : ''}">${arrow}</span>
        </div>
        <div class="col-resize-handle"></div>
      </th>`;
  }

  container.innerHTML = `
    <div class="table-container">
      <table id="trash-table">
        <thead>
          <tr>
            ${trashTh('name', 'Nome')}
            ${trashTh('source', 'Origem', '90px')}
            ${trashTh('trashedAt', 'Excluído em', '140px')}
            ${trashTh('size', 'Tamanho', '80px')}
            <th style="width:190px"><div class="th-content" style="justify-content:center">Ações</div><div class="col-resize-handle"></div></th>
          </tr>
        </thead>
        <tbody>
          ${sortedItems.map((item, idx) => `
            <tr data-trash-idx="${idx}">
              <td>
                <div class="cell-name" title="${escapeHtml(item.originalPath || item.trashPath)}">
                  <span class="file-icon">${fileIcon((() => { const n = item.name.replace(/\.disabled$/i, ''); return n.endsWith('.package') ? 'package' : n.endsWith('.ts4script') ? 'script' : 'tray'; })())}</span>
                  <span>${escapeHtml(item.name)}</span>
                </div>
                ${item.originalPath ? `<div style="font-size:11px;color:var(--text-disabled);margin-top:2px;padding-left:4px">${escapeHtml(item.originalPath)}</div>` : ''}
              </td>
              <td><span class="badge badge-partial" style="font-size:11px">${escapeHtml(SOURCE_LABEL[item.source] || item.source)}</span></td>
              <td style="font-size:12px;color:var(--text-disabled)">${formatDate(item.trashedAt)}</td>
              <td style="font-size:12.5px">${formatBytes(item.size)}</td>
              <td>
                <div style="display:flex;gap:5px;justify-content:center;align-items:center">
                  ${item.originalPath
                    ? `<button class="btn btn-sm btn-secondary trash-restore-btn" data-trash-idx="${idx}" title="Restaurar para o local original">↩ Restaurar</button>`
                    : `<span style="font-size:11px;color:var(--text-disabled)" title="Caminho original desconhecido">Sem origem</span>`}
                  <button class="btn btn-sm btn-danger trash-delete-btn" data-trash-idx="${idx}" title="Excluir permanentemente (sem enviar para lixeira do sistema)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                      <path d="M10 11v6"/><path d="M14 11v6"/>
                      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                    </svg>
                  </button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  // ── Ordenação: clicar no cabeçalho
  container.querySelectorAll('.trash-sort-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (trashSort.col === col) trashSort.dir = trashSort.dir === 'asc' ? 'desc' : 'asc';
      else { trashSort.col = col; trashSort.dir = 'asc'; }
      renderTrashList(el, items);
    });
  });

  // ── Redimensionamento de colunas
  const trashTable = container.querySelector('#trash-table');
  if (trashTable) initColumnResize(trashTable);

  // ── Restore individual
  container.querySelectorAll('.trash-restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const item = sortedItems[parseInt(btn.dataset.trashIdx)];
      if (!item?.originalPath) return;
      btn.disabled = true; btn.textContent = '…';
      // Desabilita também os botões do cabeçalho para evitar conflito durante a restauração
      const restoreAllBtn = el.querySelector('#btn-trash-restore-all');
      const emptyBtn = el.querySelector('#btn-trash-empty');
      if (restoreAllBtn) restoreAllBtn.disabled = true;
      if (emptyBtn) emptyBtn.disabled = true;
      container.querySelectorAll('.trash-restore-btn, .trash-delete-btn').forEach(b => { b.disabled = true; });
      try {
        const result = await window.api.trashRestore(item.trashPath, item.originalPath);
        if (result.success) {
          clearUndoBar(); // restaurar da lixeira invalida qualquer "desfazer exclusão" pendente
          await loadMods();
          toast(`"${item.name}" restaurado`, 'success');
        } else {
          toast('Erro ao restaurar: ' + (result.error || ''), 'error');
        }
      } catch (e) {
        toast('Erro ao restaurar: ' + (e.message || ''), 'error');
      } finally {
        const updated = await window.api.trashList().catch(() => []);
        renderTrashList(el, updated);
      }
    });
  });

  // ── Delete permanent individual
  container.querySelectorAll('.trash-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const item = sortedItems[parseInt(btn.dataset.trashIdx)];
      openModal('Excluir permanentemente',
        `<p>Excluir <strong>${escapeHtml(item.name)}</strong> permanentemente?</p>
         <p style="font-size:12.5px;color:var(--text-secondary)">Esta ação não pode ser desfeita. O arquivo não será enviado para a lixeira do sistema.</p>`,
        [
          { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
          { label: 'Excluir permanentemente', cls: 'btn-danger', action: async () => {
            clearUndoBar();
            invalidateUndoForTrashPaths([item.trashPath]);
            try {
              const result = await window.api.trashDeletePermanent(item.trashPath);
              if (result.success) {
                toast(`"${item.name}" excluído permanentemente`, 'success');
              } else {
                toast('Erro ao excluir: ' + (result.error || ''), 'error');
              }
            } catch (e) {
              toast('Erro ao excluir: ' + (e.message || ''), 'error');
            } finally {
              const updated = await window.api.trashList().catch(() => []);
              renderTrashList(el, updated);
            }
          }}
        ]
      );
    });
  });

  // ── Restore all
  el.querySelector('#btn-trash-restore-all')?.addEventListener('click', async () => {
    const restorable = items.filter(i => i.originalPath);
    if (!restorable.length) { toast('Nenhum item com caminho de origem conhecido', 'warning'); return; }
    openModal('Restaurar Todos',
      `<p>Restaurar <strong>${restorable.length}</strong> item(ns) para seus locais originais?</p>`,
      [
        { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
        { label: 'Restaurar Todos', cls: 'btn-primary', action: async () => {
          const restoreAllBtn = el.querySelector('#btn-trash-restore-all');
          const emptyBtn = el.querySelector('#btn-trash-empty');
          if (restoreAllBtn) { restoreAllBtn.disabled = true; restoreAllBtn.textContent = 'Restaurando…'; }
          if (emptyBtn) emptyBtn.disabled = true;
          // Desabilita todos os botões individuais para evitar condição de corrida
          container.querySelectorAll('.trash-restore-btn, .trash-delete-btn').forEach(b => { b.disabled = true; });
          let ok = 0;
          try {
            for (const item of restorable) {
              const r = await window.api.trashRestore(item.trashPath, item.originalPath);
              if (r.success) ok++;
            }
            if (ok > 0) clearUndoBar(); // restaurar da lixeira invalida qualquer "desfazer exclusão" pendente
            await loadMods();
            toast(`${ok} item(ns) restaurado(s)`, 'success');
            logAction('restore', { count: ok, source: 'trash', label: `Restaurar ${ok} item(ns) da lixeira` });
          } catch (e) {
            toast('Erro ao restaurar: ' + (e.message || ''), 'error');
          } finally {
            const updated = await window.api.trashList().catch(() => []);
            renderTrashList(el, updated);
          }
        }}
      ]
    );
  });

  // ── Empty trash
  el.querySelector('#btn-trash-empty')?.addEventListener('click', () => {
    openModal('Esvaziar Lixeira',
      `<p>Excluir <strong>${items.length}</strong> item(ns) permanentemente?</p>
       <p style="font-size:12.5px;color:var(--text-secondary)">Esta ação não pode ser desfeita. Os arquivos serão excluídos diretamente, sem passar pela lixeira do sistema.</p>`,
      [
        { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
        { label: 'Esvaziar Lixeira', cls: 'btn-danger', action: async () => {
          const emptyBtn = el.querySelector('#btn-trash-empty');
          const restoreAllBtn = el.querySelector('#btn-trash-restore-all');
          if (emptyBtn) { emptyBtn.disabled = true; emptyBtn.textContent = 'Esvaziando…'; }
          if (restoreAllBtn) restoreAllBtn.disabled = true;
          // Desabilita todos os botões individuais de restaurar e excluir para
          // evitar condição de corrida enquanto o esvaziamento está em execução
          container.querySelectorAll('.trash-restore-btn, .trash-delete-btn').forEach(b => { b.disabled = true; });
          // Captura os trashPaths e invalida o histórico ANTES do await,
          // impedindo que o botão Desfazer fique ativo durante a operação.
          const allTrashPaths = items.map(i => i.trashPath).filter(Boolean);
          clearUndoBar();
          invalidateUndoForTrashPaths(allTrashPaths);
          try {
            const result = await window.api.trashEmpty();
            toast(`${result.ok} item(ns) excluído(s) permanentemente${result.failed ? `, ${result.failed} com erro` : ''}`, result.failed ? 'warning' : 'success');
            if (result.ok > 0) {
              // Histórico já foi invalidado antes do await — nada a fazer aqui
            }
          } catch (e) {
            toast('Erro ao esvaziar lixeira', 'error');
          } finally {
            const updated = await window.api.trashList().catch(() => []);
            renderTrashList(el, updated);
          }
        }}
      ]
    );
  });
}

// ─── Settings Page ────────────────────────────────────────────────────────────

function renderSettings() {
  const el = document.getElementById('page-settings');
  const cfg = state.config || {};

  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Configurações</div>
        <div class="page-subtitle">Configure as pastas e preferências do gerenciador</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Pastas do Jogo</div>
      <div class="settings-group">

        <div class="settings-item">
          <div>
            <div class="settings-label">Pasta Mods</div>
            <div class="settings-desc">Onde os arquivos .package e .ts4script devem estar</div>
          </div>
          <div class="path-input-group">
            <input class="path-input" id="mods-path" value="${escapeHtml(cfg.modsFolder || '')}" readonly title="${escapeHtml(cfg.modsFolder || '')}" />
            <button class="btn btn-secondary btn-sm" id="browse-mods">Procurar</button>
          </div>
        </div>

        <div class="settings-item">
          <div>
            <div class="settings-label">Pasta Tray</div>
            <div class="settings-desc">Onde os arquivos .trayitem, .blueprint, etc. devem estar</div>
          </div>
          <div class="path-input-group">
            <input class="path-input" id="tray-path" value="${escapeHtml(cfg.trayFolder || '')}" readonly title="${escapeHtml(cfg.trayFolder || '')}" />
            <button class="btn btn-secondary btn-sm" id="browse-tray">Procurar</button>
          </div>
        </div>

      </div>
    </div>

    <div class="card">
      <div class="card-title">Verificação Automática ao Abrir</div>
      <div class="settings-group">
        <div class="settings-item">
          <div>
            <div class="settings-label">Verificar arquivos mal colocados ao iniciar</div>
            <div class="settings-desc">Detecta arquivos em pastas incorretas e pastas vazias automaticamente ao iniciar o programa (rápido)</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="toggle-auto-misplaced" ${cfg.autoCheckMisplaced !== false ? 'checked' : ''}>
            <div class="toggle-track"><div class="toggle-thumb"></div></div>
          </label>
        </div>
        <div class="settings-item">
          <div>
            <div class="settings-label">Verificar duplicatas ao iniciar</div>
            <div class="settings-desc">Escaneia conflitos e arquivos duplicados automaticamente ao iniciar o programa — pode causar lentidão com muitos mods</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="toggle-auto-duplicates" ${cfg.autoCheckDuplicates ? 'checked' : ''}>
            <div class="toggle-track"><div class="toggle-thumb"></div></div>
          </label>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Sobre</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        <strong style="color:var(--text-primary)">TS4 Mod Manager</strong> <span id="about-version">${state.appVersion ? 'v' + escapeHtml(String(state.appVersion)) : ''}</span><br>
        Gerenciador de mods para The Sims 4 com interface Fluent 2<br>
        Desenvolvido com Electron
      </div>
    </div>

    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" id="save-settings">Salvar Configurações</button>
      <button class="btn btn-secondary" id="reload-mods-btn">Recarregar Mods</button>
      <button class="btn btn-secondary" id="clear-thumb-cache">🗑 Limpar cache de miniaturas</button>
    </div>
  `;

  el.querySelector('#browse-mods').addEventListener('click', async () => {
    const folder = await window.api.openFolderDialog();
    if (folder) el.querySelector('#mods-path').value = folder;
  });

  el.querySelector('#browse-tray').addEventListener('click', async () => {
    const folder = await window.api.openFolderDialog();
    if (folder) el.querySelector('#tray-path').value = folder;
  });

  el.querySelector('#save-settings').addEventListener('click', async () => {
    const modsFolder = el.querySelector('#mods-path').value.trim();
    const trayFolder = el.querySelector('#tray-path').value.trim();
    if (!modsFolder || !trayFolder) { toast('Por favor, configure ambas as pastas', 'warning'); return; }
    // QA-03: impede que Mods e Tray apontem para o mesmo diretório
    if (modsFolder === trayFolder) { toast('As pastas Mods e Tray não podem ser iguais', 'warning'); return; }
    const autoCheckMisplaced = el.querySelector('#toggle-auto-misplaced')?.checked ?? true;
    const autoCheckDuplicates = el.querySelector('#toggle-auto-duplicates')?.checked ?? false;
    state.config = { ...state.config, modsFolder, trayFolder, autoCheckMisplaced, autoCheckDuplicates };
    await window.api.setConfig(state.config);
    toast('Configurações salvas com sucesso', 'success');
    await loadMods();
  });

  el.querySelector('#reload-mods-btn').addEventListener('click', async () => {
    await loadMods();
    toast('Mods recarregados', 'info');
  });

  el.querySelector('#clear-thumb-cache')?.addEventListener('click', async () => {
    await window.api.clearThumbnailCache();
    state.thumbnailCache = {};
    toast('Cache de miniaturas limpo — reabra a grade para recarregar', 'success', 4000);
  });
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

async function updateTrashBadge() {
  const navBtn = document.querySelector('.nav-item[data-page="trash"]');
  if (!navBtn) return;
  try {
    const items = await window.api.trashList();
    let badge = navBtn.querySelector('.nav-trash-badge');
    if (items.length > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-trash-badge';
        navBtn.appendChild(badge);
      }
      badge.textContent = items.length > 99 ? '99+' : items.length;
    } else {
      badge?.remove();
    }
  } catch (_) {}
}

async function loadMods() {
  if (!state.config) return;
  try {
    const [modsOk, trayOk, mods, tray] = await Promise.all([
      window.api.pathExists(state.config.modsFolder),
      window.api.pathExists(state.config.trayFolder),
      window.api.scanMods(state.config.modsFolder),
      window.api.scanTray(state.config.trayFolder)
    ]);
    state.modsFolderExists = Boolean(modsOk);
    state.trayFolderExists = Boolean(trayOk);
    state.mods = mods || [];
    state.trayFiles = tray || [];

    // Normalise paths to thumbnail cache keys (strip .disabled) before purging —
    // the persistent cache keyed by thumbKey(), so passing raw .disabled paths
    // would cause every disabled mod's thumbnail to be evicted on every reload.
    const allPaths = [...state.mods, ...state.trayFiles].map(m => thumbKey(m.path));
    window.api.purgeThumbnailCache(allPaths);
    updateTrashBadge();
  } catch (e) {
    console.error('Error loading mods:', e);
    state.modsFolderExists = false;
    state.trayFolderExists = false;
    state.mods = [];
    state.trayFiles = [];
  }
}

// ─── App Init ─────────────────────────────────────────────────────────────────

async function init() {
  // Window controls
  document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => window.api.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.api.close());

  // Modal close
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // Nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.page));
  });

  // Load config & mods
  state.config = await window.api.getConfig();
  await loadMods();

  // Versão dinâmica — lida do package.json via Electron
  try {
    const version = await window.api.getAppVersion();
    state.appVersion = version;
    const el = document.getElementById('sidebar-version');
    if (el) el.textContent = `v${version}`;
    const about = document.getElementById('about-version');
    if (about) about.textContent = `v${version}`;
  } catch (_) { /* mantém vazio se falhar */ }

  // Load app icon from main process and set in titlebar (replaces SVG placeholder)
  try {
    const iconBase64 = await window.api.getIcon();
    if (iconBase64) {
      const logo = document.getElementById('app-logo');
      if (logo) {
        logo.innerHTML = `<img src="data:image/png;base64,${iconBase64}" width="18" height="18" alt="TS4 Mod Manager" style="object-fit:contain;image-rendering:auto">`;
      }
    }
  } catch (_) { /* keep the SVG fallback */ }

  // Initial page
  navigate('dashboard');

  // Start background checks (non-blocking — runs after first render, only once per session)
  setTimeout(runStartupChecks, 300);

  // ── Real-time sync: reload when window regains focus (external changes) ──────
  window.addEventListener('focus', async () => {
    if (!state.config?.modsFolder) return;
    const prevCount = state.mods.length + state.trayFiles.length;
    await loadMods();
    const newCount = state.mods.length + state.trayFiles.length;
    if (newCount !== prevCount) {
      logAction('fs_change', { detail: `${Math.abs(newCount - prevCount)} arquivo(s) ${newCount > prevCount ? 'adicionado(s)' : 'removido(s)'}` });
      if (state.currentPage === 'mods') renderMods();
      if (state.currentPage === 'dashboard') renderDashboard();
    }
  });

  // ── Real-time sync: periodic poll every 30s while Mods tab is open ───────────
  setInterval(async () => {
    if (state.currentPage !== 'mods' || !state.config?.modsFolder) return;
    const prevCount = state.mods.length + state.trayFiles.length;
    await loadMods();
    const newCount = state.mods.length + state.trayFiles.length;
    if (newCount !== prevCount) {
      logAction('fs_change', { detail: `Atualização periódica: ${Math.abs(newCount - prevCount)} arquivo(s) ${newCount > prevCount ? 'adicionado(s)' : 'removido(s)'}` });
      renderMods();
    }
  }, 30000);
}

init();

// ── Mouse-following tooltip engine ───────────────────────────────────────────
(function initTooltip() {
  const tip = document.createElement('div');
  tip.id = 'app-tooltip';
  document.body.appendChild(tip);

  // SVG connector line
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'tooltip-connector-svg';
  document.body.appendChild(svg);
  const connLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  connLine.id = 'tooltip-connector-line';
  svg.appendChild(connLine);

  let activeCard = null;

  function showAboveDot(text, dot) {
    tip.textContent = text;
    tip.classList.add('visible');
    requestAnimationFrame(() => {
      const dr  = dot.getBoundingClientRect();
      const tw  = tip.offsetWidth;
      const th  = tip.offsetHeight;
      const gap = 18;

      const dotCX = dr.left + dr.width  / 2;
      const dotCY = dr.top  + dr.height / 2;

      // Centralizado acima da bolinha
      let left = dotCX - tw / 2;
      let top  = dotCY - th - gap;

      const margin = 6;
      left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
      // Flipa para baixo se não couber no topo
      const flipped = top < margin;
      if (flipped) top = dotCY + dr.height + gap;

      tip.style.left = left + 'px';
      tip.style.top  = top  + 'px';

      // Linha: parte da borda da bolinha (não do centro) até a borda do tooltip
      const tipCX = left + tw / 2;
      const tipCY = flipped ? top : top + th;

      // Vetor do centro do dot até o tooltip
      const dx = tipCX - dotCX;
      const dy = tipCY - dotCY;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const dotRadius = dr.width / 2;

      // Ponto na borda do dot na direção do tooltip
      const startX = dotCX + (dx / dist) * dotRadius;
      const startY = dotCY + (dy / dist) * dotRadius;

      connLine.setAttribute('x1', String(startX));
      connLine.setAttribute('y1', String(startY));
      connLine.setAttribute('x2', String(tipCX));
      connLine.setAttribute('y2', String(tipCY));
      connLine.classList.add('visible');
    });
  }

  function hide() {
    tip.classList.remove('visible');
    connLine.classList.remove('visible');
    activeCard = null;
  }

  // Returns { text, dot } — dot é a bolinha usada para posicionamento
  function resolveTooltip(el) {
    const direct = el.closest('[data-tooltip]');
    if (direct) {
      const isDot = direct.classList.contains('gallery-status-dot');
      return { text: direct.dataset.tooltip, dot: direct, anchor: isDot ? direct.closest('.gallery-card') || direct : direct };
    }
    const card = el.closest('.gallery-card');
    if (card) {
      const dot = card.querySelector('.gallery-status-dot[data-tooltip]');
      if (dot) return { text: dot.dataset.tooltip, dot, anchor: card };
    }
    return null;
  }

  document.addEventListener('mouseover', (e) => {
    if (e.target === tip) return;
    const resolved = resolveTooltip(e.target);
    if (!resolved) { hide(); return; }
    const card = e.target.closest('.gallery-card');
    // Só ignora se for o mesmo card E o elemento não tem data-tooltip próprio
    if (activeCard && activeCard === card && !e.target.closest('[data-tooltip]')) return;
    activeCard = card || resolved.anchor;
    showAboveDot(resolved.text, resolved.dot);
  });

  document.addEventListener('mouseout', (e) => {
    if (!activeCard) return;
    const related = e.relatedTarget;
    if (related && activeCard.contains(related)) return;
    hide();
  });

  document.addEventListener('mousedown', () => hide());
})();
