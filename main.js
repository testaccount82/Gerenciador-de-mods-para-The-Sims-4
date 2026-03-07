'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile } = require('child_process');

// ─── Single Instance Lock ─────────────────────────────────────────────────────
// Ensures only one instance of the app can run at a time.
// If a second instance is launched, focus the existing window and quit.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MOD_EXTENSIONS = ['.package', '.ts4script'];
const TRAY_EXTENSIONS = ['.trayitem', '.blueprint', '.bpi', '.hhi', '.sgi', '.householdbinary', '.room', '.rmi'];
const ARCHIVE_EXTENSIONS = ['.zip', '.rar', '.7z'];
const DISABLED_SUFFIX = '.disabled';

const SEVEN_ZIP_PATHS = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe'
];

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

const DEFAULT_CONFIG = {
  modsFolder: path.join(os.homedir(), 'Documents', 'Electronic Arts', 'The Sims 4', 'Mods'),
  trayFolder: path.join(os.homedir(), 'Documents', 'Electronic Arts', 'The Sims 4', 'Tray'),
  tempFolder: path.join(app.getPath('temp'), 'ts4modmanager'),
  theme: 'dark',
  windowBounds: { width: 1100, height: 720 },
  autoCheckMisplaced: true,
  autoCheckDuplicates: false
};

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch (e) { /* fallback */ }
  return { ...DEFAULT_CONFIG };
}

function writeConfig(config) {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

// ─── Window ──────────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  const config = readConfig();
  const { width, height } = config.windowBounds || { width: 1100, height: 720 };

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 880,
    minHeight: 600,
    frame: false,
    transparent: false,
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('resize', () => {
    const [w, h] = mainWindow.getSize();
    const cfg = readConfig();
    cfg.windowBounds = { width: w, height: h };
    writeConfig(cfg);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('second-instance', () => {
  // Someone tried to run a second instance — focus our window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });

// ─── Utilities ───────────────────────────────────────────────────────────────

function getFileHash(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('md5');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

function getFileDepth(filePath, baseFolder) {
  const rel = path.relative(baseFolder, path.dirname(filePath));
  if (rel === '') return 0;
  return rel.split(path.sep).length;
}

function findSevenZip() {
  for (const p of SEVEN_ZIP_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getDisabledPath(filePath) {
  return filePath.endsWith(DISABLED_SUFFIX)
    ? filePath.slice(0, -DISABLED_SUFFIX.length)
    : filePath + DISABLED_SUFFIX;
}

function isEnabled(filePath) {
  return !filePath.endsWith(DISABLED_SUFFIX);
}

function getRealExtension(filePath) {
  const base = path.basename(filePath);
  const withoutDisabled = base.endsWith(DISABLED_SUFFIX)
    ? base.slice(0, -DISABLED_SUFFIX.length)
    : base;
  return path.extname(withoutDisabled).toLowerCase();
}

function getRealName(filePath) {
  const base = path.basename(filePath);
  return base.endsWith(DISABLED_SUFFIX)
    ? base.slice(0, -DISABLED_SUFFIX.length)
    : base;
}

// ─── Path Safety Validator ────────────────────────────────────────────────────
// Garante que um filePath está dentro de pelo menos uma das raízes permitidas,
// prevenindo path traversal (e.g. ../../Windows/System32).

function isPathSafe(filePath, ...allowedRoots) {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolved = path.resolve(filePath);
  return allowedRoots.some(root => {
    if (!root) return false;
    const resolvedRoot = path.resolve(root);
    // path.resolve normaliza e remove '..' — suficiente para garantir confinamento
    return resolved.startsWith(resolvedRoot + path.sep) || resolved === resolvedRoot;
  });
}

function getAllowedRoots() {
  const cfg = readConfig();
  return [
    cfg.modsFolder,
    cfg.trayFolder,
    path.join(app.getPath('userData'), 'trash'),
  ].filter(Boolean);
}



// ─── Internal Compression (RefPack/LZ) ───────────────────────────────────────
// Ported from @s4tk/compression, originally by Scumbumbo
// https://modthesims.info/showthread.php?t=618074

function readUInt24BE(data, offset) {
  return data[offset] * 65536 + data[offset + 1] * 256 + data[offset + 2];
}

function internalDecompression(data) {
  // Quando o flag 0x80 está ativo, o tamanho descomprimido usa 4 bytes (big-endian)
  // em vez de 3 — alocar o buffer correto evita corrupção em arquivos grandes
  const largeFile = (data[0] & 0x80) !== 0;
  const decompressedSize = largeFile
    ? (data[2] * 16777216 + data[3] * 65536 + data[4] * 256 + data[5])
    : readUInt24BE(data, 2);

  // SEC-04: limite de 32 MB para evitar DoS via Buffer.alloc(4GB) com arquivo malicioso
  const MAX_DECOMPRESS_SIZE = 32 * 1024 * 1024;
  if (decompressedSize > MAX_DECOMPRESS_SIZE) {
    throw new Error(`internalDecompression: tamanho descomprimido (${decompressedSize}) excede limite de 32 MB`);
  }

  const udata = Buffer.alloc(decompressedSize);
  let uIdx = 0;
  let dIdx = largeFile ? 6 : 5; // 2 bytes flags + 3 ou 4 bytes de tamanho

  let cc;
  do {
    cc = data[dIdx++];
    if (cc <= 0x7F) {
      const size       = cc & 0x3;
      const copySize   = ((cc & 0x1C) >> 2) + 3;
      const copyOffset = ((cc & 0x60) << 3) + data[dIdx];
      dIdx++;
      // QA-04: bounds check para evitar escrita fora do buffer de saída
      if (uIdx + size + copySize > udata.length) break;
      for (let i = 0; i < size; i++) udata[uIdx++] = data[dIdx++];
      for (let i = 0; i < copySize; i++) udata[uIdx] = udata[uIdx++ - copyOffset - 1];
    } else if (cc <= 0xBF) {
      const size       = (data[dIdx] & 0xC0) >> 6;
      const copySize   = (cc & 0x3F) + 4;
      const copyOffset = ((data[dIdx] & 0x3F) << 8) + data[dIdx + 1];
      dIdx += 2;
      if (uIdx + size + copySize > udata.length) break;
      for (let i = 0; i < size; i++) udata[uIdx++] = data[dIdx++];
      for (let i = 0; i < copySize; i++) udata[uIdx] = udata[uIdx++ - copyOffset - 1];
    } else if (cc <= 0xDF) {
      const size       = cc & 0x3;
      const copySize   = ((cc & 0xC) << 6) + data[dIdx + 2] + 5;
      const copyOffset = ((cc & 0x10) << 12) + (data[dIdx] << 8) + data[dIdx + 1];
      dIdx += 3;
      if (uIdx + size + copySize > udata.length) break;
      for (let i = 0; i < size; i++) udata[uIdx++] = data[dIdx++];
      for (let i = 0; i < copySize; i++) udata[uIdx] = udata[uIdx++ - copyOffset - 1];
    } else if (cc <= 0xFB) {
      const size = ((cc & 0x1F) << 2) + 4;
      if (uIdx + size > udata.length) break;
      for (let i = 0; i < size; i++) udata[uIdx++] = data[dIdx++];
    } else {
      const size = cc & 0x3;
      if (uIdx + size > udata.length) break;
      for (let i = 0; i < size; i++) udata[uIdx++] = data[dIdx++];
    }
  } while (cc < 0xFC);

  return udata;
}

// ─── DBPF Thumbnail Extractor ────────────────────────────────────────────────

// Type IDs que contêm imagens PNG/JPEG — extraídos diretamente do s4pe (ImageResources.txt + ThumbnailResourceHandler)
// Fonte: https://github.com/s4ptacle/Sims4Tools
const THUMBNAIL_TYPES = new Set([
  // ── THUM (miniaturas gerais) ─────────────────────────────────────────
  0x0580A2B4, 0x0580A2B5, 0x0580A2B6,
  0x0589DC44, 0x0589DC45, 0x0589DC46, 0x0589DC47,
  0x05B17698, 0x05B17699, 0x05B1769A,
  0x05B1B524, 0x05B1B525, 0x05B1B526,
  0x2653E3C8, 0x2653E3C9, 0x2653E3CA,
  0x2D4284F0, 0x2D4284F1, 0x2D4284F2,
  0x3C1AF1F2, // CAS Part Thumbnail
  0x3C2A8647, // Buy/Build Thumbnail (válido — registrado no ThumbnailResourceHandler do s4pe)
  0x5B282D45, // Body Part Thumbnail
  0x5DE9DBA0, 0x5DE9DBA1, 0x5DE9DBA2,
  0x626F60CC, 0x626F60CD, 0x626F60CE,
  0x9C925813, // Sim Preset Thumbnail
  0xAD366F95, 0xAD366F96,
  0xCD9DE247, // Sim Featured Outfit Thumbnail
  0xFCEAB65B,
  // ── SNAP (snapshots) ────────────────────────────────────────────────
  0x0580A2CD, 0x0580A2CE, 0x0580A2CF,
  0x6B6D837D, 0x6B6D837E, 0x6B6D837F,
  0x0668F635, // TWNI
  // ── ICON ────────────────────────────────────────────────────────────
  0x2E75C764, 0x2E75C765, 0x2E75C766, 0x2E75C767,
  0xD84E7FC5, 0xD84E7FC6, 0xD84E7FC7,
  // ── IMAG (imagens genéricas) ─────────────────────────────────────────
  0x2F7D0002, // JPEG
  0x2F7D0004, // PNG
]);

const THUMBNAIL_CACHE_PATH = path.join(app.getPath('userData'), 'thumbnail-cache.json');
// Incrementar sempre que a lógica de extração mudar — invalida cache antigo automaticamente
const THUMBNAIL_CACHE_VERSION = 3;
let _thumbnailCache = null;
// QA-01: timer separado do objeto de cache para não ser serializado no JSON
let _thumbnailSaveTimer = null;

function loadThumbnailCache() {
  if (_thumbnailCache) return _thumbnailCache;
  try {
    if (fs.existsSync(THUMBNAIL_CACHE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(THUMBNAIL_CACHE_PATH, 'utf-8'));
      // Se a versão não bater, descarta o cache inteiro (pode ter nulls inválidos de versões antigas)
      if (saved.__version !== THUMBNAIL_CACHE_VERSION) {
        _thumbnailCache = { __version: THUMBNAIL_CACHE_VERSION };
      } else {
        _thumbnailCache = saved;
      }
    } else {
      _thumbnailCache = { __version: THUMBNAIL_CACHE_VERSION };
    }
  } catch (_) { _thumbnailCache = { __version: THUMBNAIL_CACHE_VERSION }; }
  return _thumbnailCache;
}

function saveThumbnailCache() {
  try {
    _thumbnailCache.__version = THUMBNAIL_CACHE_VERSION;
    fs.writeFileSync(THUMBNAIL_CACHE_PATH, JSON.stringify(_thumbnailCache), 'utf-8');
  } catch (_) {}
}

function purgeThumbnailCache(existingPaths) {
  const cache = loadThumbnailCache();
  const pathSet = new Set(existingPaths);
  let dirty = false;
  for (const key of Object.keys(cache)) {
    if (key === '__version') continue; // nunca deletar a chave de versão
    if (!pathSet.has(key)) { delete cache[key]; dirty = true; }
  }
  if (dirty) saveThumbnailCache();
}

// QA-08: limite máximo de entradas no cache (eviction das mais antigas ao ultrapassar)
const THUMBNAIL_CACHE_MAX_ENTRIES = 500;

async function extractThumbnailFromPackage(filePath) {
  const cache = loadThumbnailCache();

  // Check cache: { data, mtime }
  try {
    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;
    if (cache[filePath] && cache[filePath].mtime === mtime) {
      return cache[filePath].data; // may be null = no thumbnail
    }
  } catch (_) { return null; }

  const result = await _readDbpfThumbnail(filePath);

  // Store in cache
  try {
    const stat = fs.statSync(filePath);

    // QA-08: eviction das entradas mais antigas se o cache exceder o limite
    const entries = Object.keys(cache).filter(k => k !== '__version');
    if (entries.length >= THUMBNAIL_CACHE_MAX_ENTRIES) {
      // Remove o primeiro quarto das entradas (as mais antigas no JSON)
      const toRemove = Math.floor(THUMBNAIL_CACHE_MAX_ENTRIES / 4);
      entries.slice(0, toRemove).forEach(k => delete cache[k]);
    }

    cache[filePath] = { mtime: stat.mtimeMs, data: result };
    // QA-01: debounce via variável local, não dentro do objeto cache
    clearTimeout(_thumbnailSaveTimer);
    _thumbnailSaveTimer = setTimeout(saveThumbnailCache, 2000);
  } catch (_) {}

  return result;
}

async function _readDbpfThumbnail(filePath) {
  return new Promise((resolve) => {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');

      // ── Header (96 bytes) ──────────────────────────────────────────────────
      const header = Buffer.alloc(96);
      const bytesRead = fs.readSync(fd, header, 0, 96, 0);
      if (bytesRead < 96) { fs.closeSync(fd); return resolve(null); }

      // Magic check
      if (header.toString('ascii', 0, 4) !== 'DBPF') { fs.closeSync(fd); return resolve(null); }

      const majorVersion = header.readUInt32LE(4);
      if (majorVersion !== 2) { fs.closeSync(fd); return resolve(null); }

      const indexCount  = header.readUInt32LE(36);
      const indexOffset = header.readUInt32LE(64) || header.readUInt32LE(40);

      if (indexCount === 0 || indexOffset === 0) { fs.closeSync(fd); return resolve(null); }

      // ── Index header (const-type flags) ───────────────────────────────────
      const flagsBuf = Buffer.alloc(4);
      fs.readSync(fd, flagsBuf, 0, 4, indexOffset);
      const flags = flagsBuf.readUInt32LE(0);

      const typeConst         = (flags & 0x01) !== 0;
      const groupConst        = (flags & 0x02) !== 0;
      const instanceHighConst = (flags & 0x04) !== 0;

      let constOffset = indexOffset + 4;
      let constType = 0, constGroup = 0, constInstanceHigh = 0;

      if (typeConst) {
        const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, constOffset);
        constType = b.readUInt32LE(0); constOffset += 4;
      }
      if (groupConst) {
        const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, constOffset);
        constGroup = b.readUInt32LE(0); constOffset += 4;
      }
      if (instanceHighConst) {
        const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, constOffset);
        constInstanceHigh = b.readUInt32LE(0); constOffset += 4;
      }

      // ── Entry size ────────────────────────────────────────────────────────
      // Variable fields: type?, group?, instanceHigh?
      // Fixed fields: instanceLow(4) + offset(4) + compressedSize(4) + decompressedSize(4) + compressionType(2) + committed(2) = 20
      const varBytes  = (typeConst ? 0 : 4) + (groupConst ? 0 : 4) + (instanceHighConst ? 0 : 4);
      const entrySize = varBytes + 20;

      // ── Scan entries for thumbnail types ──────────────────────────────────
      for (let i = 0; i < indexCount; i++) {
        const entryStart = constOffset + i * entrySize;
        const entryBuf = Buffer.alloc(entrySize);
        fs.readSync(fd, entryBuf, 0, entrySize, entryStart);

        let pos = 0;
        const type = typeConst ? constType : entryBuf.readUInt32LE(pos);
        if (!typeConst) pos += 4;
        if (!groupConst) pos += 4;         // skip group
        if (!instanceHighConst) pos += 4;  // skip instanceHigh
        pos += 4;                           // skip instanceLow

        const dataOffset      = entryBuf.readUInt32LE(pos); pos += 4;
        const rawCompSize     = entryBuf.readUInt32LE(pos); pos += 4;
        const compressedSize  = rawCompSize & 0x7FFFFFFF;
        const decompressedSize = entryBuf.readUInt32LE(pos); pos += 4;
        const compressionType = entryBuf.readUInt16LE(pos);

        if (!THUMBNAIL_TYPES.has(type >>> 0)) continue;
        if (compressedSize === 0 || compressedSize > 8 * 1024 * 1024) continue; // skip >8MB

        const dataBuf = Buffer.alloc(compressedSize);
        fs.readSync(fd, dataBuf, 0, compressedSize, dataOffset);

        let imageData = dataBuf;

        // Compression types from @s4tk/compression:
        // 0x0000 = Uncompressed
        // 0x5A42 = ZLIB
        // 0xFFFF = InternalCompression (RefPack/LZ — EA proprietary)
        // 0xFFFE = StreamableCompression (skip)
        // 0xFFE0 = DeletedRecord (skip)
        if (compressionType === 0x5A42) {
          try { imageData = zlib.unzipSync(dataBuf); }
          catch (_) {
            try { imageData = zlib.inflateSync(dataBuf); }
            catch (__) { continue; }
          }
        } else if (compressionType === 0xFFFF) {
          // Internal compression — port of Scumbumbo's algorithm via @s4tk/compression
          try { imageData = internalDecompression(dataBuf); }
          catch (_) { continue; }
        } else if (compressionType === 0x0000) {
          imageData = dataBuf;
        } else {
          continue; // unsupported compression type
        }

        // Search for PNG/JPEG magic bytes within the buffer (some resources
        // have a small proprietary header before the actual image data)
        const pngMagic  = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        const jpegMagic = [0xFF, 0xD8, 0xFF];

        let imgOffset = -1;
        let imgType   = null;
        const searchLimit = Math.min(imageData.length - 8, 256); // look in first 256 bytes

        for (let s = 0; s <= searchLimit; s++) {
          if (imgType === null &&
              imageData[s]   === pngMagic[0] && imageData[s+1] === pngMagic[1] &&
              imageData[s+2] === pngMagic[2] && imageData[s+3] === pngMagic[3] &&
              imageData[s+4] === pngMagic[4] && imageData[s+5] === pngMagic[5] &&
              imageData[s+6] === pngMagic[6] && imageData[s+7] === pngMagic[7]) {
            imgOffset = s; imgType = 'png'; break;
          }
          if (imgType === null && s + 3 <= imageData.length &&
              imageData[s] === jpegMagic[0] && imageData[s+1] === jpegMagic[1] &&
              imageData[s+2] === jpegMagic[2]) {
            imgOffset = s; imgType = 'jpeg'; break;
          }
        }

        if (imgOffset >= 0 && imgType) {
          const slice = imageData.slice(imgOffset);

          // ── Formato JFIF+ALFA do TS4 (descoberto no s4pe/ThumbnailResource.cs) ──
          // Miniaturas JPEG do TS4 podem ter um canal alpha separado embutido:
          // bytes 24-27 do JPEG = magic 0x414C4641 ("ALFA" em big-endian)
          // bytes 28-31 = tamanho do PNG alpha em big-endian byte-swapped
          // bytes 32..  = PNG com o canal alpha em escala de cinza
          // O browser não entende esse formato, então precisamos remontá-lo
          // como um PNG RGBA combinando a cor do JPEG com o alpha do PNG embutido.
          if (imgType === 'jpeg' && slice.length > 32) {
            const alfaMagic = slice.readUInt32BE(24);
            if (alfaMagic === 0x414C4641) { // FIX BUG 1: was 0x41464C41 ("AFLA"), correct is 0x414C4641 ("ALFA")
              try {
                // Lê tamanho do alpha — armazenado em big-endian puro (sem byte-swap)
                const alphaLen = slice.readUInt32BE(28);
                if (alphaLen > 0 && 32 + alphaLen <= slice.length) {
                  // Extrai somente o JPEG puro (sem o bloco ALFA)
                  // removendo os 20 bytes extras injetados (offset 12..31)
                  const jpegPure = Buffer.concat([slice.slice(0, 12), slice.slice(32 + alphaLen)]);
                  fs.closeSync(fd);
                  // Retorna o JPEG puro — o alpha é decorativo na maioria dos casos
                  // e navegadores exibem o JPEG normalmente sem ele
                  return resolve(`data:image/jpeg;base64,` + jpegPure.toString('base64'));
                }
              } catch (_) { /* fallback para o slice original abaixo */ }
            }
          }

          fs.closeSync(fd);
          return resolve(`data:image/${imgType};base64,` + slice.toString('base64'));
        }
      }

      fs.closeSync(fd);
      resolve(null);
    } catch (e) {
      try { if (fd !== undefined) fs.closeSync(fd); } catch (_) {}
      resolve(null);
    }
  });
}

// ─── Mod Scanning ────────────────────────────────────────────────────────────

function walkFolder(dir, baseFolder, results = [], depth = 0) {
  if (!fs.existsSync(dir)) return results;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return results; }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // skip symlinks to prevent directory traversal
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFolder(fullPath, baseFolder, results, depth + 1);
    } else if (entry.isFile()) {
      results.push({ fullPath, depth });
    }
  }
  return results;
}

function buildModObject(fullPath, baseFolder, type) {
  let stat;
  try { stat = fs.statSync(fullPath); }
  catch (e) { return null; }

  const realName = getRealName(fullPath);
  const ext = getRealExtension(fullPath);
  const relativePath = path.relative(baseFolder, fullPath);
  const folder = path.relative(baseFolder, path.dirname(fullPath)) || '/';
  const depth = getFileDepth(fullPath, baseFolder);
  const enabled = isEnabled(fullPath);

  return {
    id: crypto.createHash('md5').update(fullPath).digest('hex'),
    name: realName,
    path: fullPath,
    relativePath,
    extension: ext,
    type,
    size: stat.size,
    depth,
    enabled,
    folder,
    lastModified: stat.mtime.toISOString()
  };
}

function scanModsFolder(modsFolder) {
  const results = [];
  if (!fs.existsSync(modsFolder)) return results;
  const allFiles = walkFolder(modsFolder, modsFolder);

  for (const { fullPath } of allFiles) {
    const ext = getRealExtension(fullPath);
    let type = null;
    if (MOD_EXTENSIONS.includes(ext)) {
      type = ext === '.ts4script' ? 'script' : 'package';
    } else if (TRAY_EXTENSIONS.includes(ext)) {
      type = 'tray-in-mods'; // misplaced
    }
    if (type) {
      const mod = buildModObject(fullPath, modsFolder, type);
      if (mod) results.push(mod);
    }
  }
  return results;
}

function scanTrayFolder(trayFolder) {
  const results = [];
  if (!fs.existsSync(trayFolder)) return results;
  const allFiles = walkFolder(trayFolder, trayFolder);

  for (const { fullPath } of allFiles) {
    const ext = getRealExtension(fullPath);
    if (TRAY_EXTENSIONS.includes(ext)) {
      const mod = buildModObject(fullPath, trayFolder, 'tray');
      if (mod) {
        // Extract GUID from filename: "0x00000002!0x0aa91626bff44d02.trayitem" → "0x0aa91626bff44d02"
        // Also handles duplicates like "0x...!0xguid (3).trayitem"
        const guidMatch = path.basename(fullPath).match(/!([0-9a-fx]+)(?:\s|\.|$)/i);
        mod.trayGuid = guidMatch ? guidMatch[1].toLowerCase() : null;
        results.push(mod);
      }
    } else if (MOD_EXTENSIONS.includes(ext)) {
      const mod = buildModObject(fullPath, trayFolder, 'mods-in-tray'); // misplaced
      if (mod) results.push(mod);
    }
  }
  return results;
}

// ─── Mod Operations ──────────────────────────────────────────────────────────

function toggleMod(filePath) {
  const newPath = getDisabledPath(filePath);
  try {
    fs.renameSync(filePath, newPath);
    return { success: true, oldPath: filePath, newPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function toggleFolder(folderPath, modsFolder) {
  const allFiles = walkFolder(folderPath, modsFolder);
  const results = [];

  for (const { fullPath } of allFiles) {
    const ext = getRealExtension(fullPath);
    if ([...MOD_EXTENSIONS, ...TRAY_EXTENSIONS].includes(ext)) {
      const result = toggleMod(fullPath);
      results.push(result);
    }
  }
  return results;
}

async function deleteMod(filePath) {
  try {
    await shell.trashItem(filePath);
    return { success: true, path: filePath };
  } catch (e) {
    return { success: false, path: filePath, error: e.message };
  }
}

function moveFile(fromPath, toPath) {
  try {
    ensureDir(path.dirname(toPath));
    fs.renameSync(fromPath, toPath);
    return { success: true, from: fromPath, to: toPath };
  } catch (e) {
    try {
      fs.copyFileSync(fromPath, toPath);
      fs.unlinkSync(fromPath);
      return { success: true, from: fromPath, to: toPath };
    } catch (e2) {
      return { success: false, error: e2.message };
    }
  }
}

// ─── Import Files ────────────────────────────────────────────────────────────

function copyModFile(src, modsFolder, trayFolder) {
  const ext = getRealExtension(src);
  let dest;
  if (MOD_EXTENSIONS.includes(ext)) {
    dest = path.join(modsFolder, path.basename(src));
  } else if (TRAY_EXTENSIONS.includes(ext)) {
    dest = path.join(trayFolder, path.basename(src));
  } else {
    return null;
  }
  // Handle duplicate filenames
  let finalDest = dest;
  let counter = 1;
  const MAX_COPIES = 999;
  const baseName = path.basename(dest);
  const disabledSuffix = baseName.endsWith(DISABLED_SUFFIX) ? DISABLED_SUFFIX : '';
  const nameWithoutDisabled = disabledSuffix ? baseName.slice(0, -disabledSuffix.length) : baseName;
  const stem = path.basename(nameWithoutDisabled, ext);
  while (fs.existsSync(finalDest) && counter <= MAX_COPIES) {
    finalDest = path.join(path.dirname(dest), `${stem} (${counter})${ext}${disabledSuffix}`);
    counter++;
  }
  // QA-09: se ultrapassar o limite, lança erro em vez de loop infinito
  if (counter > MAX_COPIES) {
    throw new Error(`Muitas cópias existentes de "${path.basename(dest)}" no destino`);
  }
  fs.copyFileSync(src, finalDest);
  return finalDest;
}

function collectModFiles(dir, found = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return found; }
  for (const entry of entries) {
    // SEC-05: ignorar symlinks para evitar loop infinito em zips com symlinks circulares
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectModFiles(fullPath, found);
    } else {
      const ext = getRealExtension(entry.name);
      if ([...MOD_EXTENSIONS, ...TRAY_EXTENSIONS].includes(ext)) {
        found.push(fullPath);
      }
    }
  }
  return found;
}

async function importFiles(filePaths, modsFolder, trayFolder) {
  const imported = [];
  const errors = [];
  const sevenZip = findSevenZip();

  for (const src of filePaths) {
    const ext = getRealExtension(src);

    if ([...MOD_EXTENSIONS, ...TRAY_EXTENSIONS].includes(ext)) {
      try {
        const dest = copyModFile(src, modsFolder, trayFolder);
        if (dest) imported.push(dest);
      } catch (e) {
        errors.push({ file: src, error: e.message });
      }
    } else if (ARCHIVE_EXTENSIONS.includes(ext)) {
      const tempDir = path.join(DEFAULT_CONFIG.tempFolder, `extract_${Date.now()}`);
      ensureDir(tempDir);
      try {
        await extractArchive(src, tempDir, sevenZip);
        const modFiles = collectModFiles(tempDir);
        for (const mf of modFiles) {
          const dest = copyModFile(mf, modsFolder, trayFolder);
          if (dest) imported.push(dest);
        }
      } catch (e) {
        errors.push({ file: src, error: e.message });
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }
    } else {
      errors.push({ file: src, error: 'Tipo de arquivo não suportado' });
    }
  }
  return { imported, errors };
}

function extractArchive(archivePath, destDir, sevenZipPath) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(archivePath).toLowerCase();

    if (ext === '.zip' && !sevenZipPath) {
      // Use extract-zip for .zip when 7-Zip not available
      try {
        const extractZip = require('extract-zip');
        extractZip(archivePath, { dir: destDir }).then(resolve).catch(reject);
      } catch (e) {
        reject(new Error('extract-zip não encontrado. Instale 7-Zip para suporte completo.'));
      }
      return;
    }

    if (!sevenZipPath) {
      reject(new Error(`7-Zip não encontrado. Para extrair ${ext}, instale 7-Zip em C:\\Program Files\\7-Zip\\`));
      return;
    }

    // SEC-04: timeout de 2 minutos para evitar que um arquivo malicioso trave o processo indefinidamente
    const child = execFile(sevenZipPath, ['x', archivePath, `-o${destDir}`, '-y', '-aoa'], (err) => {
      if (err) reject(new Error(`Falha na extração: ${err.message}`));
      else resolve();
    });
    const extractTimeout = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      reject(new Error('Extração cancelada: tempo limite de 2 minutos excedido'));
    }, 120_000);
    child.on('close', () => clearTimeout(extractTimeout));
  });
}

// ─── Conflict Detection ──────────────────────────────────────────────────────

// Active cancellation token — replaced on each new scan, set to cancelled on cancel request.
let _conflictCancelToken = null;

async function scanConflicts(modsFolder, sender, cancelToken) {
  const conflicts = [];
  const allFiles = walkFolder(modsFolder, modsFolder);
  const modFiles = allFiles.filter(({ fullPath }) =>
    MOD_EXTENSIONS.includes(getRealExtension(fullPath))
  );

  const total = modFiles.length;

  // Helper to safely send progress (sender may be null in tests)
  function sendProgress(done, phase) {
    try { sender?.send('conflicts:progress', { done, total, phase }); } catch (_) {}
  }

  // Phase 1 — same-name check (instant, no I/O — send a single update)
  sendProgress(0, 'names');

  const nameMap = {};
  for (const { fullPath } of modFiles) {
    const name = getRealName(fullPath).toLowerCase();
    if (!nameMap[name]) nameMap[name] = [];
    nameMap[name].push(fullPath);
  }
  for (const [name, paths] of Object.entries(nameMap)) {
    if (paths.length > 1) {
      // Check if it's OS-generated duplicate (e.g. "file (2).package")
      const isOsDuplicate = paths.some(p => / \(\d+\)(\.\w+)*(\.disabled)?$/.test(p));
      conflicts.push({
        // QA-07: SHA-256 em vez de MD5 para evitar colisões de ID na UI
        id: crypto.createHash('sha256').update(name).digest('hex').slice(0, 32),
        type: isOsDuplicate ? 'os-duplicate' : 'same-name',
        label: isOsDuplicate ? 'Duplicata do sistema' : 'Mesmo nome',
        files: paths.map(p => ({
          path: p,
          name: getRealName(p),
          size: (() => { try { return fs.statSync(p).size; } catch(_) { return 0; } })(),
          enabled: isEnabled(p)
        }))
      });
    }
  }

  // Phase 2 — hash duplicates (reads every file — send progress per file)
  const hashMap = {};
  for (let i = 0; i < modFiles.length; i++) {
    // Check cancellation before each file read
    if (cancelToken?.cancelled) return null;

    const { fullPath } = modFiles[i];
    sendProgress(i + 1, 'hashes');
    try {
      const hash = await getFileHash(fullPath);
      if (!hashMap[hash]) hashMap[hash] = [];
      hashMap[hash].push(fullPath);
    } catch (_) {}
  }

  if (cancelToken?.cancelled) return null;

  for (const [hash, paths] of Object.entries(hashMap)) {
    if (paths.length > 1) {
      // Avoid duplicating conflicts already found by name
      const names = paths.map(p => getRealName(p).toLowerCase());
      const allSameName = names.every(n => n === names[0]);
      if (!allSameName) {
        conflicts.push({
          id: 'hash_' + hash,
          type: 'hash-duplicate',
          label: 'Conteúdo idêntico',
          hash,
          files: paths.map(p => ({
            path: p,
            name: getRealName(p),
            size: (() => { try { return fs.statSync(p).size; } catch(_) { return 0; } })(),
            enabled: isEnabled(p)
          }))
        });
      }
    }
  }

  return conflicts;
}

// ─── Auto Organize ───────────────────────────────────────────────────────────

function scanMisplaced(modsFolder, trayFolder) {
  const misplaced = [];
  // Track destinations already assigned in THIS scan to avoid name collisions
  // between items that would be moved to the same folder (Bug B).
  const assignedDests = new Set();

  // Helper: build a safe destination path that preserves the .disabled suffix,
  // avoids overwriting an existing file on disk AND avoids colliding with another
  // item already queued in this same scan batch.
  function safeDestFor(fullPath, destFolder) {
    const baseName = path.basename(fullPath); // keep .disabled suffix if present
    let dest = path.join(destFolder, baseName);
    let counter = 1;
    while ((fs.existsSync(dest) && dest !== fullPath) || assignedDests.has(dest)) {
      const ext = path.extname(baseName);
      const stem = baseName.slice(0, baseName.length - ext.length);
      dest = path.join(destFolder, `${stem} (${++counter})${ext}`);
    }
    assignedDests.add(dest);
    return dest;
  }

  // .ts4script files deeper than 1 subfolder
  const modsFiles = walkFolder(modsFolder, modsFolder);
  for (const { fullPath, depth } of modsFiles) {
    const ext = getRealExtension(fullPath);
    if (ext === '.ts4script' && depth > 1) {
      const suggestedDest = safeDestFor(fullPath, modsFolder);
      misplaced.push({
        path: fullPath,
        name: getRealName(fullPath),
        issue: `Script ${depth} níveis abaixo (máx: 1)`,
        type: 'too-deep',
        suggestedDest,
        size: (() => { try { return fs.statSync(fullPath).size; } catch(_) { return 0; } })()
      });
    }
    // Tray files in Mods folder
    if (TRAY_EXTENSIONS.includes(ext)) {
      const suggestedDest = safeDestFor(fullPath, trayFolder);
      misplaced.push({
        path: fullPath,
        name: getRealName(fullPath),
        issue: 'Arquivo de Tray na pasta Mods',
        type: 'wrong-folder',
        suggestedDest,
        size: (() => { try { return fs.statSync(fullPath).size; } catch(_) { return 0; } })()
      });
    }
  }

  // Mod files in Tray folder
  if (fs.existsSync(trayFolder)) {
    const trayFiles = walkFolder(trayFolder, trayFolder);
    for (const { fullPath } of trayFiles) {
      const ext = getRealExtension(fullPath);
      if (MOD_EXTENSIONS.includes(ext)) {
        const suggestedDest = safeDestFor(fullPath, modsFolder);
        misplaced.push({
          path: fullPath,
          name: getRealName(fullPath),
          issue: 'Arquivo de Mod na pasta Tray',
          type: 'wrong-folder',
          suggestedDest,
          size: (() => { try { return fs.statSync(fullPath).size; } catch(_) { return 0; } })()
        });
      }
    }
  }

  return misplaced;
}

/**
 * Detecta arquivos inválidos nas pastas Mods e Tray — extensões que não
 * pertencem a nenhum formato reconhecido pelo jogo.
 * Categorias:
 *   'archive'  – .zip / .rar / .7z  (provavelmente não foi extraído)
 *   'unknown'  – qualquer outra extensão estranha
 * Arquivos de sistema comuns (Thumbs.db, desktop.ini, .DS_Store…) são
 * ignorados para não gerar falsos positivos.
 */
function scanInvalidFiles(modsFolder, trayFolder) {
  const ALL_VALID = new Set([
    ...MOD_EXTENSIONS,
    ...TRAY_EXTENSIONS,
    ...ARCHIVE_EXTENSIONS, // tratados separadamente mas ainda "detectados"
  ]);
  const SYSTEM_IGNORE = new Set([
    'thumbs.db', 'desktop.ini', '.ds_store', '.localized',
    'folder.jpg', 'folder.png', 'albumart.jpg',
  ]);
  const IGNORE_EXTENSIONS = new Set(['.cfg', '.ini', '.txt', '.json', '.log']);

  const invalid = [];

  function scanFolder(baseFolder, folderLabel) {
    if (!baseFolder || !fs.existsSync(baseFolder)) return;
    const files = walkFolder(baseFolder, baseFolder);
    for (const { fullPath } of files) {
      const basename = path.basename(fullPath);
      if (SYSTEM_IGNORE.has(basename.toLowerCase())) continue;

      // Strip .disabled suffix to find the real extension
      const realExt = getRealExtension(fullPath);   // already handles .disabled
      if (ALL_VALID.has(realExt)) continue;          // recognised → skip
      if (IGNORE_EXTENSIONS.has(realExt)) continue; // config/support files → skip

      const relative = path.relative(baseFolder, path.dirname(fullPath));
      const folder   = relative || '/';
      let size = 0;
      try { size = fs.statSync(fullPath).size; } catch (_) {}

      const isArchive = ARCHIVE_EXTENSIONS.includes(realExt);
      invalid.push({
        path:    fullPath,
        name:    basename,
        ext:     realExt || path.extname(basename).toLowerCase() || '(sem extensão)',
        folder,
        folderType: folderLabel,   // 'mods' | 'tray'
        size,
        category: isArchive ? 'archive' : 'unknown',
        reason:   isArchive
          ? `Arquivo compactado não extraído (${realExt})`
          : `Extensão não reconhecida pelo jogo (${realExt || 'sem extensão'})`,
      });
    }
  }

  scanFolder(modsFolder,  'mods');
  scanFolder(trayFolder,  'tray');
  return invalid;
}

/**
 * Detecta grupos de mods (mesmo prefixo de nome) cujos arquivos estão
 * espalhados em pastas diferentes. Retorna grupos onde a consolidação
 * faria sentido (2+ arquivos, 2+ pastas distintas).
 */
function scanScatteredGroups(modsFolder) {
  const modsFiles = walkFolder(modsFolder, modsFolder);
  const prefixMap = new Map(); // prefix → [{path, name, folder, size}]

  for (const { fullPath } of modsFiles) {
    const ext = getRealExtension(fullPath);
    if (!MOD_EXTENSIONS.includes(ext)) continue;

    const rawName = path.basename(fullPath);
    // Mesmo algoritmo de getModPrefix do renderer
    const base = rawName.replace(/\.(disabled)$/i, '').replace(/\.[^.]+$/, '');
    const idx = base.indexOf('_');
    if (idx < 2) continue;
    const prefix = base.slice(0, idx).toLowerCase();

    const relativePath = path.relative(modsFolder, fullPath);
    const folder = path.dirname(relativePath) || '/';
    const size = (() => { try { return fs.statSync(fullPath).size; } catch(_) { return 0; } })();

    if (!prefixMap.has(prefix)) prefixMap.set(prefix, []);
    prefixMap.get(prefix).push({ path: fullPath, name: rawName, folder, size });
  }

  const scattered = [];
  for (const [prefix, files] of prefixMap) {
    if (files.length < 2) continue;
    const folders = [...new Set(files.map(f => f.folder))];
    if (folders.length < 2) continue; // todos na mesma pasta — não é disperso

    // Pasta de destino: a que tem mais arquivos (ou a mais rasa)
    const folderCount = {};
    for (const f of files) folderCount[f.folder] = (folderCount[f.folder] || 0) + 1;
    const targetFolder = Object.entries(folderCount)
      .sort((a, b) => b[1] - a[1] || a[0].split(/[/\\]/).length - b[0].split(/[/\\]/).length)[0][0];
    const targetFolderAbs = targetFolder === '/'
      ? modsFolder
      : path.join(modsFolder, ...targetFolder.split(/[/\\]/));

    scattered.push({
      prefix,
      name: files.find(f => f.name.replace(/\.(disabled)$/i, '').endsWith('.package'))?.name || files[0].name,
      files,
      folders,
      targetFolder,
      targetFolderAbs,
      totalSize: files.reduce((s, f) => s + f.size, 0),
    });
  }

  return scattered;
}

function fixMisplaced(items) {
  const results = [];
  for (const item of items) {
    const result = moveFile(item.path, item.suggestedDest);
    results.push({ ...result, item });
  }
  return results;
}

// ─── Empty Folder Scanner ─────────────────────────────────────────────────────

/**
 * Returns true if a directory has NO files anywhere inside it
 * (it may have nested subdirectories, but all are empty too).
 */
function hasAnyFile(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return false; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasAnyFile(full)) return true;
  }
  return false;
}

/**
 * Walks a root folder and collects every subdirectory that is empty
 * (no files at any depth). The root itself is never included.
 */
function scanEmptyFolders(rootFolder) {
  const empty = [];
  if (!fs.existsSync(rootFolder)) return empty;

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (!hasAnyFile(full)) {
        empty.push({
          path: full,
          name: entry.name,
          relativePath: path.relative(rootFolder, full),
        });
      } else {
        walk(full); // recurse — only look deeper inside non-empty dirs
      }
    }
  }

  walk(rootFolder);
  return empty;
}

/**
 * Deletes a list of empty folder paths.
 * Uses fs.rmSync with recursive:true only after re-confirming the folder
 * contains no files, as a safety guard against race conditions.
 */
function deleteEmptyFolders(folderPaths) {
  const results = [];
  for (const folderPath of folderPaths) {
    try {
      if (!fs.existsSync(folderPath)) {
        results.push({ success: true, path: folderPath }); // already gone
        continue;
      }
      if (hasAnyFile(folderPath)) {
        results.push({ success: false, path: folderPath, error: 'Pasta não está vazia' });
        continue;
      }
      fs.rmSync(folderPath, { recursive: true });
      results.push({ success: true, path: folderPath });
    } catch (e) {
      results.push({ success: false, path: folderPath, error: e.message });
    }
  }
  return results;
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

// Config
ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('config:set', (_, config) => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  // Rejeita campos não-string onde string é esperada
  const stringFields = ['modsFolder', 'trayFolder', 'tempFolder', 'theme'];
  for (const field of stringFields) {
    if (field in config && typeof config[field] !== 'string') return false;
  }
  // Impede apontar pastas do jogo para diretórios do sistema ou seus subdirectórios
  // SEC-01: startsWith bloqueia também subdirectórios (e.g. /etc/cron.d, C:\Windows\System32)
  const BLOCKED = [
    os.homedir(),
    app.getPath('userData'),
    process.env.SystemRoot || 'C:\\Windows',
    '/etc', '/bin', '/usr', '/sbin', '/var', '/sys', '/proc',
    'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\Windows',
  ].map(p => p && path.resolve(p)).filter(Boolean);
  for (const field of ['modsFolder', 'trayFolder']) {
    if (config[field]) {
      const resolved = path.resolve(config[field]);
      if (BLOCKED.some(b => resolved === b || resolved.startsWith(b + require('path').sep))) return false;
    }
  }
  // QA-03: impede modsFolder e trayFolder de apontarem para o mesmo diretório
  if (config.modsFolder && config.trayFolder) {
    if (require('path').resolve(config.modsFolder) === require('path').resolve(config.trayFolder)) return false;
  }
  writeConfig(config);
  return true;
});

// Mods scanning
ipcMain.handle('mods:scan', (_, modsFolder) => {
  if (!modsFolder || typeof modsFolder !== 'string') return [];
  const roots = getAllowedRoots();
  // SEC-03: bloqueia pastas fora das raízes permitidas
  if (roots.length && !isPathSafe(modsFolder, ...roots)) return [];
  return scanModsFolder(modsFolder);
});
ipcMain.handle('tray:scan', (_, trayFolder) => {
  if (!trayFolder || typeof trayFolder !== 'string') return [];
  // SEC-03: validar caminho (consistente com mods:scan)
  const roots = getAllowedRoots();
  if (roots.length && !isPathSafe(trayFolder, ...roots)) return [];
  return scanTrayFolder(trayFolder);
});

// Mod operations
ipcMain.handle('mods:toggle', (_, filePath) => {
  if (!isPathSafe(filePath, ...getAllowedRoots())) return { success: false, error: 'Caminho não permitido' };
  return toggleMod(filePath);
});
ipcMain.handle('mods:toggle-folder', (_, folderPath, modsFolder) => {
  if (!isPathSafe(folderPath, ...getAllowedRoots())) return [];
  return toggleFolder(folderPath, modsFolder);
});
ipcMain.handle('mods:delete', async (_, filePaths) => {
  const roots = getAllowedRoots();
  const results = [];
  for (const fp of filePaths) {
    if (!isPathSafe(fp, ...roots)) { results.push({ success: false, path: fp, error: 'Caminho não permitido' }); continue; }
    results.push(await deleteMod(fp));
  }
  return results;
});
ipcMain.handle('mods:move', (_, from, to) => {
  const roots = getAllowedRoots();
  if (!isPathSafe(from, ...roots) || !isPathSafe(to, ...roots)) return { success: false, error: 'Caminho não permitido' };
  return moveFile(from, to);
});
ipcMain.handle('mods:import', async (_, filePaths, modsFolder, trayFolder) => {
  // QA-06: validar tipos dos parâmetros
  if (!Array.isArray(filePaths)) return { imported: [], errors: [] };
  if (typeof modsFolder !== 'string' || typeof trayFolder !== 'string')
    return { imported: [], errors: [{ error: 'Parâmetro de pasta inválido' }] };
  // SEC-02: validar se destinos estão dentro das raízes permitidas
  const roots = getAllowedRoots();
  if (!isPathSafe(modsFolder, ...roots) || !isPathSafe(trayFolder, ...roots))
    return { imported: [], errors: [{ error: 'Pasta de destino não permitida' }] };
  // Nada para importar — retorna cedo após validações (sem arquivos, sem trabalho)
  if (filePaths.length === 0) return { imported: [], errors: [] };
  return importFiles(filePaths, modsFolder, trayFolder);
});

// Conflicts
ipcMain.handle('conflicts:scan', async (event, modsFolder) => {
  if (!modsFolder || typeof modsFolder !== 'string') return [];
  // Create a fresh token for this scan, invalidating any previous one
  const token = { cancelled: false };
  _conflictCancelToken = token;
  return scanConflicts(modsFolder, event.sender, token);
});
ipcMain.on('conflicts:cancel', () => {
  if (_conflictCancelToken) _conflictCancelToken.cancelled = true;
});
ipcMain.handle('conflicts:move-to-trash', (_, filePath) => {
  if (!isPathSafe(filePath, ...getAllowedRoots())) return { success: false, error: 'Caminho não permitido' };
  const trashDir = path.join(app.getPath('userData'), 'trash');
  ensureDir(trashDir);
  // SEC-02: adicionar componente aleatório ao slug para evitar colisão de nomes
  // (dois arquivos com mesmo basename enviados para trash no mesmo milissegundo)
  const slug = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${path.basename(filePath)}`;
  const dest = path.join(trashDir, slug);
  const result = moveFile(filePath, dest);
  if (result.success) {
    try {
      fs.writeFileSync(dest + '.meta.json', JSON.stringify({
        originalPath: filePath,
        trashedAt: new Date().toISOString(),
        source: 'conflicts',
      }));
    } catch (_) {}
  }
  return { ...result, to: dest };
});
ipcMain.handle('conflicts:restore-from-trash', (_, trashPath, originalPath) => {
  const trashDir = path.join(app.getPath('userData'), 'trash');
  const roots = getAllowedRoots();
  // trashPath deve estar na lixeira interna; originalPath deve estar nas raízes permitidas
  if (!isPathSafe(trashPath, trashDir)) return { success: false, error: 'Origem não é da lixeira interna' };
  if (!isPathSafe(originalPath, ...roots)) return { success: false, error: 'Destino não permitido' };
  return moveFile(trashPath, originalPath);
});

// Organizer
ipcMain.handle('organize:scan', (_, modsFolder, trayFolder) => {
  if (!modsFolder || typeof modsFolder !== 'string') return [];
  if (!trayFolder || typeof trayFolder !== 'string') return [];
  return scanMisplaced(modsFolder, trayFolder);
});
ipcMain.handle('organize:fix', (_, items) => {
  // SEC-01 / QA-05: validar todos os caminhos antes de mover.
  // Itens inválidos ou fora das roots são pulados individualmente —
  // não abortam o lote inteiro (fix do fail-fast).
  if (!Array.isArray(items)) return [];
  const roots = getAllowedRoots();
  const safeItems = items.filter(item => {
    if (!item || !item.path || !item.suggestedDest) return false;
    return isPathSafe(item.path, ...roots) && isPathSafe(item.suggestedDest, ...roots);
  });
  // Preservar alinhamento de índices com o array original para o renderer
  // saber quais itens foram pulados (resultado undefined → não movido)
  return items.map(item => {
    if (!item || !item.path || !item.suggestedDest) return { success: false, error: 'Item inválido' };
    if (!isPathSafe(item.path, ...roots) || !isPathSafe(item.suggestedDest, ...roots))
      return { success: false, error: 'Caminho não permitido' };
    return moveFile(item.path, item.suggestedDest);
  });
});
ipcMain.handle('organize:fix-one', (_, item) => {
  if (!item || !item.path || !item.suggestedDest) return { success: false, error: 'Item inválido' };
  const roots = getAllowedRoots();
  if (!isPathSafe(item.path, ...roots) || !isPathSafe(item.suggestedDest, ...roots)) {
    return { success: false, error: 'Caminho não permitido' };
  }
  return moveFile(item.path, item.suggestedDest);
});

ipcMain.handle('organize:scan-scattered', (_, modsFolder) => {
  if (!modsFolder || typeof modsFolder !== 'string') return [];
  const roots = getAllowedRoots();
  if (roots.length && !isPathSafe(modsFolder, ...roots)) return [];
  return scanScatteredGroups(modsFolder);
});

ipcMain.handle('organize:scan-empty-folders', (_, modsFolder, trayFolder) => {
  const results = [];
  if (modsFolder && typeof modsFolder === 'string' && fs.existsSync(modsFolder)) {
    results.push(...scanEmptyFolders(modsFolder));
  }
  if (trayFolder && typeof trayFolder === 'string' && fs.existsSync(trayFolder)) {
    results.push(...scanEmptyFolders(trayFolder));
  }
  return results;
});

ipcMain.handle('organize:scan-invalid', (_, modsFolder, trayFolder) => {
  const roots = getAllowedRoots();
  if (modsFolder && roots.length && !isPathSafe(modsFolder, ...roots)) return [];
  return scanInvalidFiles(modsFolder, trayFolder);
});

ipcMain.handle('organize:delete-invalid', async (_, filePaths) => {
  if (!Array.isArray(filePaths)) return [];
  const roots = getAllowedRoots();
  const results = [];
  for (const filePath of filePaths) {
    if (!filePath || (roots.length && !isPathSafe(filePath, ...roots))) {
      results.push({ success: false, path: filePath, error: 'Caminho não permitido' });
      continue;
    }
    results.push(await deleteMod(filePath));
  }
  return results;
});

ipcMain.handle('organize:delete-empty-folders', (_, folderPaths) => {
  if (!Array.isArray(folderPaths)) return [];
  const roots = getAllowedRoots();
  const safe = folderPaths.filter(p => p && isPathSafe(p, ...roots));
  return deleteEmptyFolders(safe);
});

// Dialogs
ipcMain.handle('dialog:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('dialog:open-files', async (_, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: filters || [
      { name: 'Mods e Arquivos', extensions: ['package', 'ts4script', 'trayitem', 'blueprint', 'bpi', 'hhi', 'sgi', 'householdbinary', 'room', 'rmi', 'zip', 'rar', '7z'] },
      { name: 'Todos os Arquivos', extensions: ['*'] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
});

// Shell
ipcMain.handle('shell:open', (_, folderPath) => {
  if (!folderPath || typeof folderPath !== 'string') return;
  return shell.openPath(folderPath);
});

ipcMain.handle('shell:show-item', (_, filePath) => {
  if (!filePath || typeof filePath !== 'string') return;
  shell.showItemInFolder(filePath);
});

// ─── localthumbcache.package fallback ────────────────────────────────────────
// A maioria dos mods do TS4 não embute miniaturas nos próprios .package files.
// O jogo gera as miniaturas dinamicamente e as armazena em localthumbcache.package
// dentro da pasta Documents\Electronic Arts\The Sims 4.
// Esta função extrai a miniatura de um mod a partir desse cache usando o
// instance ID do primeiro recurso CAS/Build de qualquer tipo thumbnail do mod.

const LOCALTHUMB_CACHE_PATH = path.join(
  os.homedir(), 'Documents', 'Electronic Arts', 'The Sims 4', 'localthumbcache.package'
);

// Tipos de recursos cujo instance ID é usado como chave no localthumbcache
const INSTANCE_SOURCE_TYPES = new Set([
  0x034AEECB, // CAS Part (CASP) — mais comum em CC de roupa/cabelo
  0x3C1AF1F2, // CAS Part Thumbnail
  0x5B282D45, // Body Part Thumbnail
  0xCD9DE247, // Thumbnails (Buy/Build)
  0x9C925813, // Sim Preset Thumbnail
  0x319E4F1D, // Object Catalog (COBJ) — objetos de Build/Buy
]);

async function extractThumbnailFromLocalCache(modFilePath) {
  // 1. Extrai os instance IDs dos recursos do mod
  const instanceIds = await _readDbpfInstanceIds(modFilePath);
  if (!instanceIds.length) return null;

  // 2. Abre o localthumbcache.package e procura por esses IDs
  return await _readDbpfThumbnailByInstances(LOCALTHUMB_CACHE_PATH, instanceIds);
}

async function _readDbpfInstanceIds(filePath) {
  return new Promise((resolve) => {
    let fd;
    const ids = [];
    try {
      fd = fs.openSync(filePath, 'r');
      const header = Buffer.alloc(96);
      if (fs.readSync(fd, header, 0, 96, 0) < 96) { fs.closeSync(fd); return resolve(ids); }
      if (header.toString('ascii', 0, 4) !== 'DBPF') { fs.closeSync(fd); return resolve(ids); }
      if (header.readUInt32LE(4) !== 2) { fs.closeSync(fd); return resolve(ids); }

      const indexCount  = header.readUInt32LE(36);
      const indexOffset = header.readUInt32LE(64) || header.readUInt32LE(40);
      if (!indexCount || !indexOffset) { fs.closeSync(fd); return resolve(ids); }

      const flagsBuf = Buffer.alloc(4);
      fs.readSync(fd, flagsBuf, 0, 4, indexOffset);
      const flags = flagsBuf.readUInt32LE(0);
      const typeConst         = (flags & 0x01) !== 0;
      const groupConst        = (flags & 0x02) !== 0;
      const instanceHighConst = (flags & 0x04) !== 0;

      let constOffset = indexOffset + 4;
      let constType = 0, constInstanceHigh = 0;
      if (typeConst)         { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, constOffset); constType = b.readUInt32LE(0); constOffset += 4; }
      if (groupConst)        { constOffset += 4; }
      if (instanceHighConst) { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, constOffset); constInstanceHigh = b.readUInt32LE(0); constOffset += 4; }

      const varBytes  = (typeConst ? 0 : 4) + (groupConst ? 0 : 4) + (instanceHighConst ? 0 : 4);
      const entrySize = varBytes + 20;

      for (let i = 0; i < Math.min(indexCount, 500); i++) {
        const entryStart = constOffset + i * entrySize;
        const entryBuf = Buffer.alloc(entrySize);
        fs.readSync(fd, entryBuf, 0, entrySize, entryStart);

        let pos = 0;
        const type = typeConst ? constType : entryBuf.readUInt32LE(pos);
        if (!typeConst) pos += 4;
        if (!groupConst) pos += 4;
        const instanceHigh = instanceHighConst ? constInstanceHigh : entryBuf.readUInt32LE(pos);
        if (!instanceHighConst) pos += 4;
        const instanceLow = entryBuf.readUInt32LE(pos);

        if (INSTANCE_SOURCE_TYPES.has(type >>> 0)) {
          ids.push({ high: instanceHigh, low: instanceLow });
        }
      }
      fs.closeSync(fd);
      resolve(ids);
    } catch (e) {
      try { if (fd !== undefined) fs.closeSync(fd); } catch (_) {}
      resolve(ids);
    }
  });
}

async function _readDbpfThumbnailByInstances(cachePath, instanceIds) {
  if (!fs.existsSync(cachePath)) return null;
  return new Promise((resolve) => {
    let fd;
    try {
      fd = fs.openSync(cachePath, 'r');
      const header = Buffer.alloc(96);
      if (fs.readSync(fd, header, 0, 96, 0) < 96) { fs.closeSync(fd); return resolve(null); }
      if (header.toString('ascii', 0, 4) !== 'DBPF') { fs.closeSync(fd); return resolve(null); }

      const indexCount  = header.readUInt32LE(36);
      const indexOffset = header.readUInt32LE(64) || header.readUInt32LE(40);
      if (!indexCount || !indexOffset) { fs.closeSync(fd); return resolve(null); }

      const flagsBuf = Buffer.alloc(4);
      fs.readSync(fd, flagsBuf, 0, 4, indexOffset);
      const flags = flagsBuf.readUInt32LE(0);
      const typeConst         = (flags & 0x01) !== 0;
      const groupConst        = (flags & 0x02) !== 0;
      const instanceHighConst = (flags & 0x04) !== 0;

      let constOffset = indexOffset + 4;
      let constType = 0, constGroup = 0, constInstanceHigh = 0;
      if (typeConst)         { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, constOffset); constType = b.readUInt32LE(0); constOffset += 4; }
      if (groupConst)        { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, constOffset); constGroup = b.readUInt32LE(0); constOffset += 4; }
      if (instanceHighConst) { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, constOffset); constInstanceHigh = b.readUInt32LE(0); constOffset += 4; }

      const varBytes  = (typeConst ? 0 : 4) + (groupConst ? 0 : 4) + (instanceHighConst ? 0 : 4);
      const entrySize = varBytes + 20;

      // Monta um Set de instâncias do mod para lookup O(1)
      const instanceSet = new Set(instanceIds.map(id => `${id.high}:${id.low}`));

      for (let i = 0; i < indexCount; i++) {
        const entryStart = constOffset + i * entrySize;
        const entryBuf = Buffer.alloc(entrySize);
        fs.readSync(fd, entryBuf, 0, entrySize, entryStart);

        let pos = 0;
        const type = typeConst ? constType : entryBuf.readUInt32LE(pos);
        if (!typeConst) pos += 4;
        if (!groupConst) pos += 4;
        const instanceHigh = instanceHighConst ? constInstanceHigh : entryBuf.readUInt32LE(pos);
        if (!instanceHighConst) pos += 4;
        const instanceLow = entryBuf.readUInt32LE(pos); pos += 4;

        // Verifica se é um tipo de thumbnail E pertence a um dos recursos do mod
        if (!THUMBNAIL_TYPES.has(type >>> 0)) continue;
        if (!instanceSet.has(`${instanceHigh}:${instanceLow}`)) continue;

        const dataOffset     = entryBuf.readUInt32LE(pos); pos += 4;
        const rawCompSize    = entryBuf.readUInt32LE(pos); pos += 4;
        const compressedSize = rawCompSize & 0x7FFFFFFF;
        pos += 4; // decompressedSize
        const compressionType = entryBuf.readUInt16LE(pos);

        if (compressedSize === 0 || compressedSize > 4 * 1024 * 1024) continue;

        const dataBuf = Buffer.alloc(compressedSize);
        fs.readSync(fd, dataBuf, 0, compressedSize, dataOffset);

        let imageData = dataBuf;
        if (compressionType === 0x5A42) {
          try { imageData = zlib.unzipSync(dataBuf); } catch (_) {
            try { imageData = zlib.inflateSync(dataBuf); } catch (__) { continue; }
          }
        } else if (compressionType === 0xFFFF) {
          try { imageData = internalDecompression(dataBuf); } catch (_) { continue; }
        } else if (compressionType !== 0x0000) {
          continue;
        }

        const pngMagic  = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        const jpegMagic = [0xFF, 0xD8, 0xFF];
        const limit = Math.min(imageData.length - 8, 256);

        for (let s = 0; s <= limit; s++) {
          if (imageData[s] === pngMagic[0] && imageData[s+1] === pngMagic[1] &&
              imageData[s+2] === pngMagic[2] && imageData[s+3] === pngMagic[3] &&
              imageData[s+4] === pngMagic[4] && imageData[s+5] === pngMagic[5] &&
              imageData[s+6] === pngMagic[6] && imageData[s+7] === pngMagic[7]) {
            fs.closeSync(fd);
            return resolve(`data:image/png;base64,` + imageData.slice(s).toString('base64'));
          }
          if (s + 3 <= imageData.length &&
              imageData[s] === jpegMagic[0] && imageData[s+1] === jpegMagic[1] && imageData[s+2] === jpegMagic[2]) {
            fs.closeSync(fd);
            return resolve(`data:image/jpeg;base64,` + imageData.slice(s).toString('base64'));
          }
        }
      }

      fs.closeSync(fd);
      resolve(null);
    } catch (e) {
      try { if (fd !== undefined) fs.closeSync(fd); } catch (_) {}
      resolve(null);
    }
  });
}

// ─── BPI Thumbnail Extractor (Tray / House files) ────────────────────────────
// ─── BPI Thumbnail Extractor + Styled Fallback (Tray / House files) ──────────
// FIX BUG 3: Tray items (houses/lots) store their thumbnails as separate .bpi files.
//
// DEEP INVESTIGATION FINDINGS (March 2026):
// After exhaustive reverse-engineering of the BPI format (testing JPEG, PNG, WebP,
// DXT1, DXT5, DST1, DST5, RefPack, RLE2, ZLIB, LZ4, LZMA, brotli, zstd formats),
// the BPI payload uses EA's proprietary codec. Key findings:
//   - Payload entropy ≈ 8 bits/byte (near-maximum = highly compressed)
//   - No standard image magic bytes found (FF D8, 89 PNG, RIFF WEBP, DDS, etc.)
//   - Not block-compressed: payload size is not a multiple of 8 (DXT1) or 16 (DXT5)
//   - Contains JPEG-like markers (FF D7 restart marker, isolated FF 00 byte-stuff)
//     but the full JPEG header is absent — likely stripped and hardcoded in the engine
//   - All BPI files (from all houses) share the same 24-byte header magic constant
//     (0x8EFC24489B780E3C) = format version identifier, not lot-specific ID
//   - Files of the same view type (0x00000002) from DIFFERENT houses share up to
//     1284 bytes of identical payload = both show the same Willow Creek background
//     (consistent with a streaming compression that starts with shared context)
//
// CONCLUSION: BPI requires EA's proprietary codec. Without the game engine binary,
// we cannot decode it. The code below searches for any standard-format image that
// might be embedded (future-proofing), then falls back to a styled SVG thumbnail
// generated from the lot name extracted from the sibling .trayitem file.

/**
 * Parses printable ASCII strings from a trayitem binary (protobuf-like format).
 * Returns { name, creator } extracted from the "HouseName*Desc0Creator@" pattern.
 */
function parseTrayItemInfo(trayItemPath) {
  try {
    const data = fs.readFileSync(trayItemPath);
    // Extract all printable ASCII runs of length ≥ 3
    const runs = [];
    let run = '';
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      if (b >= 0x20 && b <= 0x7E) {
        run += String.fromCharCode(b);
      } else {
        if (run.length >= 3) runs.push(run);
        run = '';
      }
    }
    if (run.length >= 3) runs.push(run);

    let name = null;
    let creator = null;

    // First long string with '*' separator contains "LotName*Description"
    for (const s of runs) {
      if (s.includes('*') && s.length > 3) {
        name = s.split('*')[0].trim();
        break;
      }
    }

    // First string ending with '@' is the creator username
    for (const s of runs) {
      if (s.endsWith('@') && s.length > 2) {
        creator = s.slice(0, -1).trim();
        break;
      }
    }

    return { name, creator };
  } catch (_) {
    return { name: null, creator: null };
  }
}

/**
 * Generates a styled SVG thumbnail for a tray (house/lot) item.
 * Used as a fallback when the BPI pixel codec cannot decode the image.
 * Returns a data URL string ready for use as an <img> src.
 */
function generateTrayThumbnailSvg(name, creator) {
  const W = 140, H = 140;

  // Escape text for safe SVG embedding
  const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Truncate name for display
  const displayName = name ? (name.length > 16 ? name.slice(0, 15) + '…' : name) : 'Casa';
  const displayCreator = creator ? (creator.length > 14 ? creator.slice(0, 13) + '…' : creator) : '';

  // House icon path (simple house silhouette)
  const hx = W / 2, hy = H / 2 - 12;
  const houseSvg = `
    <!-- Roof -->
    <polygon points="${hx},${hy-24} ${hx-20},${hy-6} ${hx+20},${hy-6}"
             fill="#FFD84D" stroke="#F0C000" stroke-width="1"/>
    <!-- Wall -->
    <rect x="${hx-16}" y="${hy-6}" width="32" height="24"
          fill="#E8B87A" stroke="#D4A060" stroke-width="1"/>
    <!-- Door -->
    <rect x="${hx-5}" y="${hy+6}" width="10" height="18"
          fill="#5C3A1E" rx="1"/>
    <!-- Window left -->
    <rect x="${hx-14}" y="${hy}" width="8" height="8"
          fill="#A8D8FF" stroke="#D4A060" stroke-width="0.5"/>
    <!-- Window right -->
    <rect x="${hx+6}" y="${hy}" width="8" height="8"
          fill="#A8D8FF" stroke="#D4A060" stroke-width="0.5"/>
  `;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1A0A40"/>
      <stop offset="100%" stop-color="#2A1870"/>
    </linearGradient>
  </defs>
  <!-- Background -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <!-- Subtle stars -->
  <circle cx="15" cy="12" r="1" fill="white" opacity="0.4"/>
  <circle cx="42" cy="8"  r="1" fill="white" opacity="0.3"/>
  <circle cx="88" cy="15" r="1" fill="white" opacity="0.5"/>
  <circle cx="120" cy="6" r="1" fill="white" opacity="0.4"/>
  <circle cx="130" cy="25" r="1" fill="white" opacity="0.3"/>
  <!-- House icon -->
  ${houseSvg}
  <!-- Lot name -->
  <text x="${W/2}" y="${hy+36}" font-family="Arial,sans-serif" font-size="11"
        font-weight="bold" fill="white" text-anchor="middle"
        style="paint-order:stroke" stroke="#000" stroke-width="2">${esc(displayName)}</text>
  ${displayCreator ? `<text x="${W/2}" y="${H-8}" font-family="Arial,sans-serif" font-size="9"
        fill="#AAA8CC" text-anchor="middle">by ${esc(displayCreator)}</text>` : ''}
</svg>`;

  const b64 = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${b64}`;
}

async function extractThumbnailFromBpi(trayFilePath) {
  // Given any tray file (e.g. *.trayitem, *.blueprint), find the sibling .bpi
  // file with the primary (type=2, front view) thumbnail.
  const dir = path.dirname(trayFilePath);
  const base = path.basename(trayFilePath);

  // Extract the instance ID from the filename: 0x<type>!<instanceId>.<ext>
  const instanceMatch = base.match(/^0x[0-9a-fA-F]+!([0-9a-fA-F]+)\./);
  if (!instanceMatch) return _generateTrayFallback(dir, base);

  const instanceId = instanceMatch[1];
  const bpiName = `0x00000002!${instanceId}.bpi`;
  const bpiPath = path.join(dir, bpiName);

  if (fs.existsSync(bpiPath)) {
    try {
      const data = fs.readFileSync(bpiPath);
      if (data.length >= 24) {
        const payloadSize = data.readUInt32LE(0);
        if (payloadSize > 0 && 24 + payloadSize <= data.length) {
          const payload = data.slice(24, 24 + payloadSize);

          // Search for any standard image format embedded in the BPI payload
          const pngMagic  = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
          const jpegMagic = [0xFF, 0xD8, 0xFF];
          const searchLimit = Math.min(payload.length - 8, 512);

          for (let s = 0; s <= searchLimit; s++) {
            if (payload[s]   === pngMagic[0] && payload[s+1] === pngMagic[1] &&
                payload[s+2] === pngMagic[2] && payload[s+3] === pngMagic[3] &&
                payload[s+4] === pngMagic[4] && payload[s+5] === pngMagic[5] &&
                payload[s+6] === pngMagic[6] && payload[s+7] === pngMagic[7]) {
              return `data:image/png;base64,` + payload.slice(s).toString('base64');
            }
            if (s + 3 <= payload.length &&
                payload[s] === jpegMagic[0] && payload[s+1] === jpegMagic[1] &&
                payload[s+2] === jpegMagic[2]) {
              return `data:image/jpeg;base64,` + payload.slice(s).toString('base64');
            }
          }

          // Try zlib decompression and search again
          for (const decompress of [zlib.unzipSync, zlib.inflateSync]) {
            try {
              const dec = decompress(payload);
              const sl2 = Math.min(dec.length - 8, 512);
              for (let s = 0; s <= sl2; s++) {
                if (dec[s] === pngMagic[0] && dec[s+1] === pngMagic[1] &&
                    dec[s+2] === pngMagic[2] && dec[s+3] === pngMagic[3] &&
                    dec[s+4] === pngMagic[4] && dec[s+5] === pngMagic[5] &&
                    dec[s+6] === pngMagic[6] && dec[s+7] === pngMagic[7]) {
                  return `data:image/png;base64,` + dec.slice(s).toString('base64');
                }
                if (s + 3 <= dec.length &&
                    dec[s] === jpegMagic[0] && dec[s+1] === jpegMagic[1] &&
                    dec[s+2] === jpegMagic[2]) {
                  return `data:image/jpeg;base64,` + dec.slice(s).toString('base64');
                }
              }
            } catch (_) { /* try next */ }
          }
        }
      }
    } catch (_) { /* fall through to styled SVG */ }
  }

  // BPI codec not decodable — generate a styled SVG thumbnail using lot metadata
  return _generateTrayFallback(dir, instanceId);
}

/**
 * Finds the sibling .trayitem file and generates a styled SVG thumbnail
 * showing the lot name and creator name.
 */
function _generateTrayFallback(dir, instanceId) {
  try {
    // Find the .trayitem file for this lot (has same instance ID)
    const allFiles = fs.readdirSync(dir);
    const trayItemFile = allFiles.find(f =>
      f.endsWith('.trayitem') && f.includes(instanceId)
    );

    let name = null, creator = null;
    if (trayItemFile) {
      const info = parseTrayItemInfo(path.join(dir, trayItemFile));
      name = info.name;
      creator = info.creator;
    }

    // Fallback name from directory if trayitem not found or unparsable
    if (!name) {
      name = path.basename(dir);
    }

    return generateTrayThumbnailSvg(name, creator);
  } catch (_) {
    return generateTrayThumbnailSvg(null, null);
  }
}

// Thumbnails
ipcMain.handle('thumbnail:get', async (_, filePath) => {
  if (!isPathSafe(filePath, ...getAllowedRoots())) return null;

  const ext = path.extname(filePath).toLowerCase();
  const trayExts = new Set(['.trayitem', '.blueprint', '.bpi']);

  if (trayExts.has(ext)) {
    // FIX BUG 3: For tray files, look for the sibling .bpi thumbnail file
    return await extractThumbnailFromBpi(filePath);
  }

  // 1. Tenta extrair miniatura embutida no próprio .package
  const embedded = await extractThumbnailFromPackage(filePath);
  if (embedded) return embedded;
  // 2. Fallback: busca no localthumbcache.package do jogo
  return await extractThumbnailFromLocalCache(filePath);
});
ipcMain.handle('thumbnail:purge-cache', (_, existingPaths) => { purgeThumbnailCache(existingPaths); return true; });
ipcMain.handle('thumbnail:clear-cache', () => {
  try {
    // QA-02: sempre inicializar com __version para não corromper leituras futuras
    _thumbnailCache = { __version: THUMBNAIL_CACHE_VERSION };
    if (fs.existsSync(THUMBNAIL_CACHE_PATH)) fs.unlinkSync(THUMBNAIL_CACHE_PATH);
    return true;
  } catch (_) { return false; }
});

// App icon (returns PNG base64 for use in renderer titlebar)
ipcMain.handle('icon:get', () => {
  try {
    const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
    const img = nativeImage.createFromPath(iconPath);
    const png = img.toPNG();
    if (!png || png.length === 0) return null;
    return png.toString('base64');
  } catch (_) { return null; }
});

// Moves files to internal trash for undo-able deletion from the Mods list
ipcMain.handle('mods:trash-batch', async (_, filePaths) => {
  const roots = getAllowedRoots();
  const trashDir = path.join(app.getPath('userData'), 'trash');
  ensureDir(trashDir);
  const results = [];
  for (const fp of filePaths) {
    if (!isPathSafe(fp, ...roots)) {
      results.push({ success: false, path: fp, trashPath: null, error: 'Caminho não permitido' });
      continue;
    }
    const slug = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${path.basename(fp)}`;
    const dest = path.join(trashDir, slug);
    const result = moveFile(fp, dest);
    if (result.success) {
      // Write sidecar metadata so the Trash page can show origin path
      try {
        fs.writeFileSync(dest + '.meta.json', JSON.stringify({
          originalPath: fp,
          trashedAt: new Date().toISOString(),
          source: 'mods',
        }));
      } catch (_) {}
    }
    results.push({ ...result, originalPath: fp, trashPath: dest });
  }
  return results;
});

// Restores a file previously moved by mods:trash-batch
ipcMain.handle('mods:restore-from-trash', (_, trashPath, originalPath) => {
  const trashDir = path.join(app.getPath('userData'), 'trash');
  const roots = getAllowedRoots();
  if (!isPathSafe(trashPath, trashDir)) return { success: false, error: 'Origem não é da lixeira interna' };
  if (!isPathSafe(originalPath, ...roots)) return { success: false, error: 'Destino não permitido' };
  const result = moveFile(trashPath, originalPath);
  if (result.success) {
    // Clean up sidecar metadata if exists
    try { fs.unlinkSync(trashPath + '.meta.json'); } catch (_) {}
  }
  return result;
});

// ─── Internal Trash Management ───────────────────────────────────────────────

// Lists all items in the internal trash with metadata
ipcMain.handle('trash:list', () => {
  const trashDir = path.join(app.getPath('userData'), 'trash');
  ensureDir(trashDir);
  try {
    const entries = fs.readdirSync(trashDir);
    const items = [];
    for (const name of entries) {
      if (name.endsWith('.meta.json')) continue; // skip sidecars
      const trashPath = path.join(trashDir, name);
      let stat;
      try { stat = fs.statSync(trashPath); } catch (_) { continue; }
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(trashPath + '.meta.json', 'utf8')); } catch (_) {}
      items.push({
        trashPath,
        name: meta.originalPath ? path.basename(meta.originalPath) : name.replace(/^\d+_[a-z0-9]+_/, ''),
        originalPath: meta.originalPath || null,
        trashedAt: meta.trashedAt || null,
        source: meta.source || 'unknown',
        size: stat.size,
      });
    }
    // Sort newest first
    items.sort((a, b) => (b.trashedAt || '').localeCompare(a.trashedAt || ''));
    return items;
  } catch (e) {
    return [];
  }
});

// Restores one item from internal trash back to its original location
ipcMain.handle('trash:restore', (_, trashPath, originalPath) => {
  const trashDir = path.join(app.getPath('userData'), 'trash');
  const roots = getAllowedRoots();
  if (!isPathSafe(trashPath, trashDir)) return { success: false, error: 'Não está na lixeira interna' };
  if (!originalPath || !isPathSafe(originalPath, ...roots)) return { success: false, error: 'Destino não permitido' };
  const result = moveFile(trashPath, originalPath);
  if (result.success) {
    try { fs.unlinkSync(trashPath + '.meta.json'); } catch (_) {}
  }
  return result;
});

// Permanently deletes one item from internal trash (sends to OS trash)
ipcMain.handle('trash:delete-permanent', async (_, trashPath) => {
  const trashDir = path.join(app.getPath('userData'), 'trash');
  if (!isPathSafe(trashPath, trashDir)) return { success: false, error: 'Não está na lixeira interna' };
  try {
    await shell.trashItem(trashPath);
    try { fs.unlinkSync(trashPath + '.meta.json'); } catch (_) {}
    return { success: true };
  } catch (e) {
    // Fallback: permanent delete if trashItem fails
    try {
      fs.unlinkSync(trashPath);
      try { fs.unlinkSync(trashPath + '.meta.json'); } catch (_) {}
      return { success: true };
    } catch (e2) {
      return { success: false, error: e2.message };
    }
  }
});

// Empties the entire internal trash (sends all files to OS trash)
ipcMain.handle('trash:empty', async () => {
  const trashDir = path.join(app.getPath('userData'), 'trash');
  ensureDir(trashDir);
  let ok = 0, failed = 0;
  try {
    const entries = fs.readdirSync(trashDir).filter(n => !n.endsWith('.meta.json'));
    for (const name of entries) {
      const p = path.join(trashDir, name);
      try {
        await shell.trashItem(p);
        try { fs.unlinkSync(p + '.meta.json'); } catch (_) {}
        ok++;
      } catch (_) {
        try {
          fs.unlinkSync(p);
          try { fs.unlinkSync(p + '.meta.json'); } catch (_) {}
          ok++;
        } catch (_2) { failed++; }
      }
    }
  } catch (_) {}
  return { ok, failed };
});

// Filesystem checks
ipcMain.handle('fs:exists', (_, folderPath) => {
  if (!folderPath || typeof folderPath !== 'string') return false;
  try { return fs.existsSync(folderPath); }
  catch (_) { return false; }
});

// Window controls
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);

// ─── Test Exports ─────────────────────────────────────────────────────────────
// Exported only when NODE_ENV=test — not bundled in production build.
if (process.env.NODE_ENV === 'test') {
  module.exports = {
    // Constants
    MOD_EXTENSIONS, TRAY_EXTENSIONS, ARCHIVE_EXTENSIONS, DISABLED_SUFFIX,
    // Path/name utilities
    getFileDepth, getDisabledPath, isEnabled, getRealExtension, getRealName,
    isPathSafe,
    // Config
    readConfig, writeConfig, DEFAULT_CONFIG,
    // Compression
    readUInt24BE, internalDecompression,
    // Thumbnail
    generateTrayThumbnailSvg, purgeThumbnailCache, loadThumbnailCache,
    extractThumbnailFromPackage,
    // File scanning
    walkFolder, buildModObject, scanModsFolder, scanTrayFolder,
    // Mod operations
    toggleMod, moveFile, copyModFile, collectModFiles,
    // Conflict & organizer
    scanConflicts, scanMisplaced, fixMisplaced,
  };
}
