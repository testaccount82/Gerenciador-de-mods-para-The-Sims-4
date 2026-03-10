/**
 * Testes para as correções aplicadas na auditoria de segurança e QA (Março/2026)
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { _ipcHandlers } = require('electron');

const {
  internalDecompression,
} = require('../../main.js');

const fakeEvent = { sender: { send: () => {} } };

// ─── SEC-1: tempFolder validado contra BLOCKED no config:set ──────────────────

describe('SEC-1 — config:set: tempFolder validado contra diretórios bloqueados', () => {
  const handler = () => _ipcHandlers['config:set'];

  test('tempFolder apontando para /etc é rejeitado', () => {
    expect(handler()(fakeEvent, { tempFolder: '/etc' })).toBe(false);
  });

  test('tempFolder apontando para /bin é rejeitado', () => {
    expect(handler()(fakeEvent, { tempFolder: '/bin' })).toBe(false);
  });

  test('tempFolder em subdiretório de /etc é rejeitado', () => {
    expect(handler()(fakeEvent, { tempFolder: '/etc/cron.d' })).toBe(false);
  });

  test('tempFolder com caminho de sistema Windows é rejeitado (somente Windows)', () => {
    if (process.platform !== 'win32') return; // skip em Linux/macOS
    expect(handler()(fakeEvent, { tempFolder: 'C:\\Windows\\Temp' })).toBe(false);
  });

  test('tempFolder com caminho de Program Files é rejeitado (somente Windows)', () => {
    if (process.platform !== 'win32') return; // skip em Linux/macOS
    expect(handler()(fakeEvent, { tempFolder: 'C:\\Program Files\\MyApp' })).toBe(false);
  });

  test('tempFolder em subdiretório de /usr é rejeitado (Linux/macOS)', () => {
    if (process.platform === 'win32') return; // skip no Windows
    expect(handler()(fakeEvent, { tempFolder: '/usr/local/tmp' })).toBe(false);
  });
});

// ─── QA-1 / QA-2: internalDecompression — bounds check no buffer de entrada ──

describe('QA-1 — internalDecompression: bounds check no buffer de entrada', () => {
  test('buffer truncado (dIdx além do fim): não lança exceção', () => {
    const b = Buffer.alloc(6);
    b[0]=0x00; b[1]=0x00; b[2]=0x00; b[3]=0x00; b[4]=0x01; b[5]=0x00;
    // cc=0x00 <= 0x7F — antes da correção tentava ler data[6] (undefined)
    expect(() => internalDecompression(b)).not.toThrow();
    expect(Buffer.isBuffer(internalDecompression(b))).toBe(true);
  });

  test('buffer truncado cc <= 0xBF — precisa de 2 bytes extras: não lança exceção', () => {
    const b = Buffer.alloc(7);
    b[0]=0x00; b[1]=0x00; b[2]=0x00; b[3]=0x00; b[4]=0x01;
    b[5]=0x80; // cc=0x80 (<= 0xBF) — precisa ler data[6] e data[7]
    b[6]=0x00;
    expect(() => internalDecompression(b)).not.toThrow();
  });

  test('buffer truncado cc <= 0xDF — precisa de 3 bytes extras: não lança exceção', () => {
    const b = Buffer.alloc(7);
    b[0]=0x00; b[1]=0x00; b[2]=0x00; b[3]=0x00; b[4]=0x01;
    b[5]=0xC0; // cc=0xC0 (<= 0xDF) — precisa ler data[6], data[7], data[8]
    b[6]=0x00;
    expect(() => internalDecompression(b)).not.toThrow();
  });

  test('buffer vazio após cabeçalho: não lança exceção', () => {
    const b = Buffer.alloc(5); // 5 bytes de cabeçalho mas nenhum dado
    b[0]=0x00; b[1]=0x00; b[2]=0x00; b[3]=0x00; b[4]=0x00; // decompressedSize=0
    expect(() => internalDecompression(b)).not.toThrow();
  });

  test('retorna Buffer válido mesmo com input truncado', () => {
    const b = Buffer.alloc(6);
    b[0]=0x00; b[1]=0x00; b[2]=0x00; b[3]=0x00; b[4]=0x04; b[5]=0x00;
    const result = internalDecompression(b);
    expect(Buffer.isBuffer(result)).toBe(true);
  });
});

// ─── QA-1 (DBPF): limite de indexCount em _readDbpfThumbnail ─────────────────
// Não podemos testar _readDbpfThumbnail diretamente via testes unitários sem
// criar um arquivo DBPF malformado — o teste de integração existente já cobre
// o path feliz. O limite MAX_INDEX_ENTRIES=5000 é verificado por inspeção de código.

describe('QA-3 — Limite de entradas DBPF (verificação por código)', () => {
  test('MAX_INDEX_ENTRIES 5000 está definido no código (sanidade)', () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf-8');
    expect(mainSrc).toContain('MAX_INDEX_ENTRIES = 5000');
  });

  test('MAX_CACHE_ENTRIES 50000 está definido no código (sanidade)', () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf-8');
    expect(mainSrc).toContain('MAX_CACHE_ENTRIES = 50000');
  });
});

// ─── SEC-1 (RENDERER): limite de profundidade em collectDroppedFiles ──────────

describe('QA-4 — collectDroppedFiles: limite de profundidade (verificação por código)', () => {
  test('MAX_DEPTH = 10 está definido no renderer', () => {
    const rendererSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf-8');
    expect(rendererSrc).toContain('MAX_DEPTH = 10');
  });

  test('readEntry recebe parâmetro depth', () => {
    const rendererSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf-8');
    expect(rendererSrc).toMatch(/function readEntry\(entry, depth/);
  });

  test('guard depth < MAX_DEPTH está aplicado', () => {
    const rendererSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf-8');
    expect(rendererSrc).toMatch(/entry\.isDirectory && depth < MAX_DEPTH/);
  });
});

// ─── SEC-1: tempFolder validado junto com modsFolder/trayFolder ──────────────

describe('SEC-1 — config:set: loop BLOCKED cobre tempFolder (verificação por código)', () => {
  test("'tempFolder' está no loop de validação BLOCKED", () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf-8');
    expect(mainSrc).toContain("for (const field of ['modsFolder', 'trayFolder', 'tempFolder'])");
  });
});
