const { internalDecompression } = require('../../main.js');

test('internalDecompression: buffer truncado (dIdx fora dos limites) não lança exceção', () => {
  // Cabeçalho minimal: small-file, decompressedSize=1, cc=0x00
  // cc=0x00 <= 0x7F: tenta ler data[dIdx=6] que é undefined
  const b = Buffer.alloc(6);
  b[0]=0x00; b[1]=0x00; b[2]=0x00; b[3]=0x00; b[4]=0x01; b[5]=0x00;
  let result;
  expect(() => { result = internalDecompression(b); }).not.toThrow();
  // Resultado pode ter 0 bytes ou 1 byte (NaN arithmetic → behavior sem crash)
  expect(Buffer.isBuffer(result)).toBe(true);
});

test('internalDecompression: copyOffset=0 (back-ref para uIdx-1) não lança exceção', () => {
  // cc=0x00 com copyOffset=0 (data[dIdx]=0) → udata[uIdx-0-1] = udata[-1] = undefined → 0
  const b = Buffer.alloc(7);
  b[0]=0x00; b[1]=0x00; b[2]=0x00; b[3]=0x00; b[4]=0x04; // decompressedSize=4
  b[5]=0x00; // cc=0x00: size=0, copySize=3, copyOffset=(0<<3)+data[6]=0
  b[6]=0x00; // copyOffset low byte
  let result;
  expect(() => { result = internalDecompression(b); }).not.toThrow();
});
