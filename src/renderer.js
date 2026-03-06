'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

// FIX BUG 4: Sentinel symbol to mark thumbnails that are currently being loaded.
// Using Symbol ensures it can never equal undefined (key-not-present), null (no thumb), or a base64 string.
const THUMB_LOADING = Symbol('loading');

const state = {
  config: null,
  mods: [],
  trayFiles: [],
  conflicts: [],
  misplaced: [],
  currentPage: 'dashboard',
  selectedMods: new Set(),
  searchQuery: '',
  filterStatus: 'all',
  filterType: 'all',
  filterFolder: 'all',
  sortColumn: 'name',
  sortDir: 'asc',
  undoStack: [],
  scanning: false,
  conflictScanning: false,
  organizeScanning: false,
  // Gallery
  viewMode: 'grid',       // 'list' | 'grid' — FIX BUG 2: was 'list', thumbnails only show in grid mode
  galleryPage: 1,
  itemsPerPage: 24,
  thumbnailCache: {},     // path -> base64 | null
};

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

function statusBadge(enabled) {
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
    btn.addEventListener('click', () => { action(); closeModal(); });
    footer.appendChild(btn);
  });
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// ─── Undo System ─────────────────────────────────────────────────────────────

function pushUndo(label, undoFn) {
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

// ─── Column Resize ───────────────────────────────────────────────────────────

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
    settings: renderSettings
  };
  if (renderers[page]) renderers[page]();
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
      <div class="stat-card success">
        <div class="stat-label">Ativos</div>
        <div class="stat-value">${active}</div>
      </div>
      <div class="stat-card warning">
        <div class="stat-label">Inativos</div>
        <div class="stat-value">${inactive}</div>
      </div>
      <div class="stat-card info">
        <div class="stat-label">Pacotes (.package)</div>
        <div class="stat-value">${state.mods.filter(m => m.type === 'package').length}</div>
      </div>
      <div class="stat-card warning">
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

  // Auto-checks
  if (modsOk) runDashboardAutoChecks(el);
}

async function runDashboardAutoChecks(el) {
  const cfg = state.config;
  const alertsEl = el.querySelector('#dash-alerts');
  if (!alertsEl) return;

  const checkMisplaced = cfg?.autoCheckMisplaced !== false;
  const checkDuplicates = cfg?.autoCheckDuplicates === true;

  if (!checkMisplaced && !checkDuplicates) return;

  alertsEl.innerHTML = `<div class="loading-state" style="padding:12px 0;flex-direction:row;gap:10px;justify-content:flex-start">
    <div class="spinner" style="width:16px;height:16px;border-width:2px"></div>
    <span style="font-size:12.5px;color:var(--text-secondary)">Verificando problemas...</span>
  </div>`;

  const alerts = [];

  if (checkMisplaced) {
    try {
      const misplaced = await window.api.scanMisplaced(cfg.modsFolder, cfg.trayFolder);
      state.misplaced = misplaced; // salva no state para a página Organizar usar sem re-escanear
      if (misplaced.length > 0) {
        alerts.push({
          type: 'warning',
          icon: '📁',
          message: `${misplaced.length} arquivo(s) em locais incorretos`,
          action: 'organizer',
          actionLabel: 'Ver e corrigir'
        });
      }
    } catch (_) {}
  }

  if (checkDuplicates) {
    try {
      const conflicts = await window.api.scanConflicts(cfg.modsFolder);
      state.conflicts = conflicts; // salva no state para a página Conflitos usar sem re-escanear
      if (conflicts.length > 0) {
        alerts.push({
          type: 'danger',
          icon: '⚠️',
          message: `${conflicts.length} conflito(s) ou duplicata(s) detectado(s)`,
          action: 'conflicts',
          actionLabel: 'Ver conflitos'
        });
      }
    } catch (_) {}
  }

  if (!alertsEl.isConnected) return;

  if (alerts.length === 0) {
    alertsEl.innerHTML = `<div class="notice success" style="font-size:12.5px">✓ Nenhum problema encontrado</div>`;
    setTimeout(() => { if (alertsEl.isConnected) alertsEl.innerHTML = ''; }, 4000);
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

// ─── Mods Page ───────────────────────────────────────────────────────────────

function getFilteredMods() {
  let mods = [...state.mods, ...state.trayFiles];

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    mods = mods.filter(m => m.name.toLowerCase().includes(q));
  }
  if (state.filterStatus !== 'all') {
    const want = state.filterStatus === 'active';
    mods = mods.filter(m => m.enabled === want);
  }
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

  // Group tray files by GUID before pagination
  const allGrouped = groupTrayFiles(allFiltered);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(allGrouped.length / state.itemsPerPage));
  if (state.galleryPage > totalPages) state.galleryPage = totalPages;
  const start = (state.galleryPage - 1) * state.itemsPerPage;
  const mods = allGrouped.slice(start, start + state.itemsPerPage);

  const isGrid = state.viewMode === 'grid';

  const subtitle = total === 0
    ? 'Nenhum mod encontrado'
    : hasFilter
      ? `${allFiltered.length} de ${total} · ${activeCount} ativos`
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
        <button class="chip ${state.filterStatus === 'all'    ? 'chip-on' : ''}" data-fs="all">Todos</button>
        <button class="chip ${state.filterStatus === 'active' ? 'chip-on' : ''}" data-fs="active">
          <span class="chip-dot chip-dot-green"></span>Ativos
        </button>
        <button class="chip ${state.filterStatus === 'inactive' ? 'chip-on' : ''}" data-fs="inactive">
          <span class="chip-dot chip-dot-dim"></span>Inativos
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
          <select class="select-filter" id="items-per-page" style="width:auto;font-size:12px;padding:5px 26px 5px 8px">
            <option value="24" ${state.itemsPerPage===24?'selected':''}>24/pág</option>
            <option value="48" ${state.itemsPerPage===48?'selected':''}>48/pág</option>
            <option value="96" ${state.itemsPerPage===96?'selected':''}>96/pág</option>
          </select>
        ` : ''}
      </div>
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
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
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

  return `<div class="gallery-grid" id="gallery-grid">
    ${mods.map(mod => {
      if (mod._isTrayGroup) return renderTrayGroupCard(mod);

      const sel = state.selectedMods.has(mod.path);
      const cached = state.thumbnailCache[mod.path];
      const canHaveThumb = mod.type === 'package' || mod.type === 'tray';
      const thumbHtml = (cached && cached !== THUMB_LOADING)
        ? `<img class="gallery-thumb" src="${cached}" alt="" loading="lazy">`
        : (cached === null || !canHaveThumb)
          ? `<div class="gallery-thumb-placeholder">${fileIcon(mod.type)}</div>`
          : `<div class="gallery-thumb-loading" data-load="${escapeHtml(mod.path)}"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div></div>`;

      const typeLabel = mod.type === 'package' ? '.pkg' : mod.type === 'script' ? '.ts4' : 'tray';
      const typeClass = mod.type === 'package' ? 'card-tag-pkg' : mod.type === 'script' ? 'card-tag-scr' : 'card-tag-tray';

      return `
        <div class="gallery-card ${sel ? 'selected' : ''} ${!mod.enabled ? 'card-inactive' : ''}"
             data-path="${escapeHtml(mod.path)}">
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
        </div>`;
    }).join('')}
  </div>`;
}

function renderTrayGroupCard(group) {
  const allPaths = group.files.map(f => f.path);
  const allSel = allPaths.every(p => state.selectedMods.has(p));
  const cached = state.thumbnailCache[group.path];
  const canHaveThumb = true;
  const thumbHtml = (cached && cached !== THUMB_LOADING)
    ? `<img class="gallery-thumb" src="${cached}" alt="" loading="lazy">`
    : cached === null
      ? `<div class="gallery-thumb-placeholder">🏠</div>`
      : `<div class="gallery-thumb-loading" data-load="${escapeHtml(group.path)}"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div></div>`;

  // Strip GUID prefix from display name for cleaner label
  const displayName = group.name.replace(/^[0-9a-fx]+![0-9a-fx]+\./i, '').replace(/\.trayitem$/i, '') || group.name;

  return `
    <div class="gallery-card tray-group ${!group.enabled ? 'card-inactive' : ''}"
         data-tray-guid="${escapeHtml(group.trayGuid)}">
      <input type="checkbox" class="card-check card-check-group"
             data-tray-guid="${escapeHtml(group.trayGuid)}" ${allSel ? 'checked' : ''}>
      <span class="card-type-tag card-tag-tray">tray</span>
      <span class="tray-group-badge" title="${group.files.length} arquivos neste conjunto">${group.files.length}</span>
      ${thumbHtml}
      <div class="gallery-info">
        <div class="gallery-name" title="${escapeHtml(group.name)}">${escapeHtml(displayName)}</div>
        <div class="gallery-meta">
          <span>${formatBytes(group.size)}</span>
          <span class="gallery-status-dot ${group.enabled ? 'dot-active' : 'dot-inactive'}"></span>
        </div>
      </div>
    </div>`;
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

  // Items per page
  el.querySelector('#items-per-page')?.addEventListener('change', e => {
    state.itemsPerPage = parseInt(e.target.value); state.galleryPage = 1; renderMods();
  });

  // Pagination
  el.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => { state.galleryPage = parseInt(btn.dataset.page); renderMods(); });
  });
  el.querySelector('#page-prev')?.addEventListener('click', () => { if (state.galleryPage > 1) { state.galleryPage--; renderMods(); } });
  el.querySelector('#page-next')?.addEventListener('click', () => { state.galleryPage++; renderMods(); });

  // Drag-and-drop overlay
  const dz = el.querySelector('#drop-zone');
  if (dz) {
    let dragDepth = 0;
    el.addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth === 1) dz.classList.add('drop-overlay-show'); });
    el.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dz.classList.remove('drop-overlay-show'); } });
    el.addEventListener('dragover', e => e.preventDefault());
    el.addEventListener('drop', async e => {
      e.preventDefault(); dragDepth = 0; dz.classList.remove('drop-overlay-show');
      const files = [...e.dataTransfer.files].map(f => f.path);
      if (files.length) await doImport(files);
    });
    dz.addEventListener('click', importFiles);
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
      for (const p of targets) await window.api.toggleMod(p);
      await loadMods(); state.selectedMods.clear(); renderMods();
      toast(`${targets.length} mod(s) ativados`, 'success');
      pushUndo(`Ativar ${targets.length} mod(s)`, async () => {
        for (const p of targets) await window.api.toggleMod(p);
        await loadMods(); renderMods();
      });
    } catch (e) { toast('Erro ao ativar mods: ' + e.message, 'error'); }
  });

  // Batch disable
  el.querySelector('#btn-disable-all-sel')?.addEventListener('click', async () => {
    const sel = [...state.selectedMods];
    if (!sel.length) { toast('Selecione ao menos um mod', 'warning'); return; }
    const targets = sel.filter(p => { const m = [...state.mods, ...state.trayFiles].find(m => m.path === p); return m && m.enabled; });
    if (!targets.length) { toast('Nenhum mod ativo selecionado', 'warning'); return; }
    try {
      for (const p of targets) await window.api.toggleMod(p);
      await loadMods(); state.selectedMods.clear(); renderMods();
      toast(`${targets.length} mod(s) desativados`, 'success');
      pushUndo(`Desativar ${targets.length} mod(s)`, async () => {
        for (const p of targets.map(p => p + '.disabled')) await window.api.toggleMod(p);
        await loadMods(); renderMods();
      });
    } catch (e) { toast('Erro ao desativar mods: ' + e.message, 'error'); }
  });

  // Batch delete
  el.querySelector('#btn-delete-sel')?.addEventListener('click', () => {
    const sel = [...state.selectedMods];
    if (!sel.length) { toast('Selecione ao menos um mod', 'warning'); return; }
    openModal('Confirmar Exclusão em Lote',
      `<p>Tem certeza que deseja deletar <strong>${sel.length}</strong> mod(s) selecionado(s)?</p>`,
      [
        { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
        { label: `Deletar ${sel.length}`, cls: 'btn-danger', action: async () => {
          const results = await window.api.deleteMods(sel);
          const failed = results.filter(r => !r.success).length;
          await loadMods(); state.selectedMods.clear(); renderMods();
          toast(`${results.length - failed} deletado(s)${failed ? `, ${failed} com erro` : ''}`, failed ? 'warning' : 'success');
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

function setupGalleryEvents(el, mods) {
  setupCommonModsEvents(el);

  // Select all
  el.querySelector('#select-all-grid')?.addEventListener('change', e => {
    state.selectedMods.clear();
    if (e.target.checked) mods.forEach(m => state.selectedMods.add(m.path));
    el.querySelectorAll('.card-check').forEach(c => {
      c.checked = e.target.checked;
      c.closest('.gallery-card').classList.toggle('selected', e.target.checked);
    });
    refreshSelBar(el);
  });

  // Card checkbox — individual files
  el.querySelectorAll('.card-check:not(.card-check-group)').forEach(cb => {
    cb.addEventListener('change', e => {
      e.stopPropagation();
      const p = cb.dataset.path;
      cb.checked ? state.selectedMods.add(p) : state.selectedMods.delete(p);
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

  // Card click → toggle mod (individual)
  el.querySelectorAll('.gallery-card:not(.tray-group)').forEach(card => {
    card.addEventListener('click', async e => {
      if (e.target.classList.contains('card-check')) return;
      const result = await window.api.toggleMod(card.dataset.path);
      if (result.success) { await loadMods(); renderMods(); }
      else toast('Erro ao alternar mod', 'error');
    });
  });

  // Card click → toggle all files in tray group
  el.querySelectorAll('.gallery-card.tray-group').forEach(card => {
    card.addEventListener('click', async e => {
      if (e.target.classList.contains('card-check')) return;
      const guid = card.dataset.trayGuid;
      const allGrouped = groupTrayFiles([...state.mods, ...state.trayFiles]);
      const group = allGrouped.find(g => g._isTrayGroup && g.trayGuid === guid);
      if (!group) return;
      try {
        for (const f of group.files) await window.api.toggleMod(f.path);
        await loadMods(); renderMods();
      } catch (err) { toast('Erro ao alternar arquivos do grupo', 'error'); }
    });
  });

  // Load thumbnails
  loadVisibleThumbnails(el);
}

async function loadVisibleThumbnails(el) {
  const loaders = el.querySelectorAll('[data-load]');

  // Collect all files that still need loading, marking them as in-progress
  // atomically before any await — this prevents duplicate IPC calls across
  // concurrent loadVisibleThumbnails instances that can be triggered by rapid
  // renderMods() calls (filter changes, searches, mod toggles, etc.).
  const toLoad = [];
  for (const loader of loaders) {
    const filePath = loader.dataset.load;
    if (state.thumbnailCache[filePath] !== undefined) continue;
    state.thumbnailCache[filePath] = THUMB_LOADING;
    toLoad.push(filePath);
  }

  // Load all thumbnails in PARALLEL so that a slow file doesn't block the
  // rest, and so that a new renderMods() call mid-loop doesn't leave items
  // permanently stuck as THUMB_LOADING without anyone awaiting their result.
  await Promise.all(toLoad.map(async (filePath) => {
    const thumb = await window.api.getThumbnail(filePath);
    state.thumbnailCache[filePath] = thumb ?? null;

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
      ph.textContent = '📦';
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
          <button class="btn btn-sm btn-danger delete-mod-btn" data-path="${escapeHtml(mod.path)}" title="Deletar">🗑</button>
        </div>
      </td>
    </tr>`;
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
      if (selectAll.checked) mods.forEach(m => state.selectedMods.add(m.path));
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

  // Toggle individual mod
  el.querySelectorAll('.toggle-mod-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const result = await window.api.toggleMod(btn.dataset.path);
      if (result.success) { await loadMods(); renderMods(); }
      else toast('Erro ao alternar mod: ' + result.error, 'error');
    });
  });

  // Delete individual
  el.querySelectorAll('.delete-mod-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const filePath = btn.dataset.path;
      const name = mods.find(m => m.path === filePath)?.name || filePath;
      openModal('Confirmar Exclusão',
        `<p>Tem certeza que deseja deletar <strong>${escapeHtml(name)}</strong>?</p>`,
        [
          { label: 'Cancelar', cls: 'btn-secondary', action: () => {} },
          { label: 'Deletar', cls: 'btn-danger', action: async () => {
            const results = await window.api.deleteMods([filePath]);
            if (results[0].success) { await loadMods(); renderMods(); toast('Mod deletado', 'success'); }
            else toast('Erro ao deletar: ' + results[0].error, 'error');
          }}
        ]
      );
    });
  });
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
  toast(`Importando ${filePaths.length} arquivo(s)...`, 'info', 2000);
  const result = await window.api.importFiles(filePaths, state.config.modsFolder, state.config.trayFolder);
  await loadMods();
  if (state.currentPage === 'mods') renderMods();
  if (state.currentPage === 'dashboard') renderDashboard();
  if (result.imported.length > 0) {
    toast(`${result.imported.length} arquivo(s) importado(s) com sucesso`, 'success');
  }
  if (result.errors.length > 0) {
    toast(`${result.errors.length} arquivo(s) com erro`, 'error');
  }
}

// ─── Conflicts Page ───────────────────────────────────────────────────────────

async function renderConflicts() {
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

  if (state.conflicts.length > 0) renderConflictResults(el);
}

async function runConflictScan(el) {
  if (!state.config?.modsFolder) { toast('Configure a pasta Mods primeiro', 'warning'); return; }
  const resultEl = el.querySelector('#conflicts-result');
  resultEl.innerHTML = `<div class="loading-state"><div class="spinner"></div><div class="loading-text">Escaneando conflitos... (pode demorar)</div></div>`;

  try {
    state.conflicts = await window.api.scanConflicts(state.config.modsFolder);
    renderConflictResults(el);
  } catch (e) {
    resultEl.innerHTML = `<div class="notice danger">Erro ao escanear: ${escapeHtml(e.message)}</div>`;
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
            state.conflicts.splice(idx, 1);
            await loadMods();
            renderConflictResults(el);
            toast('Arquivo deletado', 'success');
            pushUndo(`Deletar ${fileName}`, async () => {
              await window.api.conflictRestoreFromTrash(trashPath, filePath);
              await loadMods();
              toast('Arquivo restaurado', 'success');
            });
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
            <button class="btn btn-sm btn-danger conflict-delete-btn" data-path="${escapeHtml(f.path)}" data-conflict="${idx}">🗑 Deletar</button>
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
        <div class="page-subtitle">Detecta e corrige arquivos em locais incorretos</div>
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
          <strong>Arquivos de Tray</strong> (.trayitem, .blueprint, etc.) — devem estar na pasta Tray, não em Mods.
        </div>
      </div>
    </div>

    <div id="organize-result"></div>
  `;

  el.querySelector('#btn-scan-organize').addEventListener('click', () => runOrganizeScan(el));

  if (state.misplaced.length > 0) renderOrganizeResults(el);
}

async function runOrganizeScan(el) {
  if (!state.config?.modsFolder) { toast('Configure a pasta Mods primeiro', 'warning'); return; }
  const resultEl = el.querySelector('#organize-result');
  resultEl.innerHTML = `<div class="loading-state"><div class="spinner"></div><div class="loading-text">Verificando organização...</div></div>`;

  try {
    state.misplaced = await window.api.scanMisplaced(state.config.modsFolder, state.config.trayFolder);
    renderOrganizeResults(el);
  } catch (e) {
    resultEl.innerHTML = `<div class="notice danger">Erro ao escanear: ${escapeHtml(e.message)}</div>`;
  }
}

function renderOrganizeResults(el) {
  const resultEl = el.querySelector('#organize-result');
  if (!state.misplaced.length) {
    resultEl.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <h3>Tudo organizado!</h3>
        <p>Nenhum arquivo fora do lugar foi encontrado.</p>
      </div>`;
    return;
  }

  resultEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <span class="section-title">${state.misplaced.length} arquivo(s) fora do lugar</span>
      <button class="btn btn-primary" id="btn-fix-all">Corrigir Todos</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${state.misplaced.map((item, i) => `
        <div class="misplaced-row" data-index="${i}">
          <span class="file-icon">${fileIcon('package')}</span>
          <div class="misplaced-info">
            <div class="misplaced-name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</div>
            <div class="misplaced-issue">⚠ ${escapeHtml(item.issue)}</div>
          </div>
          <span class="misplaced-arrow">→</span>
          <div class="misplaced-dest" title="${escapeHtml(item.suggestedDest)}">${escapeHtml(item.suggestedDest)}</div>
          <span style="font-size:11.5px;color:var(--text-secondary);flex-shrink:0">${formatBytes(item.size)}</span>
          <button class="btn btn-sm btn-primary fix-one-btn" data-index="${i}">Corrigir</button>
        </div>
      `).join('')}
    </div>
  `;

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
    });
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
        });
      } else {
        toast('Erro ao mover arquivo: ' + (result.error || ''), 'error');
      }
    });
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
            <div class="settings-label">Verificar arquivos mal colocados</div>
            <div class="settings-desc">Detecta arquivos em pastas incorretas ao abrir o Dashboard (rápido)</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="toggle-auto-misplaced" ${cfg.autoCheckMisplaced !== false ? 'checked' : ''}>
            <div class="toggle-track"><div class="toggle-thumb"></div></div>
          </label>
        </div>
        <div class="settings-item">
          <div>
            <div class="settings-label">Verificar duplicatas ao abrir</div>
            <div class="settings-desc">Escaneia conflitos e arquivos duplicados ao abrir o Dashboard — pode causar lentidão com muitos mods</div>
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

    // Purge thumbnail cache for files no longer present
    const allPaths = [...state.mods, ...state.trayFiles].map(m => m.path);
    window.api.purgeThumbnailCache(allPaths);
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

  // Initial page
  navigate('dashboard');
}

init();
