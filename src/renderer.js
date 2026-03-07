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
};

// Prevents runStartupChecks() from being called more than once per session
let _startupChecksRan = false;

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
  bar._timer = setTimeout(() => bar.classList.add('hidden'), 6000);
  document.getElementById('undo-btn').addEventListener('click', () => {
    const op = state.undoStack.pop();
    if (op) { op.undoFn(); toast('Operação desfeita', 'info'); }
    bar.classList.add('hidden');
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
        ${!isGrid ? `
        <button class="btn btn-secondary" id="btn-consolidate-list" title="Consolidar grupos com arquivos em pastas diferentes">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="8 17 12 21 16 17"/><line x1="12" y1="3" x2="12" y2="21"/>
          </svg>
          Consolidar
        </button>` : ''}
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
        <button class="chip ${state.filterStatus === 'all'    ? 'chip-on' : ''}" data-fs="all">Todos</button>
        <button class="chip ${state.filterStatus === 'active' ? 'chip-on' : ''}" data-fs="active">
          <span class="chip-dot chip-dot-green"></span>Ativos
        </button>
        <button class="chip ${state.filterStatus === 'inactive' ? 'chip-on' : ''}" data-fs="inactive">
          <span class="chip-dot chip-dot-dim"></span>Inativos
        </button>
        <button class="chip ${state.filterStatus === 'partial' ? 'chip-on' : ''}" data-fs="partial"
          title="Grupos onde apenas alguns arquivos estão ativos">
          <span class="chip-dot chip-dot-partial"></span>Parciais
        </button>
      </div>

      <!-- Type chips -->
      <div class="chip-group">
        <button class="chip ${state.filterType === 'all'     ? 'chip-on' : ''}" data-ft="all">
          <span class="chip-pill">${total}</span>Qualquer
        </button>
        <button class="chip ${state.filterType === 'package' ? 'chip-on' : ''}" data-ft="package">
          <span class="chip-pill chip-pill-pkg">${pkgCount}</span>.package
        </button>
        <button class="chip ${state.filterType === 'script'  ? 'chip-on' : ''}" data-ft="script">
          <span class="chip-pill chip-pill-scr">${scriptCount}</span>Script
        </button>
        <button class="chip ${state.filterType === 'tray'    ? 'chip-on' : ''}" data-ft="tray">
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
      <span>Arraste arquivos (.package, .ts4script, .trayitem, .blueprint, .bpi, .hhi, .sgi, .householdbinary, .room, .rmi, .zip, .rar, .7z) para importar</span>
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
    ${totalPages > 1 ? renderPagination(state.galleryPage, totalPages, allFiltered.length) : ''}

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
 * Extracts the prefix from a mod filename (everything before the first "_").
 * Returns null if there's no underscore or the prefix is too short (< 2 chars).
 */
function getModPrefix(name) {
  const base = name.replace(/\.(disabled)$/i, '').replace(/\.[^.]+$/, '');
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
             data-path="${escapeHtml(mod.path)}" draggable="false">
          <input type="checkbox" class="card-check" data-path="${escapeHtml(mod.path)}" ${sel ? 'checked' : ''}>
          <span class="card-type-tag ${typeClass}">${typeLabel}</span>
          ${thumbHtml}
          <div class="gallery-info">
            <div class="gallery-name" title="${escapeHtml(mod.name)}">${escapeHtml(mod.name)}</div>
            <div class="gallery-meta">
              <span>${formatBytes(mod.size)}</span>
              <span class="gallery-status-dot ${mod.enabled ? 'dot-active' : 'dot-inactive'}"></span>
            </div>
          </div>
          <button class="card-toggle-btn" data-path="${escapeHtml(mod.path)}"
                  title="${mod.enabled ? 'Desativar mod' : 'Ativar mod'}">${mod.enabled ? '⏸' : '▶'}</button>
        </div>`;
    }).join('')}
  </div>`;
}

function renderGroupCard(group, groupKey, typeTag, typeClass, badgeClass, placeholderIcon, displayName) {
  const allPaths = group.files.map(f => f.path);
  const allSel = allPaths.every(p => state.selectedMods.has(p));
  const cached = state.thumbnailCache[thumbKey(group.path)];
  const canHaveThumb = group.type === 'package' || group.type === 'tray';
  const thumbHtml = (canHaveThumb && cached && cached !== THUMB_LOADING)
    ? `<img class="gallery-thumb" src="${cached}" alt="" loading="lazy">`
    : (cached === null || !canHaveThumb)
      ? `<div class="gallery-thumb-placeholder">${placeholderIcon}</div>`
      : `<div class="gallery-thumb-loading" data-load="${escapeHtml(group.path)}" data-cache-key="${escapeHtml(thumbKey(group.path))}"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div></div>`;

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

  return `
    <div class="group-card-wrapper" ${idAttr}="${escapeHtml(idVal)}">
      <div class="gallery-card ${cardClass} ${noneEnabled ? 'card-inactive' : ''}" ${idAttr}="${escapeHtml(idVal)}"
           draggable="false"
           title="Clique para selecionar · Clique direito para gerenciar os ${group.files.length} itens do grupo">
        <input type="checkbox" class="card-check ${checkClass}" ${idAttr}="${escapeHtml(idVal)}" ${allSel ? 'checked' : ''}>
        <span class="card-type-tag ${typeClass}">${typeTag}</span>
        <span class="${badgeClass}" title="${group.files.length} arquivos">${group.files.length}</span>
        ${thumbHtml}
        <div class="gallery-info">
          <div class="gallery-name" title="${escapeHtml(group.name)}">${escapeHtml(displayName)}</div>
          <div class="gallery-meta">
            <span>${formatBytes(group.size)}</span>
            <span class="gallery-status-dot ${statusDotClass}"></span>
          </div>
        </div>
        <button class="card-toggle-btn card-toggle-group-btn" ${idAttr}="${escapeHtml(idVal)}"
                title="${toggleTitle}">${toggleLabel}</button>
      </div>
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

  // Consolidar grupos (list mode only)
  el.querySelector('#btn-consolidate-list')?.addEventListener('click', async () => {
    if (!state.config?.modsFolder) { toast('Configure a pasta Mods primeiro', 'warning'); return; }
    const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
    const scattered = allGrouped.filter(g => (g._isTrayGroup || g._isModGroup) && new Set(g.files.map(f => f.folder)).size > 1);
    if (!scattered.length) { toast('Nenhum grupo com arquivos dispersos encontrado', 'info'); return; }
    const totalFiles = scattered.reduce((s, g) => s + g.files.filter(f => f.folder !== g.files[0].folder).length, 0);
    openModal(
      'Consolidar Grupos Dispersos',
      `<p>Mover <strong>${totalFiles} arquivo(s)</strong> para reorganizar <strong>${scattered.length} grupo(s)</strong> com arquivos em pastas diferentes?</p>
       <p style="font-size:12.5px;color:var(--text-secondary);margin-top:8px">Cada grupo será consolidado na pasta do seu arquivo principal.</p>`,
      [
        { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
        { label: `Consolidar ${scattered.length} grupo(s)`, cls: 'btn-primary', action: async () => {
          let totalMoved = 0;
          for (const group of scattered) {
            const primaryFolder = group.files[0].folder;
            for (const f of group.files.filter(fi => fi.folder !== primaryFolder)) {
              const dest = (state.config.modsFolder + (primaryFolder === '/' ? '' : '\\' + primaryFolder) + '\\' + f.name);
              const r = await window.api.moveMod(f.path, dest);
              if (r.success) totalMoved++;
            }
          }
          await loadMods(); renderMods();
          toast(`${totalMoved} arquivo(s) consolidados`, 'success');
          logAction('consolidate', { count: totalMoved, groups: scattered.length });
        }}
      ]
    );
  });

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

      // Primary: get paths directly from File objects (most reliable in Electron)
      const directFiles = [...(e.dataTransfer.files || [])];
      if (directFiles.length > 0) {
        paths = directFiles.map(f => window.api.getPathForFile(f)).filter(Boolean);
      }

      // Fallback: use FileSystem API to recurse into dropped folders
      if (!paths.length && e.dataTransfer.items) {
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
          toast(`${deleted} mod(s) movidos para a lixeira${failed ? `, ${failed} com erro` : ''}`, failed ? 'warning' : 'success');
          if (deleted > 0) {
            const trashed = results.filter(r => r.success);
            pushUndo(`Excluir ${deleted} mod(s)`, async () => {
              for (const r of trashed) await window.api.restoreModFromTrash(r.trashPath, r.originalPath);
              await loadMods(); renderMods();
              toast(`${trashed.length} mod(s) restaurados`, 'success');
              logAction('restore', { count: trashed.length, source: 'batch', label: 'Restaurar exclusão em lote' });
            }, 'delete', { count: deleted, source: 'batch' });
          }
        }}
      ]
    );
  });
}

function refreshSelBar(el) {
  const bar = el.querySelector('#sel-bar');
  if (!bar) return;
  const n = state.selectedMods.size;
  bar.classList.toggle('sel-bar-show', n > 0);
  const cEl = bar.querySelector('#sel-bar-count');
  if (cEl) cEl.textContent = `${n} selecionado${n !== 1 ? 's' : ''}`;
}

// ─── Group Overlay ────────────────────────────────────────────────────────────

/**
 * Opens a modal overlay showing all files inside a group (tray or mod-prefix).
 * Allows toggling individual files, and consolidating them to one folder when needed.
 */
function openGroupOverlay(group) {
  const isTray = group._isTrayGroup;
  const displayTitle = isTray
    ? (group.name.replace(/^[0-9a-fx]+![0-9a-fx]+\./i, '').replace(/\.trayitem$/i, '') || group.name)
    : (group.modPrefix || group.name);

  // Check whether files span multiple folders
  const folders = [...new Set(group.files.map(f => f.folder))];
  const multiFolder = folders.length > 1;
  const primaryFolder = group.files[0].folder;

  // Check organize rules before showing consolidate button:
  // - ts4script files can only be at root or 1 level deep in Mods
  const canConsolidate = multiFolder && group.files.every(f => {
    if (f.type === 'script') return primaryFolder === '/' || (primaryFolder.split(/[/\\]/).length <= 1);
    return true;
  });

  const filesHtml = group.files.map(f => {
    const fTypeLabel = f.type === 'package' ? '.pkg' : f.type === 'script' ? '.ts4' : 'tray';
    const fTypeClass = f.type === 'package' ? 'card-tag-pkg' : f.type === 'script' ? 'card-tag-scr' : 'card-tag-tray';
    return `
      <div class="group-overlay-row" data-path="${escapeHtml(f.path)}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:var(--r-sm);background:var(--surface-2);margin-bottom:6px;cursor:pointer">
        <span class="card-type-tag ${fTypeClass}" style="flex-shrink:0">${fTypeLabel}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary)">${escapeHtml(f.name)}</div>
          <div style="font-size:11px;color:var(--text-disabled);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(f.folder === '/' ? '(raiz)' : f.folder)}</div>
        </div>
        <span style="font-size:11.5px;color:var(--text-secondary);flex-shrink:0">${formatBytes(f.size)}</span>
        <span class="badge ${f.enabled ? 'badge-active' : 'badge-inactive'}" style="flex-shrink:0">${f.enabled ? 'Ativo' : 'Inativo'}</span>
      </div>`;
  }).join('');

  const consolidateHtml = canConsolidate ? `
    <div style="margin-bottom:12px;padding:10px 12px;background:var(--warning-subtle);border:1px solid rgba(240,173,78,0.3);border-radius:var(--r-sm);display:flex;align-items:center;justify-content:space-between;gap:12px">
      <span style="font-size:12.5px;color:var(--warning)">📁 Arquivos em pastas diferentes — deseja movê-los para a mesma pasta?</span>
      <button class="btn btn-sm btn-secondary" id="btn-consolidate-group" style="flex-shrink:0">Consolidar</button>
    </div>` : '';

  const bodyHtml = `
    <div style="max-height:420px;overflow-y:auto">
      ${multiFolder && !canConsolidate ? `<div style="margin-bottom:10px;font-size:12px;color:var(--text-disabled)">ℹ️ Arquivos em pastas diferentes (consolidação não disponível para este grupo)</div>` : ''}
      ${consolidateHtml}
      ${filesHtml}
    </div>`;

  openModal(`Grupo: ${displayTitle} (${group.files.length} arquivos)`, bodyHtml, [
    { label: 'Fechar', cls: 'btn-secondary', action: () => {} }
  ]);

  // Right-click context menu on group modal rows — includes "Excluir" option
  document.querySelectorAll('.group-overlay-row').forEach(row => {
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      const fp = row.dataset.path;
      showCtxMenu(e.clientX, e.clientY, fp, {
        onDelete: async (filePath) => {
          const allMods = [...state.mods, ...state.trayFiles];
          const f = allMods.find(m => m.path === filePath);
          const name = f?.name || filePath.split('\\').pop();
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
                  toast(`"${name}" movido para a lixeira`, 'success');
                  pushUndo(`Excluir ${name}`, async () => {
                    await window.api.restoreModFromTrash(trashPath, originalPath);
                    await loadMods(); renderMods();
                    toast('Mod restaurado', 'success');
                    logAction('restore', { name, label: `Restaurar ${name}` });
                  }, 'delete', { name, source: 'group-overlay' });
                } else toast('Erro ao excluir: ' + (results[0]?.error || ''), 'error');
              }}
            ]
          );
        }
      });
    });
  });

  // Wire toggle on row click
  document.querySelectorAll('.group-overlay-row').forEach(row => {
    row.addEventListener('click', async () => {
      const fp = row.dataset.path;
      const result = await window.api.toggleMod(fp);
      if (result.success) {
        // Atualiza o data-path para o novo caminho (ex: .package → .package.disabled)
        // sem isso o segundo clique usa o caminho antigo que já não existe no disco
        row.dataset.path = result.newPath;
        await loadMods();
        // Refresh the badge inside the row
        const f = [...state.mods, ...state.trayFiles].find(m => m.path === result.newPath || m.path === result.oldPath);
        if (f) {
          const badge = row.querySelector('.badge');
          if (badge) { badge.className = `badge ${f.enabled ? 'badge-active' : 'badge-inactive'}`; badge.textContent = f.enabled ? 'Ativo' : 'Inativo'; }
        }
        renderMods();
      } else { toast('Erro ao alternar mod', 'error'); }
    });
  });

  // Consolidate button
  document.getElementById('btn-consolidate-group')?.addEventListener('click', async () => {
    const cfg = state.config;
    if (!cfg?.modsFolder) { toast('Configure a pasta Mods primeiro', 'warning'); return; }

    const targetFolder = group.files[0].folder === '/' ? cfg.modsFolder : `${cfg.modsFolder}\\${group.files[0].folder}`;
    const toMove = group.files.filter(f => f.folder !== group.files[0].folder);
    let moved = 0;
    for (const f of toMove) {
      const dest = `${targetFolder}\\${f.name}`;
      const r = await window.api.moveMod(f.path, dest);
      if (r.success) moved++;
    }
    await loadMods(); renderMods();
    closeModal();
    toast(`${moved} arquivo(s) movidos para a mesma pasta`, 'success');
  });
}

// ─── Rubber Band Selection ────────────────────────────────────────────────────

let _rubberBand = { active: false, startX: 0, startY: 0, rect: null, didSelect: false };

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

  // Create (or reuse) the rubber band rect, appended to the scroll element so it
  // stays correctly positioned during scroll.
  function ensureRect() {
    if (!_rubberBand.rect || !_rubberBand.rect.isConnected) {
      _rubberBand.rect = document.createElement('div');
      _rubberBand.rect.className = 'rubber-band-rect';
      const scrollEl = getScrollEl();
      scrollEl.style.position = 'relative'; // ensure positioned ancestor
      scrollEl.appendChild(_rubberBand.rect);
    }
  }

  container.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.gallery-sort-bar') || e.target.closest('.sel-bar')) return;
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

    const onMove = ev => {
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
        _rubberBand.didSelect = false;

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

      const x = Math.min(curX, _rubberBand.startX);
      const y = Math.min(curY, _rubberBand.startY);
      const w = Math.abs(curX - _rubberBand.startX);
      const h = Math.abs(curY - _rubberBand.startY);
      if (_rubberBand.rect) _rubberBand.rect.style.cssText = `display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    };

    const onUp = ev => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

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

  // Card click on group → LEFT CLICK = select/deselect, RIGHT CLICK = open overlay
  el.querySelectorAll('.gallery-card.mod-group, .gallery-card.tray-group').forEach(card => {
    // Left click → select
    card.addEventListener('click', e => {
      if (e.target.classList.contains('card-check') || e.target.classList.contains('card-check-group') || e.target.classList.contains('card-check-mod-group')) return;
      if (e.target.closest('.card-toggle-group-btn')) return;
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
    // Right click → open group management overlay
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
      if (e.target.classList.contains('card-check') || e.target.closest('.card-toggle-btn')) return;
      const p = card.dataset.path;
      if (!p) return;
      const isSelected = state.selectedMods.has(p);
      if (e.ctrlKey || e.metaKey) {
        // Multi-select: toggle just this one
        isSelected ? state.selectedMods.delete(p) : state.selectedMods.add(p);
      } else {
        // Plain click: toggle this card
        isSelected ? state.selectedMods.delete(p) : state.selectedMods.add(p);
      }
      card.classList.toggle('selected', state.selectedMods.has(p));
      const cb = card.querySelector('.card-check');
      if (cb) cb.checked = state.selectedMods.has(p);
      refreshSelBar(el);
    });
  });

  // Card toggle button → enable/disable individual mod
  el.querySelectorAll('.card-toggle-btn:not(.card-toggle-group-btn)').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const result = await window.api.toggleMod(btn.dataset.path);
      if (result.success) {
        await loadMods(); renderMods();
        const allMods = [...state.mods, ...state.trayFiles];
        const mod = allMods.find(m => m.path === result.newPath);
        const nowEnabled = mod?.enabled ?? false;
        const modName = mod?.name || result.newPath.split('\\').pop();
        const toggleAgain = async () => { await window.api.toggleMod(result.newPath); await loadMods(); renderMods(); };
        pushUndo(`${nowEnabled ? 'Ativar' : 'Desativar'} ${modName}`,
          toggleAgain,
          nowEnabled ? 'toggle_on' : 'toggle_off', { name: modName },
          toggleAgain);
      } else toast('Erro ao alternar mod', 'error');
    });
  });

  // Card toggle button → enable/disable all files in a group
  el.querySelectorAll('.card-toggle-group-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const allGrouped = groupModsByPrefix(groupTrayFiles([...state.mods, ...state.trayFiles]));
      const group = btn.dataset.trayGuid
        ? allGrouped.find(g => g._isTrayGroup && g.trayGuid === btn.dataset.trayGuid)
        : allGrouped.find(g => g._isModGroup  && g.modPrefix === btn.dataset.modPrefix);
      if (!group) return;
      try {
        const allEnabled = group.files.every(f => f.enabled);
        const prevPaths = group.files
          .filter(f => allEnabled ? f.enabled : !f.enabled)
          .map(f => f.path);
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
  const loaders = el.querySelectorAll('[data-load]');

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
    if (state.thumbnailCache[cacheKey] !== undefined) continue;
    state.thumbnailCache[cacheKey] = THUMB_LOADING;
    toLoad.push({ filePath, cacheKey });
  }

  // Load all thumbnails in PARALLEL so that a slow file doesn't block the
  // rest, and so that a new renderMods() call mid-loop doesn't leave items
  // permanently stuck as THUMB_LOADING without anyone awaiting their result.
  await Promise.all(toLoad.map(async ({ filePath, cacheKey }) => {
    const thumb = await window.api.getThumbnail(filePath);
    state.thumbnailCache[cacheKey] = thumb ?? null;

    // Update DOM in place without a full re-render
    const stillThere = el.querySelector(`[data-load="${CSS.escape(filePath)}"]`);
    if (!stillThere) return;

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
      const modEntry = [...state.mods, ...state.trayFiles].find(m => thumbKey(m.path) === cacheKey);
      ph.textContent = modEntry ? fileIcon(modEntry.type) : '📦';
      stillThere.replaceWith(ph);
    }
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
          <span class="group-row-badge">${group.files.length} arquivos</span>

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
        const modName = mod?.name || result.newPath.split('\\').pop();
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
              toast('Mod movido para a lixeira', 'success');
              pushUndo(`Excluir ${name}`, async () => {
                await window.api.restoreModFromTrash(trashPath, originalPath);
                await loadMods(); renderMods();
                toast('Mod restaurado', 'success');
                logAction('restore', { name, label: `Restaurar ${name}` });
              }, 'delete', { name });
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
            toast(`${deleted} arquivo(s) movidos para lixeira${failed ? `, ${failed} com erro` : ''}`, failed ? 'warning' : 'success');
            if (deleted > 0) {
              const trashed = results.filter(r => r.success);
              pushUndo(`Excluir grupo ${group.name}`, async () => {
                for (const r of trashed) await window.api.restoreModFromTrash(r.trashPath, r.originalPath);
                await loadMods(); renderMods();
                toast(`${trashed.length} arquivo(s) restaurados`, 'success');
                logAction('restore', { count: trashed.length, name: group.name, label: `Restaurar grupo ${group.name}` });
              }, 'delete', { count: deleted, name: group.name, type: 'group' });
            }
          }}
        ]
      );
    });
  });

  // Rubber band selection in table
  const tableContainer = el.querySelector('#mods-table-container');
  if (tableContainer) {
    initRubberBand(tableContainer, () => tableContainer.querySelectorAll('tr[data-path]'));
    attachCtxMenu(tableContainer);
  }
}

// Recursively collects all File objects from a DataTransferItemList,
// descending into folders via the FileSystem API (webkitGetAsEntry).
async function collectDroppedFiles(items) {
  const files = [];

  function readEntry(entry) {
    return new Promise(resolve => {
      if (entry.isFile) {
        entry.file(f => { files.push(f); resolve(); }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () => {
          reader.readEntries(async entries => {
            if (!entries.length) return resolve();
            await Promise.all(entries.map(readEntry));
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

  const supported = filePaths.filter(p => SUPPORTED_EXTS.has(p.slice(p.lastIndexOf('.')).toLowerCase()));

  if (!supported.length) return;

  toast(`Importando ${supported.length} arquivo(s)...`, 'info', 2000);
  const result = await window.api.importFiles(supported, state.config.modsFolder, state.config.trayFolder);
  await loadMods();
  if (state.currentPage === 'mods') renderMods();
  if (state.currentPage === 'dashboard') renderDashboard();
  if (result.imported.length > 0) {
    toast(`${result.imported.length} arquivo(s) importado(s) com sucesso`, 'success');
    const importedPaths = result.imported; // array of destination paths
    pushUndo(`Importar ${result.imported.length} arquivo(s)`, async () => {
      const trashResults = await window.api.trashModsBatch(importedPaths);
      const ok = trashResults.filter(r => r.success).length;
      await loadMods();
      if (state.currentPage === 'mods') renderMods();
      if (state.currentPage === 'dashboard') renderDashboard();
      toast(`${ok} arquivo(s) importado(s) removido(s)`, 'info');
    }, 'import', { count: result.imported.length });
  }
  if (result.errors.length > 0) {
    toast(`${result.errors.length} arquivo(s) com erro ao importar`, 'error');
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
    logAction('scan', { count: result.length, source: 'conflicts',
      label: result.length ? `${result.length} conflito(s) encontrado(s)` : 'Nenhum conflito encontrado' });
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
      const fileName = filePath.split('\\').pop() || filePath.split('/').pop();
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
            }, 'delete', { name: fileName, source: 'conflicts' });
          }}
        ]
      );
    });
  });

  el.querySelector('#btn-dismiss-all')?.addEventListener('click', () => {
    const count = state.conflicts.length;
    state.conflicts = [];
    renderConflictResults(el);
    if (count > 0) logAction('scan', { count: 0, source: 'conflicts',
      label: `${count} conflito(s) dispensado(s) manualmente` });
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
      <div class="card-title">Regras do The Sims 4</div>
      <div class="notice info">
        <div>
          <strong>.ts4script</strong> — máximo 1 nível de subpasta dentro da pasta Mods.<br>
          <strong>.package</strong> — pode ir até 5 níveis de profundidade.<br>
          <strong>Arquivos de Tray</strong> (.trayitem, .blueprint, etc.) — devem estar na pasta Tray, não em Mods.<br>
          <strong>Pastas vazias</strong> — subpastas sem nenhum arquivo dentro (incluindo subpastas aninhadas).
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
    logAction('scan', { count: totalIssues, source: 'organizer',
      label: totalIssues ? `${totalIssues} problema(s) encontrado(s)` : 'Tudo organizado' });
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
          Grupos de mods com arquivos espalhados em pastas diferentes. Consolidar junta tudo na pasta principal do grupo.
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
                  <span style="margin-left:6px;color:var(--accent-light)">→ ${escapeHtml(group.targetFolder === '/' ? '(raiz)' : group.targetFolder)}</span>
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
      `<p>Mover <strong>${total} arquivo(s) inválido(s)</strong> para a lixeira do sistema?</p>
       <p style="font-size:12.5px;color:var(--text-secondary)">Você poderá restaurá-los pela lixeira do Windows se necessário.</p>`,
      [
        { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
        { label: `Mover ${total} para Lixeira`, cls: 'btn-danger', action: async () => {
          const paths = state.invalidFiles.map(f => f.path);
          const results = await window.api.deleteInvalidFiles(paths);
          const ok = results.filter(r => r.success).length;
          state.invalidFiles = state.invalidFiles.filter((_, i) => !results[i]?.success);
          renderOrganizeResults(el);
          toast(`${ok} arquivo(s) movidos para a lixeira`, ok < total ? 'warning' : 'success');
          if (ok > 0) logAction('delete', { count: ok, source: 'invalid-files' });
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
        state.invalidFiles.splice(idx, 1);
        renderOrganizeResults(el);
        toast(`"${item.name}" movido para a lixeira`, 'success');
        logAction('delete', { name: item.name, source: 'invalid-files' });
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
  });

  el.querySelectorAll('.fix-one-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index);
      const item = state.misplaced[idx];
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
      }
    });
  });

  // ── Scattered groups event handlers ──────────────────────────────────────
  async function consolidateGroup(group) {
    let moved = 0;
    const toMove = group.files.filter(f => f.folder !== group.targetFolder);
    for (const f of toMove) {
      // Determina destino: targetFolderAbs + nome do arquivo
      const destPath = group.targetFolderAbs + (group.targetFolderAbs.endsWith('\\') || group.targetFolderAbs.endsWith('/') ? '' : '\\') + f.name;
      const result = await window.api.moveMod(f.path, destPath);
      if (result.success) moved++;
    }
    await loadMods();
    return moved;
  }

  el.querySelectorAll('.consolidate-one-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index);
      const group = state.scattered[idx];
      openModal(
        `Consolidar grupo "${group.prefix}"`,
        `<p>Mover <strong>${group.files.filter(f => f.folder !== group.targetFolder).length} arquivo(s)</strong> para a pasta <strong>${escapeHtml(group.targetFolder === '/' ? '(raiz)' : group.targetFolder)}</strong>?</p>`,
        [
          { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
          { label: 'Consolidar', cls: 'btn-primary', action: async () => {
            const moved = await consolidateGroup(group);
            if (moved > 0) {
              state.scattered.splice(idx, 1);
              renderOrganizeResults(el);
              toast(`${moved} arquivo(s) consolidados`, 'success');
              logAction('consolidate', { count: moved, name: group.prefix });
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
    const total = state.scattered.reduce((s, g) => s + g.files.filter(f => f.folder !== g.targetFolder).length, 0);
    openModal(
      'Consolidar Todos os Grupos',
      `<p>Mover <strong>${total} arquivo(s)</strong> para reorganizar <strong>${state.scattered.length} grupo(s)</strong> dispersos?</p>`,
      [
        { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
        { label: `Consolidar ${state.scattered.length} grupos`, cls: 'btn-primary', action: async () => {
          let totalMoved = 0;
          for (const group of state.scattered) {
            totalMoved += await consolidateGroup(group);
          }
          state.scattered = [];
          renderOrganizeResults(el);
          toast(`${totalMoved} arquivo(s) consolidados com sucesso`, 'success');
          logAction('consolidate', { count: totalMoved, groups: state.scattered.length + totalMoved });
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
            pushUndo(`Apagar ${ok} pasta(s) vazia(s)`, async () => {
              toast('Pastas vazias não podem ser restauradas automaticamente', 'info', 3500);
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
              pushUndo(`Apagar pasta ${folder.name}`, async () => {
                toast('Pastas vazias não podem ser restauradas automaticamente', 'info', 3500);
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
  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Manual</div>
        <div class="page-subtitle">Guia dos recursos não intuitivos do gerenciador</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">🖱️ Modo Grade — Interações com o Mouse</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        <strong style="color:var(--text-primary)">Cards individuais</strong><br>
        · <strong>Clique esquerdo</strong> — seleciona/deseleciona o card<br>
        · <strong>Clique direito</strong> — abre o menu de contexto (abrir pasta)<br>
        · <strong>Botão ▶ / ⏸</strong> — ativa ou desativa o mod (registra no Histórico e permite Desfazer)<br><br>
        <strong style="color:var(--text-primary)">Cards de grupo</strong><br>
        · <strong>Clique esquerdo</strong> — seleciona/deseleciona todos os arquivos do grupo<br>
        · <strong>Clique direito</strong> — abre a janela de gerenciamento do grupo (visualizar, alternar e excluir arquivos individuais)<br>
        · <strong>Botão ▶ / ⏸</strong> — ativa ou desativa todo o grupo (registra no Histórico e permite Desfazer)<br>
        · <strong>Arrastar sobre a grade</strong> — seleção por área (rubber band selection)
      </div>
    </div>

    <div class="card">
      <div class="card-title">⏮️ Sistema de Desfazer (Undo)</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        A barra de desfazer aparece na parte inferior da tela após ações reversíveis:<br>
        · Ativar / desativar mods (inclusive via botões Play ▶ e Pause ⏸)<br>
        · Exclusão de arquivos (mods individuais e grupos)<br>
        · Organização automática (mover arquivos)<br><br>
        Clique em <strong>↩ Desfazer</strong> dentro de 6 segundos para reverter a última ação, ou em <strong>✕</strong> para dispensar.
      </div>
    </div>

    <div class="card">
      <div class="card-title">📦 Grupos de Mods</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        Mods são agrupados automaticamente quando dois ou mais arquivos compartilham o mesmo prefixo de nome (tudo antes do primeiro <code>_</code>).<br><br>
        <strong style="color:var(--text-primary)">Exemplo:</strong><br>
        · <code>TURBO_careers.package</code><br>
        · <code>TURBO_careers_EP01.package</code><br>
        → Agrupados sob o grupo <em>turbo</em><br><br>
        Arquivos de Tray são agrupados pelo GUID (código hexadecimal após o <code>!</code> no nome).<br><br>
        <strong style="color:var(--text-primary)">Janela de gerenciamento do grupo</strong> (clique direito no card ou em "Ver detalhes"):<br>
        · Ativa/desativa arquivos individualmente com um clique<br>
        · Oferece opção de <strong>Consolidar</strong> se os arquivos estiverem em pastas diferentes<br>
        · Menu de contexto (botão direito) em cada linha do grupo para excluir arquivos individualmente
      </div>
    </div>

    <div class="card">
      <div class="card-title">🔄 Sincronização em Tempo Real</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        O gerenciador detecta alterações externas nos arquivos (edições feitas por outro programa ou pelo Windows Explorer):<br>
        · Ao volcar o foco para a janela após estar em segundo plano<br>
        · Periodicamente a cada 30 segundos enquanto a aba Mods estiver aberta<br><br>
        Quando uma mudança é detectada, a lista é recarregada automaticamente. Ações que causaram o reload ficam registradas na aba <strong>Histórico</strong>.
      </div>
    </div>

    <div class="card">
      <div class="card-title">📁 Consolidar Grupos Dispersos</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        Um grupo "disperso" é aquele cujos arquivos estão distribuídos em pastas diferentes dentro da pasta Mods.<br><br>
        <strong style="color:var(--text-primary)">Formas de consolidar:</strong><br>
        · <strong>Modo Lista →</strong> botão <em>Consolidar</em> no cabeçalho de ações<br>
        · <strong>Janela do grupo →</strong> botão <em>Consolidar</em> na barra de aviso interna<br>
        · <strong>Aba Organizar →</strong> seção "Grupos dispersos"<br><br>
        A consolidação move os arquivos para a pasta do arquivo principal do grupo. Esta ação suporta Desfazer.
      </div>
    </div>

    <div class="card">
      <div class="card-title">🔍 Filtros Avançados</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        <strong style="color:var(--text-primary)">Filtro "Parciais"</strong> — exibe somente grupos onde alguns arquivos estão ativos e outros inativos. Útil para identificar grupos com configuração inconsistente.<br><br>
        <strong style="color:var(--text-primary)">Filtro de pasta</strong> — filtra mods por subpasta dentro da pasta Mods.<br><br>
        <strong style="color:var(--text-primary)">Formatos suportados na importação:</strong><br>
        <code>.package</code> · <code>.ts4script</code> · <code>.trayitem</code> · <code>.blueprint</code> · <code>.bpi</code> · <code>.hhi</code> · <code>.sgi</code> · <code>.householdbinary</code> · <code>.room</code> · <code>.rmi</code> · <code>.zip</code> · <code>.rar</code> · <code>.7z</code>
      </div>
    </div>
  `;
}

// ─── History Page ─────────────────────────────────────────────────────────────

function renderHistory() {
  const el = document.getElementById('page-history');

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
              <th style="width:155px"><div class="th-content">Horário</div></th>
              <th style="width:115px"><div class="th-content">Ação</div></th>
              <th><div class="th-content">Detalhes</div></th>
              <th style="width:195px"><div class="th-content" style="justify-content:center">Ações</div></th>
            </tr>
          </thead>
          <tbody>
            ${state.actionLog.map((entry, idx) => {
              const meta    = TYPE_META[entry.type] || TYPE_META.action;
              const detail  = buildDetail(entry);
              const canUndo = entry.undoFn && !entry.undone;
              const canRedo = entry.undone  && entry.redoFn;
              const navPage = getNavPage(entry);
              const undoneRow = entry.undone ? 'history-row-undone' : '';

              const navBtn = navPage
                ? `<button class="btn btn-sm btn-subtle history-nav-btn" data-page="${navPage}" data-history-idx="${idx}"
                     title="Ir para aba ${escapeHtml(PAGE_LABELS[navPage] || navPage)}">
                     → ${escapeHtml(PAGE_LABELS[navPage] || navPage)}
                   </button>`
                : '';

              const actionBtn = canRedo
                ? `<button class="btn btn-sm btn-primary history-redo-btn" data-history-idx="${idx}"
                     title="Refazer esta ação">↺ Refazer</button>`
                : canUndo
                  ? `<button class="btn btn-sm btn-secondary history-undo-btn" data-history-idx="${idx}"
                       title="${escapeHtml(entry.details?.label || 'Desfazer esta ação')}">↩ Desfazer</button>`
                  : entry.undone
                    ? `<span style="font-size:11px;color:var(--text-disabled)">desfeito</span>`
                    : `<span style="font-size:11px;color:var(--text-disabled)">—</span>`;

              return `
                <tr class="${undoneRow}" data-history-idx="${idx}">
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

  // ── Navigate to related page
  el.querySelectorAll('.history-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      if (!page) return;
      state.currentPage = page;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
      document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
      const renderers = { dashboard, mods: renderMods, conflicts: renderConflicts,
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

  const SOURCE_LABEL = { mods: 'Mods', conflicts: 'Conflitos', unknown: '—' };
  const pad = n => String(n).padStart(2, '0');
  const formatDate = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  container.innerHTML = `
    <div class="table-container">
      <table id="trash-table">
        <thead>
          <tr>
            <th><div class="th-content">Nome</div></th>
            <th style="width:90px"><div class="th-content">Origem</div></th>
            <th style="width:140px"><div class="th-content">Excluído em</div></th>
            <th style="width:80px"><div class="th-content">Tamanho</div></th>
            <th style="width:190px"><div class="th-content" style="justify-content:center">Ações</div></th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item, idx) => `
            <tr data-trash-idx="${idx}">
              <td>
                <div class="cell-name" title="${escapeHtml(item.originalPath || item.trashPath)}">
                  <span class="file-icon">${fileIcon(item.name.endsWith('.package') ? 'package' : item.name.endsWith('.ts4script') ? 'script' : 'tray')}</span>
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
                  <button class="btn btn-sm btn-danger trash-delete-btn" data-trash-idx="${idx}" title="Apagar permanentemente (envia para Lixeira do sistema)">
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

  // ── Restore individual
  container.querySelectorAll('.trash-restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const item = items[parseInt(btn.dataset.trashIdx)];
      if (!item?.originalPath) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        const result = await window.api.trashRestore(item.trashPath, item.originalPath);
        if (result.success) {
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
      const item = items[parseInt(btn.dataset.trashIdx)];
      openModal('Excluir permanentemente',
        `<p>Enviar <strong>${escapeHtml(item.name)}</strong> para a lixeira do sistema?</p>
         <p style="font-size:12.5px;color:var(--text-secondary)">Esta ação não pode ser desfeita pelo gerenciador.</p>`,
        [
          { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
          { label: 'Excluir permanentemente', cls: 'btn-danger', action: async () => {
            try {
              const result = await window.api.trashDeletePermanent(item.trashPath);
              if (result.success) {
                toast(`"${item.name}" enviado para a lixeira do sistema`, 'info');
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
          let ok = 0;
          try {
            for (const item of restorable) {
              const r = await window.api.trashRestore(item.trashPath, item.originalPath);
              if (r.success) ok++;
            }
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
      `<p>Enviar <strong>${items.length}</strong> item(ns) para a lixeira do sistema?</p>
       <p style="font-size:12.5px;color:var(--text-secondary)">Esta ação não pode ser desfeita pelo gerenciador.<br>Os arquivos ainda poderão ser recuperados pela Lixeira do Windows/macOS.</p>`,
      [
        { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
        { label: 'Esvaziar Lixeira', cls: 'btn-danger', action: async () => {
          const emptyBtn = el.querySelector('#btn-trash-empty');
          const restoreAllBtn = el.querySelector('#btn-trash-restore-all');
          if (emptyBtn) { emptyBtn.disabled = true; emptyBtn.textContent = 'Esvaziando…'; }
          if (restoreAllBtn) restoreAllBtn.disabled = true;
          try {
            const result = await window.api.trashEmpty();
            toast(`${result.ok} item(ns) enviado(s) para a lixeira do sistema${result.failed ? `, ${result.failed} com erro` : ''}`, result.failed ? 'warning' : 'success');
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
      <div class="card-title">Informações</div>
      <div class="settings-group">
        <div class="settings-item" style="flex-direction:column;align-items:flex-start;gap:8px">
          <div>
            <div class="settings-label">Regras de Subpastas do The Sims 4</div>
            <div class="settings-desc" style="margin-top:6px;line-height:1.7">
              • <strong>.package</strong> — até 5 níveis de subpasta<br>
              • <strong>.ts4script</strong> — máximo 1 nível de subpasta<br>
              • Arquivos de <strong>Tray</strong> — devem estar na pasta Tray, não em Mods<br>
              • Não crie uma pasta chamada "Mods" dentro da pasta Mods
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Sobre</div>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
        <strong style="color:var(--text-primary)">TS4 Mod Manager</strong> v1.1.0<br>
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
