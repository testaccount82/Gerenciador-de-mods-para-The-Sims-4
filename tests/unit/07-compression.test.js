'use strict';
/**
 * Testes do algoritmo de compressão interno (RefPack/LZ):
 * readUInt24BE, internalDecompression
 */

const core = require('../../main');

// ─── readUInt24BE ─────────────────────────────────────────────────────────────

describe('readUInt24BE', () => {
  test('lê 3 bytes big-endian corretamente', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    expect(core.readUInt24BE(buf, 0)).toBe(0x010203); // 66051
  });

  test('offset 1 lê os 3 bytes seguintes', () => {
    const buf = Buffer.from([0x00, 0x01, 0x00, 0x00]);
    expect(core.readUInt24BE(buf, 1)).toBe(0x010000);
  });

  test('valor máximo 0xFFFFFF', () => {
    const buf = Buffer.from([0xFF, 0xFF, 0xFF]);
    expect(core.readUInt24BE(buf, 0)).toBe(0xFFFFFF);
  });

  test('todos zeros retorna 0', () => {
    const buf = Buffer.from([0x00, 0x00, 0x00]);
    expect(core.readUInt24BE(buf, 0)).toBe(0);
  });

  test('big-endian: byte mais significativo é o primeiro', () => {
    const buf = Buffer.from([0x10, 0x00, 0x00]);
    expect(core.readUInt24BE(buf, 0)).toBe(0x100000);
  });
});

// ─── internalDecompression ────────────────────────────────────────────────────

/**
 * Monta um buffer de entrada RefPack/LZ mínimo para testes.
 *
 * Formato do cabeçalho (5 bytes, arquivo pequeno):
 *   byte[0]: flags (0x00 = small file, sem large-file flag)
 *   byte[1]: 0x00 (padding de flags)
 *   byte[2..4]: tamanho descomprimido (big-endian 24-bit)
 *
 * Seguido de blocos de controle (cc bytes).
 * O bloco 0xFC..0xFF com size=0 finaliza a descompressão sem copiar dados.
 *
 * Nesta suíte testamos a robustez contra entradas inválidas e o comportamento
 * básico do parser — a descompressão real é testada indiretamente na suíte
 * de thumbnail ao abrir arquivos .package de teste reais.
 */

describe('internalDecompression — cabeçalho', () => {
  test('small-file flag (bit 0x80 desligado): tamanho lido nos bytes 2-4', () => {
    // Monta stream mínima: flags sem large-file, size=3, então cc=0xFC (fim com size=0)
    const data = Buffer.from([
      0x00, 0x00,       // bytes 0-1: flags (0x80 off = small file)
      0x00, 0x00, 0x00, // bytes 2-4: decompressed size = 0
      0xFC,             // cc = 0xFC → size = cc & 0x3 = 0, termina loop
    ]);
    // Não deve lançar exceção para size=0
    expect(() => core.internalDecompression(data)).not.toThrow();
  });

  test('large-file flag (bit 0x80 ligado): tamanho lido nos bytes 2-5 (4 bytes)', () => {
    const data = Buffer.from([
      0x80, 0x00,             // byte 0: 0x80 → large-file
      0x00, 0x00, 0x00, 0x00, // bytes 2-5: decompressed size = 0
      0xFC,                   // fim do stream
    ]);
    expect(() => core.internalDecompression(data)).not.toThrow();
  });
});

describe('internalDecompression — stream literal (cc 0xE0–0xFB)', () => {
  test('copia bytes literais corretamente (cc no range 0xE0..0xFB)', () => {
    /**
     * cc = 0xE0: size = ((0xE0 & 0x1F) << 2) + 4 = (0 << 2) + 4 = 4 bytes literais.
     * decompressed size = 4.
     * Após o cc vêm 4 bytes literais [0x41, 0x42, 0x43, 0x44] = "ABCD".
     * Depois cc = 0xFC (fim, size=0).
     */
    const data = Buffer.from([
      0x00, 0x00,             // flags
      0x00, 0x00, 0x04,       // decompressed size = 4
      0xE0,                   // literal block, size=4
      0x41, 0x42, 0x43, 0x44, // "ABCD"
      0xFC,                   // end
    ]);
    const result = core.internalDecompression(data);
    expect(result.slice(0, 4)).toEqual(Buffer.from([0x41, 0x42, 0x43, 0x44]));
  });
});
