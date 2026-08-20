/**
 * Voice Dub Hero - Local Game Server (ES Module)
 * Serves static assets, proxies GameBanana API, converts .ogv video to universal MP4 on-the-fly,
 * and streams scene packages with real-time download progress.
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { ZipEngine } from './src/zip-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const GAMEBANANA_GAME_ID = 20674; // The Choicer Voicer

const FFMPEG_PATH = path.join(__dirname, 'venv/lib/python3.9/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8'
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'VoiceDubHero/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', reject);
  });
}

function downloadUrlWithRedirects(url, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Demasiadas redirecciones al descargar de GameBanana'));
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, url).toString();
        }
        return resolve(downloadUrlWithRedirects(redirectUrl, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`GameBanana respondió con código HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

function pipeUrlStream(url, clientRes, maxRedirects = 10, onHeaders = null) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Demasiadas redirecciones al conectar con GameBanana'));
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, url).toString();
        }
        return resolve(pipeUrlStream(redirectUrl, clientRes, maxRedirects - 1, onHeaders));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`GameBanana respondió con código HTTP ${res.statusCode}`));
      }
      if (onHeaders) {
        onHeaders(res);
      }
      res.pipe(clientRes);
      res.on('end', () => resolve(true));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function convertOgvToMp4(inputBuffer) {
  return new Promise((resolve) => {
    if (!fs.existsSync(FFMPEG_PATH)) {
      console.warn('FFMPEG binary not found at:', FFMPEG_PATH);
      return resolve(null);
    }

    const tempId = Date.now() + '_' + Math.random().toString(36).substring(7);
    const tempIn = path.join(__dirname, `temp_${tempId}.ogv`);
    const tempOut = path.join(__dirname, `temp_${tempId}.mp4`);

    fs.writeFileSync(tempIn, inputBuffer);

    const proc = spawn(FFMPEG_PATH, [
      '-y',
      '-i', tempIn,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', 'faststart',
      '-c:a', 'aac',
      tempOut
    ]);

    proc.on('close', (code) => {
      try { if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn); } catch {}
      if (code === 0 && fs.existsSync(tempOut)) {
        const outBuf = fs.readFileSync(tempOut);
        try { fs.unlinkSync(tempOut); } catch {}
        resolve(new Uint8Array(outBuf));
      } else {
        try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch {}
        resolve(null);
      }
    });

    proc.on('error', (err) => {
      console.warn('FFMPEG spawn error:', err);
      try { if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn); } catch {}
      try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch {}
      resolve(null);
    });
  });
}

function unpackArchiveWithBsdtar(inputBuffer, ext = '.rar') {
  return new Promise((resolve) => {
    const tempId = Date.now() + '_' + Math.random().toString(36).substring(7);
    const tempArchive = path.join(__dirname, `temp_archive_${tempId}${ext}`);
    const tempDir = path.join(__dirname, `temp_dir_${tempId}`);

    try {
      fs.writeFileSync(tempArchive, inputBuffer);
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

      const proc = spawn('/usr/bin/bsdtar', ['-xf', tempArchive, '-C', tempDir]);

      proc.on('close', (code) => {
        try { if (fs.existsSync(tempArchive)) fs.unlinkSync(tempArchive); } catch {}
        if (code === 0 && fs.existsSync(tempDir)) {
          const filesMap = {};

          function readDirRecursive(currentDir, relativePrefix = '') {
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(currentDir, entry.name);
              const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
              if (entry.isDirectory()) {
                readDirRecursive(fullPath, relPath);
              } else if (entry.isFile()) {
                filesMap[relPath] = new Uint8Array(fs.readFileSync(fullPath));
              }
            }
          }

          readDirRecursive(tempDir);
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          resolve(filesMap);
        } else {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          resolve(null);
        }
      });

      proc.on('error', (err) => {
        console.warn('bsdtar spawn error:', err);
        try { if (fs.existsSync(tempArchive)) fs.unlinkSync(tempArchive); } catch {}
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        resolve(null);
      });
    } catch (e) {
      console.warn('unpackArchive error:', e);
      try { if (fs.existsSync(tempArchive)) fs.unlinkSync(tempArchive); } catch {}
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      resolve(null);
    }
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, X-Scene-Title');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // =========================================================================
  // API: GameBanana Feed & Search Proxy
  // =========================================================================
  if (pathname === '/api/gamebanana/feed') {
    const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
    const search = parsedUrl.searchParams.get('search') || '';

    try {
      let apiUrl = '';
      if (search && search.trim().length > 0) {
        apiUrl = `https://gamebanana.com/apiv11/Util/Search/Results?_sSearchString=${encodeURIComponent(search.trim())}&_idGameRow=${GAMEBANANA_GAME_ID}&_nPage=${page}&_nPerpage=24`;
      } else {
        apiUrl = `https://gamebanana.com/apiv11/Game/${GAMEBANANA_GAME_ID}/Subfeed?_nPage=${page}&_nPerpage=24`;
      }

      const rawData = await fetchJson(apiUrl);
      const records = rawData?._aRecords || [];

      const scenes = records.map(item => {
        let thumb = '';
        const previewImages = item._aPreviewMedia?._aImages || [];
        if (previewImages.length > 0) {
          const firstImg = previewImages[0];
          thumb = `${firstImg._sBaseUrl}/${firstImg._sFile530 || firstImg._sFile220 || firstImg._sFile}`;
        }

        return {
          id: item._idRow,
          title: item._sName || 'Escena Sin Título',
          author: item._aSubmitter?._sName || 'Comunidad',
          authorAvatar: item._aSubmitter?._sAvatarUrl || '',
          thumbnailUrl: thumb,
          dateAdded: item._tsDateAdded,
          likes: item._nLikeCount || 0,
          views: item._nViewCount || 0,
          category: item._aRootCategory?._sName || 'Dub Mode',
          profileUrl: item._sProfileUrl || `https://gamebanana.com/mods/${item._idRow}`
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        page,
        total: rawData?._aMetadata?._nRecordCount || scenes.length,
        isComplete: rawData?._aMetadata?._bIsComplete || false,
        scenes
      }));
    } catch (err) {
      console.error('Error fetching GameBanana feed:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message, scenes: [] }));
    }
    return;
  }

  // =========================================================================
  // API: GameBanana Mod Direct Downloader with Progress, RAR and Transcoding
  // =========================================================================
  if (pathname === '/api/gamebanana/download') {
    const modId = parsedUrl.searchParams.get('modId');
    if (!modId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Falta el parámetro modId' }));
      return;
    }

    try {
      console.log(`[GameBanana] Obteniendo metadatos para Mod ID: ${modId}...`);
      const modData = await fetchJson(`https://api.gamebanana.com/Core/Item/Data?itemtype=Mod&itemid=${modId}&fields=name,Files().aFiles()`);
      
      if (!modData || !modData[1]) {
        throw new Error('No se encontraron archivos en este Mod de GameBanana.');
      }

      const modName = modData[0] || `GameBanana_Mod_${modId}`;
      const filesObj = modData[1];
      const fileKeys = Object.keys(filesObj);
      if (fileKeys.length === 0) {
        throw new Error('El mod no tiene archivos disponibles para descarga.');
      }

      // Pick the main archive file (.zip, .rar, .7z)
      const primaryKey = fileKeys.find(k => {
        const fn = (filesObj[k]._sFile || '').toLowerCase();
        return fn.endsWith('.zip') || fn.endsWith('.rar') || fn.endsWith('.7z') || fn.endsWith('.tar');
      }) || fileKeys[0];

      const fileInfo = filesObj[primaryKey];
      const downloadUrl = fileInfo._sDownloadUrl;
      const fileName = fileInfo._sFile || `${modName}.zip`;

      console.log(`[GameBanana] Streaming ${fileName} desde ${downloadUrl}...`);
      await pipeUrlStream(downloadUrl, res, 10, (gbRes) => {
        const totalSize = gbRes.headers['content-length'] || fileInfo._nFilesize || '';
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': totalSize,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
          'X-File-Name': encodeURIComponent(fileName),
          'X-Scene-Title': encodeURIComponent(modName)
        });
      });
      console.log(`[GameBanana] ✓ Stream completado para "${modName}" (${modId})!`);
    } catch (err) {
      console.error('[GameBanana] Error downloading mod:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Error al descargar la escena: ${err.message}` }));
      }
    }
    return;
  }

  // =========================================================================
  // API: Universal Archive Unpacker & Transcoder (.rar, .zip, .7z)
  // =========================================================================
  if (pathname === '/api/unpack-archive' && req.method === 'POST') {
    try {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const inputBuf = Buffer.concat(chunks);
        let unzipped = null;

        // Try unrar first or bsdtar
        unzipped = await unpackArchiveWithBsdtar(inputBuf, '.rar');
        if (!unzipped) {
          try { unzipped = await ZipEngine.unzip(inputBuf); } catch {}
        }

        if (!unzipped || Object.keys(unzipped).length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No se pudo descomprimir el archivo RAR/ZIP.' }));
          return;
        }

        // Auto-transcode .ogv to .mp4
        const ogvKey = Object.keys(unzipped).find(k => k.endsWith('.ogv'));
        if (ogvKey && !Object.keys(unzipped).some(k => k.endsWith('.mp4'))) {
          const mp4Buf = await convertOgvToMp4(unzipped[ogvKey]);
          if (mp4Buf) {
            const mp4Key = ogvKey.replace(/\.ogv$/i, '.mp4');
            unzipped[mp4Key] = mp4Buf;
            delete unzipped[ogvKey];
          }
        }

        // Pack back as universal zip
        const finalZip = await ZipEngine.createZip(unzipped);
        const ab = await finalZip.arrayBuffer();
        const sendBuf = Buffer.from(ab);

        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': sendBuf.length
        });
        res.end(sendBuf);
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // =========================================================================
  // API: Video Transcoding endpoint
  // =========================================================================
  if (pathname === '/api/transcode-video' && req.method === 'POST') {
    try {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const inputBuf = Buffer.concat(chunks);
        const mp4Buf = await convertOgvToMp4(inputBuf);
        if (mp4Buf) {
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': mp4Buf.length
          });
          res.end(mp4Buf);
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Transcode failed' }));
        }
      });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // =========================================================================
  // Static Files & Range Requests
  // =========================================================================
  let reqUrl = decodeURIComponent(pathname);
  if (reqUrl === '/' || reqUrl === '') {
    reqUrl = '/index.html';
  }

  const filePath = path.join(PUBLIC_DIR, reqUrl);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access Denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const total = stats.size;

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunkSize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });

      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🎙️  VOICE DUB HERO - SERVIDOR INICIADO`);
  console.log(`🎮  Accede al juego en: http://localhost:${PORT}`);
  console.log(`🌐  Proxy GameBanana + Video Transcoder Activo`);
  console.log(`==================================================\n`);
});
