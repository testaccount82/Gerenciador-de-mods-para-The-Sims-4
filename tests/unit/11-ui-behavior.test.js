'use strict';
/**
 * Testes de comportamento da interface (renderer.js — funções puras).
 *
 * Testa as funções de lógica que não dependem de DOM ou IPC:
 *  - formatBytes, escapeHtml, fileIcon, typeBadge, statusBadge
 *  - getModPrefix, groupModsByPrefix
 *  - groupTrayFiles
 *  - thumbKey
 *  - renderPagination (HTML gerado)
 *  - getFilteredMods (via estado simulado)
 *  - Lógica de seleção e estado
 *  - Lógica de progressos (organizeProgress / conflictProgress)
 */

// ─── Funções puras copiadas de renderer.js para teste isolado ────────────────
// (renderer.js é um módulo browser-only; extraímos apenas as funções puras)

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

function thumbKey(path) {
  return path ? path.replace(/\.disabled$/i, '') : path;
}

function getModPrefix(name) {
  const base = name.replace(/\.(disabled)$/i, '').replace(/\.[^.]+$/, '');
  const idx = base.indexOf('_');
  if (idx < 2) return null;
  return base.slice(0, idx).toLowerCase();
}

function groupModsByPrefix(mods) {
  const prefixMap = new Map();
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
    if (files.length === 1) { result.push(files[0]); continue; }

    const primary = files.find(f => f.type === 'package') || files[0];
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    const allEnabled = files.every(f => f.enabled);

    result.push({
      _isModGroup: true,
      modPrefix: prefix,
      files,
      path: primary.path,
      name: primary.name,
      size: totalSize,
      enabled: allEnabled,
      type: primary.type,
      folder: primary.folder,
      lastModified: primary.lastModified,
    });
  }

  return result;
}

function groupTrayFiles(mods) {
  const groups = new Map();
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
    if (files.length === 1) { result.push(files[0]); continue; }

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

// ─── Helpers de fixtures ──────────────────────────────────────────────────────

function makeMod(overrides = {}) {
  return {
    path: 'C:\\Mods\\mod.package',
    name: 'mod.package',
    type: 'package',
    size: 1024,
    enabled: true,
    folder: '/',
    lastModified: Date.now(),
    ...overrides,
  };
}

// ─── formatBytes ──────────────────────────────────────────────────────────────

describe('formatBytes', () => {
  test('0 bytes', () => expect(formatBytes(0)).toBe('0 B'));
  test('512 bytes', () => expect(formatBytes(512)).toBe('512 B'));
  test('1023 bytes fica em B', () => expect(formatBytes(1023)).toBe('1023 B'));
  test('1024 bytes = 1.0 KB', () => expect(formatBytes(1024)).toBe('1.0 KB'));
  test('1536 bytes = 1.5 KB', () => expect(formatBytes(1536)).toBe('1.5 KB'));
  test('1 MB exato', () => expect(formatBytes(1024 * 1024)).toBe('1.00 MB'));
  test('2.5 MB', () => expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.50 MB'));
});

// ─── escapeHtml ───────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  test('sem caracteres especiais passa sem alteração', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  test('& é escapado para &amp;', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  test('< é escapado para &lt;', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  test('" é escapado para &quot;', () => {
    expect(escapeHtml('"valor"')).toBe('&quot;valor&quot;');
  });

  test('converte não-string para string antes de escapar', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('null');
  });

  test('combinação de caracteres especiais', () => {
    expect(escapeHtml('<b class="x">a & b</b>')).toBe(
      '&lt;b class=&quot;x&quot;&gt;a &amp; b&lt;/b&gt;'
    );
  });
});

// ─── fileIcon ─────────────────────────────────────────────────────────────────

describe('fileIcon', () => {
  test('package retorna 📦', () => expect(fileIcon('package')).toBe('📦'));
  test('script retorna ⚙️', () => expect(fileIcon('script')).toBe('⚙️'));
  test('tray retorna 🏠', () => expect(fileIcon('tray')).toBe('🏠'));
  test('tipo desconhecido retorna 📄', () => expect(fileIcon('outro')).toBe('📄'));
  test('tray-in-mods retorna ⚠️', () => expect(fileIcon('tray-in-mods')).toBe('⚠️'));
  test('mods-in-tray retorna ⚠️', () => expect(fileIcon('mods-in-tray')).toBe('⚠️'));
});

// ─── typeBadge ────────────────────────────────────────────────────────────────

describe('typeBadge', () => {
  test('package contém .package', () => {
    expect(typeBadge('package')).toContain('.package');
  });

  test('script contém .ts4script', () => {
    expect(typeBadge('script')).toContain('.ts4script');
  });

  test('tray contém Tray', () => {
    expect(typeBadge('tray')).toContain('Tray');
  });

  test('tipo desconhecido contém badge-warn', () => {
    expect(typeBadge('unknown')).toContain('badge-warn');
  });
});

// ─── statusBadge ─────────────────────────────────────────────────────────────

describe('statusBadge', () => {
  test('ativo contém badge-active', () => {
    expect(statusBadge(true)).toContain('badge-active');
  });

  test('ativo contém texto Ativo', () => {
    expect(statusBadge(true)).toContain('Ativo');
  });

  test('inativo contém badge-inactive', () => {
    expect(statusBadge(false)).toContain('badge-inactive');
  });

  test('inativo contém texto Inativo', () => {
    expect(statusBadge(false)).toContain('Inativo');
  });
});

// ─── thumbKey ────────────────────────────────────────────────────────────────

describe('thumbKey', () => {
  test('caminho sem .disabled fica igual', () => {
    expect(thumbKey('C:\\Mods\\mod.package')).toBe('C:\\Mods\\mod.package');
  });

  test('remove .disabled no final', () => {
    expect(thumbKey('C:\\Mods\\mod.package.disabled'))
      .toBe('C:\\Mods\\mod.package');
  });

  test('remove .DISABLED no final (case-insensitive)', () => {
    expect(thumbKey('C:\\Mods\\mod.package.DISABLED'))
      .toBe('C:\\Mods\\mod.package');
  });

  test('.disabled dentro do caminho não é removido', () => {
    expect(thumbKey('C:\\Mods\\.disabled\\mod.package'))
      .toBe('C:\\Mods\\.disabled\\mod.package');
  });

  test('retorna o próprio valor se path for falsy', () => {
    expect(thumbKey(null)).toBeNull();
    expect(thumbKey('')).toBe('');
    expect(thumbKey(undefined)).toBeUndefined();
  });

  test('toggle duplo retorna ao original', () => {
    const orig = 'C:\\Mods\\mod.package';
    const disabled = orig + '.disabled';
    expect(thumbKey(disabled)).toBe(orig);
    expect(thumbKey(thumbKey(disabled))).toBe(orig); // idempotent
  });
});

// ─── getModPrefix ─────────────────────────────────────────────────────────────

describe('getModPrefix', () => {
  test('prefixo extraído antes do primeiro _', () => {
    expect(getModPrefix('abc_ModName.package')).toBe('abc');
  });

  test('prefixo em minúsculo', () => {
    expect(getModPrefix('ABC_ModName.package')).toBe('abc');
  });

  test('retorna null se prefixo < 2 chars', () => {
    expect(getModPrefix('a_ModName.package')).toBeNull();
  });

  test('retorna null se não há _', () => {
    expect(getModPrefix('ModName.package')).toBeNull();
  });

  test('ignora extensão .disabled', () => {
    expect(getModPrefix('abc_ModName.package.disabled')).toBe('abc');
  });

  test('ignora extensão .ts4script.disabled', () => {
    expect(getModPrefix('abc_Script.ts4script.disabled')).toBe('abc');
  });

  test('prefixo com exatamente 2 chars é válido', () => {
    expect(getModPrefix('ab_ModName.package')).toBe('ab');
  });

  test('retorna null para arquivo sem separador', () => {
    expect(getModPrefix('SkinMod.package')).toBeNull();
  });
});

// ─── groupModsByPrefix ────────────────────────────────────────────────────────

describe('groupModsByPrefix', () => {
  test('agrupa dois arquivos com mesmo prefixo', () => {
    const mods = [
      makeMod({ name: 'abc_Mod.package',   path: 'abc_Mod.package',   type: 'package' }),
      makeMod({ name: 'abc_Mod.ts4script', path: 'abc_Mod.ts4script', type: 'script'  }),
    ];
    const result = groupModsByPrefix(mods);
    expect(result).toHaveLength(1);
    expect(result[0]._isModGroup).toBe(true);
    expect(result[0].files).toHaveLength(2);
    expect(result[0].modPrefix).toBe('abc');
  });

  test('arquivo único com prefixo não é agrupado', () => {
    const mods = [makeMod({ name: 'abc_Mod.package', path: 'abc_Mod.package' })];
    const result = groupModsByPrefix(mods);
    expect(result).toHaveLength(1);
    expect(result[0]._isModGroup).toBeUndefined();
  });

  test('arquivos sem prefixo ficam separados', () => {
    const mods = [
      makeMod({ name: 'ModA.package', path: 'A.package' }),
      makeMod({ name: 'ModB.package', path: 'B.package' }),
    ];
    const result = groupModsByPrefix(mods);
    expect(result).toHaveLength(2);
    result.forEach(r => expect(r._isModGroup).toBeUndefined());
  });

  test('prefixo diferente → itens separados', () => {
    const mods = [
      makeMod({ name: 'abc_Mod.package',  path: 'abc_Mod.package'  }),
      makeMod({ name: 'xyz_Mod.package',  path: 'xyz_Mod.package'  }),
    ];
    const result = groupModsByPrefix(mods);
    expect(result).toHaveLength(2);
    expect(result.every(r => !r._isModGroup)).toBe(true);
  });

  test('tamanho total do grupo é a soma dos arquivos', () => {
    const mods = [
      makeMod({ name: 'abc_Mod.package',   path: 'abc_Mod.package',   size: 500  }),
      makeMod({ name: 'abc_Mod.ts4script', path: 'abc_Mod.ts4script', size: 300  }),
    ];
    const result = groupModsByPrefix(mods);
    expect(result[0].size).toBe(800);
  });

  test('grupo fica enabled=true somente se todos habilitados', () => {
    const modsAllEnabled = [
      makeMod({ name: 'abc_Mod.package',   path: 'abc_Mod.package',   enabled: true  }),
      makeMod({ name: 'abc_Mod.ts4script', path: 'abc_Mod.ts4script', enabled: true  }),
    ];
    const modsOneDisabled = [
      makeMod({ name: 'abc_Mod.package',   path: 'abc_Mod.package',   enabled: true  }),
      makeMod({ name: 'abc_Mod.ts4script', path: 'abc_Mod.ts4script', enabled: false }),
    ];
    expect(groupModsByPrefix(modsAllEnabled)[0].enabled).toBe(true);
    expect(groupModsByPrefix(modsOneDisabled)[0].enabled).toBe(false);
  });

  test('tipo primário prefere .package sobre .ts4script', () => {
    const mods = [
      makeMod({ name: 'abc_Mod.ts4script', path: 'abc_Mod.ts4script', type: 'script'  }),
      makeMod({ name: 'abc_Mod.package',   path: 'abc_Mod.package',   type: 'package' }),
    ];
    const result = groupModsByPrefix(mods);
    expect(result[0].type).toBe('package');
  });

  test('arquivos tray não são agrupados por prefixo', () => {
    const mods = [
      makeMod({ name: 'abc_House.trayitem', path: 'abc_House.trayitem', type: 'tray' }),
      makeMod({ name: 'abc_House.blueprint',path: 'abc_House.blueprint',type: 'tray' }),
    ];
    const result = groupModsByPrefix(mods);
    expect(result).toHaveLength(2);
    expect(result.every(r => !r._isModGroup)).toBe(true);
  });

  test('grupos tray (_isTrayGroup) passam diretamente sem agrupamento por prefixo', () => {
    const trayGroup = {
      _isTrayGroup: true,
      trayGuid: 'abc123',
      files: [],
      name: 'abc_House.trayitem',
      path: 'abc_House.trayitem',
      type: 'tray',
      size: 1000,
      enabled: true,
      folder: '/',
    };
    const result = groupModsByPrefix([trayGroup]);
    expect(result).toHaveLength(1);
    expect(result[0]._isTrayGroup).toBe(true);
  });

  test('ícone correto para grupo de .ts4script sem .package', () => {
    const mods = [
      makeMod({ name: 'abc_ScriptA.ts4script', path: 'abc_ScriptA.ts4script', type: 'script' }),
      makeMod({ name: 'abc_ScriptB.ts4script', path: 'abc_ScriptB.ts4script', type: 'script' }),
    ];
    const result = groupModsByPrefix(mods);
    expect(result[0].type).toBe('script');
    // fileIcon(group.type) deve retornar ⚙️, não 📦
    expect(fileIcon(result[0].type)).toBe('⚙️');
  });
});

// ─── groupTrayFiles ───────────────────────────────────────────────────────────

describe('groupTrayFiles', () => {
  test('arquivos sem trayGuid ficam sem agrupamento', () => {
    const mods = [
      makeMod({ type: 'tray', name: 'A.trayitem', path: 'A.trayitem' }), // sem guid
      makeMod({ type: 'tray', name: 'B.trayitem', path: 'B.trayitem' }), // sem guid
    ];
    const result = groupTrayFiles(mods);
    expect(result).toHaveLength(2);
    expect(result.every(r => !r._isTrayGroup)).toBe(true);
  });

  test('arquivos com mesmo trayGuid são agrupados', () => {
    const guid = 'aabb1122';
    const mods = [
      makeMod({ type: 'tray', name: 'aabb1122!ccdd.trayitem',   path: 'a.trayitem',   trayGuid: guid }),
      makeMod({ type: 'tray', name: 'aabb1122!ccdd.blueprint',  path: 'a.blueprint',  trayGuid: guid }),
      makeMod({ type: 'tray', name: 'aabb1122!ccdd.householdbinary', path: 'a.hh', trayGuid: guid }),
    ];
    const result = groupTrayFiles(mods);
    expect(result).toHaveLength(1);
    expect(result[0]._isTrayGroup).toBe(true);
    expect(result[0].files).toHaveLength(3);
    expect(result[0].trayGuid).toBe(guid);
  });

  test('grupo com arquivo único (mesmo guid) não é agrupado', () => {
    const guid = 'aabb1122';
    const mods = [
      makeMod({ type: 'tray', name: 'aabb1122!ccdd.trayitem', path: 'a.trayitem', trayGuid: guid }),
    ];
    const result = groupTrayFiles(mods);
    expect(result).toHaveLength(1);
    expect(result[0]._isTrayGroup).toBeUndefined();
  });

  test('tamanho total do grupo é a soma', () => {
    const guid = 'gg11';
    const mods = [
      makeMod({ type: 'tray', name: 'gg11!xx.trayitem',  path: 'ti.trayitem',  trayGuid: guid, size: 1000 }),
      makeMod({ type: 'tray', name: 'gg11!xx.blueprint', path: 'bp.blueprint', trayGuid: guid, size: 2000 }),
    ];
    const result = groupTrayFiles(mods);
    expect(result[0].size).toBe(3000);
  });

  test('grupo.enabled = true somente se todos estão habilitados', () => {
    const guid = 'gg22';
    const allEnabled = [
      makeMod({ type: 'tray', trayGuid: guid, path: 'a.trayitem',  name: 'gg22!x.trayitem',  enabled: true  }),
      makeMod({ type: 'tray', trayGuid: guid, path: 'b.blueprint', name: 'gg22!x.blueprint', enabled: true  }),
    ];
    const oneDisabled = [
      makeMod({ type: 'tray', trayGuid: guid, path: 'a.trayitem',  name: 'gg22!x.trayitem',  enabled: false }),
      makeMod({ type: 'tray', trayGuid: guid, path: 'b.blueprint', name: 'gg22!x.blueprint', enabled: true  }),
    ];
    expect(groupTrayFiles(allEnabled)[0].enabled).toBe(true);
    expect(groupTrayFiles(oneDisabled)[0].enabled).toBe(false);
  });

  test('grupo.anyEnabled = true se ao menos um habilitado', () => {
    const guid = 'gg33';
    const mods = [
      makeMod({ type: 'tray', trayGuid: guid, path: 'a.trayitem',  name: 'gg33!x.trayitem',  enabled: false }),
      makeMod({ type: 'tray', trayGuid: guid, path: 'b.blueprint', name: 'gg33!x.blueprint', enabled: true  }),
    ];
    expect(groupTrayFiles(mods)[0].anyEnabled).toBe(true);
  });

  test('representante do grupo é .trayitem quando disponível', () => {
    const guid = 'rep1';
    const mods = [
      makeMod({ type: 'tray', trayGuid: guid, path: 'b.blueprint', name: 'rep1!x.blueprint', size: 100 }),
      makeMod({ type: 'tray', trayGuid: guid, path: 'a.trayitem',  name: 'rep1!x.trayitem',  size: 50  }),
    ];
    const result = groupTrayFiles(mods);
    expect(result[0].path).toBe('a.trayitem');
  });

  test('mods não-tray passam sem alteração', () => {
    const mods = [
      makeMod({ type: 'package', name: 'Mod.package', path: 'Mod.package' }),
      makeMod({ type: 'script',  name: 'Script.ts4script', path: 'Script.ts4script' }),
    ];
    const result = groupTrayFiles(mods);
    expect(result).toHaveLength(2);
    expect(result.every(r => !r._isTrayGroup)).toBe(true);
  });

  test('guids diferentes produzem grupos separados', () => {
    const mods = [
      makeMod({ type: 'tray', trayGuid: 'guid1', path: 'a.trayitem',  name: 'g1!x.trayitem'  }),
      makeMod({ type: 'tray', trayGuid: 'guid1', path: 'a.blueprint', name: 'g1!x.blueprint' }),
      makeMod({ type: 'tray', trayGuid: 'guid2', path: 'b.trayitem',  name: 'g2!y.trayitem'  }),
      makeMod({ type: 'tray', trayGuid: 'guid2', path: 'b.blueprint', name: 'g2!y.blueprint' }),
    ];
    const result = groupTrayFiles(mods);
    expect(result).toHaveLength(2);
    expect(result.every(r => r._isTrayGroup)).toBe(true);
  });
});

// ─── Filtros e ordenação (lógica pura) ───────────────────────────────────────

describe('filtros de mods (lógica getFilteredMods)', () => {
  function getFilteredMods(mods, tray, { searchQuery = '', filterStatus = 'all', filterType = 'all', sortColumn = 'name', sortDir = 'asc' } = {}) {
    let all = [...mods, ...tray];
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      all = all.filter(m => m.name.toLowerCase().includes(q));
    }
    if (filterStatus !== 'all') {
      const want = filterStatus === 'active';
      all = all.filter(m => m.enabled === want);
    }
    if (filterType !== 'all') {
      all = all.filter(m => m.type === filterType);
    }
    all.sort((a, b) => {
      let va = a[sortColumn] ?? '', vb = b[sortColumn] ?? '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return all;
  }

  const mods = [
    makeMod({ name: 'Charlie.package', path: 'c.package', type: 'package', enabled: true,  size: 300 }),
    makeMod({ name: 'Alpha.package',   path: 'a.package', type: 'package', enabled: false, size: 100 }),
    makeMod({ name: 'Beta.ts4script',  path: 'b.ts4script', type: 'script', enabled: true,  size: 200 }),
  ];

  test('sem filtro retorna todos os mods', () => {
    expect(getFilteredMods(mods, [])).toHaveLength(3);
  });

  test('filtro de busca por nome', () => {
    const result = getFilteredMods(mods, [], { searchQuery: 'alpha' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Alpha.package');
  });

  test('filtro por status ativo', () => {
    const result = getFilteredMods(mods, [], { filterStatus: 'active' });
    expect(result).toHaveLength(2);
    expect(result.every(m => m.enabled)).toBe(true);
  });

  test('filtro por status inativo', () => {
    const result = getFilteredMods(mods, [], { filterStatus: 'inactive' });
    expect(result).toHaveLength(1);
    expect(result[0].enabled).toBe(false);
  });

  test('filtro por tipo package', () => {
    const result = getFilteredMods(mods, [], { filterType: 'package' });
    expect(result).toHaveLength(2);
    expect(result.every(m => m.type === 'package')).toBe(true);
  });

  test('filtro por tipo script', () => {
    const result = getFilteredMods(mods, [], { filterType: 'script' });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('script');
  });

  test('ordenação por nome asc', () => {
    const result = getFilteredMods(mods, [], { sortColumn: 'name', sortDir: 'asc' });
    expect(result.map(m => m.name)).toEqual(['Alpha.package', 'Beta.ts4script', 'Charlie.package']);
  });

  test('ordenação por nome desc', () => {
    const result = getFilteredMods(mods, [], { sortColumn: 'name', sortDir: 'desc' });
    expect(result.map(m => m.name)).toEqual(['Charlie.package', 'Beta.ts4script', 'Alpha.package']);
  });

  test('ordenação por tamanho asc', () => {
    const result = getFilteredMods(mods, [], { sortColumn: 'size', sortDir: 'asc' });
    expect(result.map(m => m.size)).toEqual([100, 200, 300]);
  });

  test('busca case-insensitive', () => {
    const result = getFilteredMods(mods, [], { searchQuery: 'CHARLIE' });
    expect(result).toHaveLength(1);
  });

  test('combina filtro de tipo + status', () => {
    const result = getFilteredMods(mods, [], { filterType: 'package', filterStatus: 'active' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Charlie.package');
  });

  test('retorna array vazio quando nada bate', () => {
    const result = getFilteredMods(mods, [], { searchQuery: 'xyzabc' });
    expect(result).toHaveLength(0);
  });

  test('inclui arquivos tray na lista geral', () => {
    const tray = [makeMod({ type: 'tray', name: 'House.trayitem', path: 'h.trayitem', enabled: true })];
    expect(getFilteredMods([], tray)).toHaveLength(1);
  });
});

// ─── Estado de progresso ──────────────────────────────────────────────────────

describe('lógica de progresso de scan', () => {
  test('barra de progresso de conflitos calcula porcentagem corretamente', () => {
    const done = 30;
    const total = 100;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    expect(pct).toBe(30);
  });

  test('porcentagem mínima de 5% quando total > 0 (evita barra invisível)', () => {
    const done = 0;
    const total = 100;
    const pct = total > 0 ? Math.max(5, Math.round((done / total) * 100)) : 0;
    expect(pct).toBe(5);
  });

  test('porcentagem retorna 0 quando total = 0', () => {
    const done = 0;
    const total = 0;
    const pct = total > 0 ? Math.max(5, Math.round((done / total) * 100)) : 0;
    expect(pct).toBe(0);
  });

  test('barra de 100% quando scan completo', () => {
    const done = 50;
    const total = 50;
    const pct = total > 0 ? Math.max(5, Math.round((done / total) * 100)) : 0;
    expect(pct).toBe(100);
  });

  test('remaining calculado corretamente', () => {
    const total = 80;
    const done = 60;
    const remaining = total - done;
    expect(remaining).toBe(20);
  });
});

// ─── Paginação ────────────────────────────────────────────────────────────────

describe('lógica de paginação', () => {
  function calcPagination(total, itemsPerPage, currentPage) {
    const effectivePerPage = isFinite(itemsPerPage) ? itemsPerPage : total || 1;
    const totalPages = Math.max(1, Math.ceil(total / effectivePerPage));
    const safePage = Math.min(Math.max(1, currentPage), totalPages);
    const start = (safePage - 1) * effectivePerPage;
    const end = start + effectivePerPage;
    return { totalPages, safePage, start, end };
  }

  test('primeira página começa em 0', () => {
    expect(calcPagination(100, 30, 1).start).toBe(0);
  });

  test('segunda página começa em 30', () => {
    expect(calcPagination(100, 30, 2).start).toBe(30);
  });

  test('total de páginas correto', () => {
    expect(calcPagination(100, 30, 1).totalPages).toBe(4);
    expect(calcPagination(90, 30, 1).totalPages).toBe(3);
    expect(calcPagination(30, 30, 1).totalPages).toBe(1);
    expect(calcPagination(0, 30, 1).totalPages).toBe(1);
  });

  test('Infinity como itemsPerPage mostra tudo em uma página', () => {
    const { totalPages, start, end } = calcPagination(500, Infinity, 1);
    expect(totalPages).toBe(1);
    expect(start).toBe(0);
    expect(end).toBe(500);
  });

  test('página além do total é corrigida para última página', () => {
    const { safePage } = calcPagination(30, 30, 99);
    expect(safePage).toBe(1);
  });
});

// ─── Seleção de mods ──────────────────────────────────────────────────────────

describe('lógica de seleção (selectedMods Set)', () => {
  test('adicionar mod à seleção', () => {
    const sel = new Set();
    sel.add('/Mods/ModA.package');
    expect(sel.has('/Mods/ModA.package')).toBe(true);
    expect(sel.size).toBe(1);
  });

  test('remover mod da seleção', () => {
    const sel = new Set(['/Mods/ModA.package', '/Mods/ModB.package']);
    sel.delete('/Mods/ModA.package');
    expect(sel.has('/Mods/ModA.package')).toBe(false);
    expect(sel.size).toBe(1);
  });

  test('limpar seleção', () => {
    const sel = new Set(['/Mods/A.package', '/Mods/B.package']);
    sel.clear();
    expect(sel.size).toBe(0);
  });

  test('seleção de grupo adiciona todos os arquivos do grupo', () => {
    const sel = new Set();
    const group = {
      _isModGroup: true,
      files: [
        { path: '/Mods/abc_Mod.package' },
        { path: '/Mods/abc_Mod.ts4script' },
      ],
    };
    group.files.forEach(f => sel.add(f.path));
    expect(sel.size).toBe(2);
    expect(sel.has('/Mods/abc_Mod.package')).toBe(true);
    expect(sel.has('/Mods/abc_Mod.ts4script')).toBe(true);
  });

  test('desselecionar grupo remove todos os arquivos do grupo', () => {
    const sel = new Set(['/Mods/abc_Mod.package', '/Mods/abc_Mod.ts4script', '/Mods/other.package']);
    const group = {
      files: [
        { path: '/Mods/abc_Mod.package' },
        { path: '/Mods/abc_Mod.ts4script' },
      ],
    };
    group.files.forEach(f => sel.delete(f.path));
    expect(sel.size).toBe(1);
    expect(sel.has('/Mods/other.package')).toBe(true);
  });
});

// ─── Detecção de tipo de arquivo por extensão ────────────────────────────────

describe('detecção de tipo por extensão', () => {
  const MOD_EXTENSIONS  = new Set(['.package', '.ts4script']);
  const TRAY_EXTENSIONS = new Set(['.trayitem', '.blueprint', '.bpi', '.hhi', '.sgi', '.householdbinary', '.room', '.rmi']);

  function detectType(ext) {
    if (MOD_EXTENSIONS.has(ext))  return ext === '.package' ? 'package' : 'script';
    if (TRAY_EXTENSIONS.has(ext)) return 'tray';
    return null;
  }

  test('.package → package', () => expect(detectType('.package')).toBe('package'));
  test('.ts4script → script', () => expect(detectType('.ts4script')).toBe('script'));
  test('.trayitem → tray', () => expect(detectType('.trayitem')).toBe('tray'));
  test('.blueprint → tray', () => expect(detectType('.blueprint')).toBe('tray'));
  test('.bpi → tray', () => expect(detectType('.bpi')).toBe('tray'));
  test('.hhi → tray', () => expect(detectType('.hhi')).toBe('tray'));
  test('.zip → null (não suportado como mod direto)', () => expect(detectType('.zip')).toBeNull());
  test('.txt → null', () => expect(detectType('.txt')).toBeNull());
});
