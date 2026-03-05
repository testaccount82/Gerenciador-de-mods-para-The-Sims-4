'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile } = require('child_process');

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
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
      for (let i = 0; i < size; i++) udata[uIdx++] = data[dIdx++];
      for (let i = 0; i < copySize; i++) udata[uIdx] = udata[uIdx++ - copyOffset - 1];
    } else if (cc <= 0xBF) {
      const size       = (data[dIdx] & 0xC0) >> 6;
      const copySize   = (cc & 0x3F) + 4;
      const copyOffset = ((data[dIdx] & 0x3F) << 8) + data[dIdx + 1];
      dIdx += 2;
      for (let i = 0; i < size; i++) udata[uIdx++] = data[dIdx++];
      for (let i = 0; i < copySize; i++) udata[uIdx] = udata[uIdx++ - copyOffset - 1];
    } else if (cc <= 0xDF) {
      const size       = cc & 0x3;
      const copySize   = ((cc & 0xC) << 6) + data[dIdx + 2] + 5;
      const copyOffset = ((cc & 0x10) << 12) + (data[dIdx] << 8) + data[dIdx + 1];
      dIdx += 3;
      for (let i = 0; i < size; i++) udata[uIdx++] = data[dIdx++];
      for (let i = 0; i < copySize; i++) udata[uIdx] = udata[uIdx++ - copyOffset - 1];
    } else if (cc <= 0xFB) {
      const size = ((cc & 0x1F) << 2) + 4;
      for (let i = 0; i < size; i++) udata[uIdx++] = data[dIdx++];
    } else {
      const size = cc & 0x3;
      for (let i = 0; i < size; i++) udata[uIdx++] = data[dIdx++];
    }
  } while (cc < 0xFC);

  return udata;
}

// ─── DBPF Thumbnail Extractor ────────────────────────────────────────────────

// Type IDs that may contain a viewable PNG image
const THUMBNAIL_TYPES = new Set([
  0x2F7D0004, // PNG Image (generic)
  0x3C2A8647, // Buy/Build thumbnail
  0x3C1AF1F2, // CAS Part Thumbnail
  0x5B282D45, // Body Part Thumbnail
  0xCD9DE247, // Sim Featured Outfit Thumbnail
  0x9C925813, // Sim Preset Thumbnail
]);

const THUMBNAIL_CACHE_PATH = path.join(app.getPath('userData'), 'thumbnail-cache.json');
let _thumbnailCache = null;

function loadThumbnailCache() {
  if (_thumbnailCache) return _thumbnailCache;
  try {
    if (fs.existsSync(THUMBNAIL_CACHE_PATH)) {
      _thumbnailCache = JSON.parse(fs.readFileSync(THUMBNAIL_CACHE_PATH, 'utf-8'));
    } else {
      _thumbnailCache = {};
    }
  } catch (_) { _thumbnailCache = {}; }
  return _thumbnailCache;
}

function saveThumbnailCache() {
  try { fs.writeFileSync(THUMBNAIL_CACHE_PATH, JSON.stringify(_thumbnailCache), 'utf-8'); }
  catch (_) {}
}

function purgeThumbnailCache(existingPaths) {
  const cache = loadThumbnailCache();
  const pathSet = new Set(existingPaths);
  let dirty = false;
  for (const key of Object.keys(cache)) {
    if (!pathSet.has(key)) { delete cache[key]; dirty = true; }
  }
  if (dirty) saveThumbnailCache();
}

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
    cache[filePath] = { mtime: stat.mtimeMs, data: result };
    // Debounced save
    clearTimeout(_thumbnailCache._saveTimer);
    _thumbnailCache._saveTimer = setTimeout(saveThumbnailCache, 2000);
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
      const indexOffset = header.readUInt32LE(64);

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
      if (mod) results.push(mod);
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
  const ext = path.extname(src).toLowerCase();
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
  while (fs.existsSync(finalDest)) {
    const base = path.basename(dest, ext);
    finalDest = path.join(path.dirname(dest), `${base} (${counter})${ext}`);
    counter++;
  }
  fs.copyFileSync(src, finalDest);
  return finalDest;
}

function collectModFiles(dir, found = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectModFiles(fullPath, found);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
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
    const ext = path.extname(src).toLowerCase();

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

    execFile(sevenZipPath, ['x', archivePath, `-o${destDir}`, '-y', '-aoa'], (err) => {
      if (err) reject(new Error(`Falha na extração: ${err.message}`));
      else resolve();
    });
  });
}

// ─── Conflict Detection ──────────────────────────────────────────────────────

async function scanConflicts(modsFolder) {
  const conflicts = [];
  const allFiles = walkFolder(modsFolder, modsFolder);
  const modFiles = allFiles.filter(({ fullPath }) =>
    MOD_EXTENSIONS.includes(getRealExtension(fullPath))
  );

  // 1. Same name conflicts
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
        id: crypto.createHash('md5').update(name).digest('hex'),
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

  // 2. Hash duplicates (same content, different name)
  const hashMap = {};
  for (const { fullPath } of modFiles) {
    try {
      const hash = await getFileHash(fullPath);
      if (!hashMap[hash]) hashMap[hash] = [];
      hashMap[hash].push(fullPath);
    } catch (_) {}
  }
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

  // .ts4script files deeper than 1 subfolder
  const modsFiles = walkFolder(modsFolder, modsFolder);
  for (const { fullPath, depth } of modsFiles) {
    const ext = getRealExtension(fullPath);
    if (ext === '.ts4script' && depth > 1) {
      const suggestedDest = path.join(modsFolder, getRealName(fullPath));
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
      const suggestedDest = path.join(trayFolder, getRealName(fullPath));
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
        const suggestedDest = path.join(modsFolder, getRealName(fullPath));
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

function fixMisplaced(items) {
  const results = [];
  for (const item of items) {
    const result = moveFile(item.path, item.suggestedDest);
    results.push({ ...result, item });
  }
  return results;
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

// Config
ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('config:set', (_, config) => { writeConfig(config); return true; });

// Mods scanning
ipcMain.handle('mods:scan', (_, modsFolder) => scanModsFolder(modsFolder));
ipcMain.handle('tray:scan', (_, trayFolder) => scanTrayFolder(trayFolder));

// Mod operations
ipcMain.handle('mods:toggle', (_, filePath) => toggleMod(filePath));
ipcMain.handle('mods:toggle-folder', (_, folderPath, modsFolder) => toggleFolder(folderPath, modsFolder));
ipcMain.handle('mods:delete', async (_, filePaths) => {
  const results = [];
  for (const fp of filePaths) results.push(await deleteMod(fp));
  return results;
});
ipcMain.handle('mods:move', (_, from, to) => moveFile(from, to));
ipcMain.handle('mods:import', async (_, filePaths, modsFolder, trayFolder) =>
  importFiles(filePaths, modsFolder, trayFolder)
);

// Conflicts
ipcMain.handle('conflicts:scan', async (_, modsFolder) => scanConflicts(modsFolder));
ipcMain.handle('conflicts:resolve-delete', async (_, filePath) => deleteMod(filePath));
ipcMain.handle('conflicts:move-to-trash', (_, filePath) => {
  const trashDir = path.join(app.getPath('userData'), 'trash');
  ensureDir(trashDir);
  const dest = path.join(trashDir, `${Date.now()}_${path.basename(filePath)}`);
  return moveFile(filePath, dest);
});
ipcMain.handle('conflicts:restore-from-trash', (_, trashPath, originalPath) => {
  return moveFile(trashPath, originalPath);
});

// Organizer
ipcMain.handle('organize:scan', (_, modsFolder, trayFolder) => scanMisplaced(modsFolder, trayFolder));
ipcMain.handle('organize:fix', (_, items) => fixMisplaced(items));
ipcMain.handle('organize:fix-one', (_, item) => moveFile(item.path, item.suggestedDest));

// Dialogs
ipcMain.handle('dialog:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('dialog:open-files', async (_, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: filters || [
      { name: 'Mods e Arquivos', extensions: ['package', 'ts4script', 'trayitem', 'blueprint', 'zip', 'rar', '7z'] },
      { name: 'Todos os Arquivos', extensions: ['*'] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
});

// Shell
ipcMain.handle('shell:open', (_, folderPath) => shell.openPath(folderPath));

// Thumbnails
ipcMain.handle('thumbnail:get', async (_, filePath) => extractThumbnailFromPackage(filePath));
ipcMain.handle('thumbnail:purge-cache', (_, existingPaths) => { purgeThumbnailCache(existingPaths); return true; });
ipcMain.handle('thumbnail:clear-cache', () => {
  try {
    _thumbnailCache = {};
    if (fs.existsSync(THUMBNAIL_CACHE_PATH)) fs.unlinkSync(THUMBNAIL_CACHE_PATH);
    return true;
  } catch (_) { return false; }
});

// Filesystem checks
ipcMain.handle('fs:exists', (_, folderPath) => {
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
