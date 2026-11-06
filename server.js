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
import { pipeline } from 'stream';
import { fileURLToPath } from 'url';
import { ZipEngine } from './src/zip-engine.js';
import { GameRoom } from './room-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
// Local game server: only reachable from this computer unless HOST is set explicitly.
// The multiplayer room opens its own LAN ports only while the host has a room open.
const HOST = process.env.HOST || '127.0.0.1';
const ROOM_HTTP_PORT = parseInt(process.env.ROOM_PORT || '3001', 10);
const ROOM_HTTPS_PORT = parseInt(process.env.ROOM_HTTPS_PORT || '3443', 10);
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
        res.resume(); // discard the redirect body so the socket is released
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, url).toString();
        }
        return resolve(pipeUrlStream(redirectUrl, clientRes, maxRedirects - 1, onHeaders));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GameBanana respondió con código HTTP ${res.statusCode}`));
      }
      if (onHeaders) {
        onHeaders(res);
      }
      // pipeline() destroys both sides if the upstream fails or the client disconnects
      pipeline(res, clientRes, (err) => (err ? reject(err) : resolve(true)));
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

function sendError(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message }));
}

/** Collect a POST body, then run handler; errors become a 500 instead of crashing Node */
function handlePostBody(req, res, handler) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('error', () => res.destroy());
  req.on('end', async () => {
    try {
      await handler(Buffer.concat(chunks));
    } catch (err) {
      console.error(`[${req.url}] Error:`, err);
      sendError(res, 500, err?.message || 'Error interno');
    }
  });
}

/**
 * The game only talks to its own server (same origin). Reject requests sent by other
 * websites, which could otherwise make this computer unpack / transcode arbitrary data.
 */
function isCrossOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/** Files of the project that must never be served (git data, Python venv, temp files) */
function isPrivatePath(relPath) {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  return parts.some(part =>
    part.startsWith('.') ||
    part === 'venv' ||
    part === 'multiplayer_room' || // shared room data and the HTTPS private key
    part === 'node_modules' ||
    part.startsWith('temp_')
  );
}

/** Parse a single "bytes=a-b" / "bytes=a-" / "bytes=-n" range; null if not satisfiable */
function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '') || total === 0) return null;
  let start;
  let end;
  if (m[1] === '') {
    // Suffix range: the last n bytes
    const suffix = parseInt(m[2], 10);
    if (suffix === 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
  }
  if (start >= total || start > end) return null;
  return { start, end };
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('Unhandled request error:', err);
    sendError(res, 500, 'Error interno del servidor');
  }
});

// Endpoints that players connected from the local network may use (besides the room
// API and the game's static files). Heavy local tools (ffmpeg / bsdtar) stay host-only.
const LAN_ALLOWED_API = new Set(['/api/gamebanana/feed', '/api/gamebanana/download']);

// Files that guests (local network or internet through the free tunnel) may load:
// only what the game page needs, never the rest of the project folder.
const GUEST_FILES = new Set(['/', '/index.html', '/styles.css', '/scenes_catalog.json', '/eres_un_juguete_e7314.zip', '/favicon.ico']);
function isGuestFile(pathname) {
  return GUEST_FILES.has(pathname) || /^\/src\/[A-Za-z0-9_\-]+\.js$/.test(pathname);
}

const room = new GameRoom({
  roomDir: path.join(__dirname, 'multiplayer_room'),
  httpPort: ROOM_HTTP_PORT,
  httpsPort: ROOM_HTTPS_PORT,
  lanHandler
});

/** Requests arriving on the room's LAN ports (other players' browsers) */
async function lanHandler(req, res) {
  try {
    let url;
    try {
      url = new URL(req.url, 'http://sala.local');
    } catch {
      sendError(res, 400, 'URL inválida');
      return;
    }
    if (url.pathname.startsWith('/api/room/')) {
      // Players who run the game on their own computer (http://localhost) call the
      // host's IP directly, so the room API allows cross-origin requests.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Room-Token, X-Room-Meta, X-Take-Count, X-Part-Index, X-Part-Count');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      await room.handle(req, res, url, { mainListener: false });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (!LAN_ALLOWED_API.has(url.pathname)) {
        sendError(res, 403, 'No disponible para los invitados de la sala');
        return;
      }
    } else if (!isGuestFile(url.pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    await handleRequest(req, res);
  } catch (err) {
    console.error('Unhandled room request error:', err);
    sendError(res, 500, 'Error interno del servidor');
  }
}

async function handleRequest(req, res) {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    sendError(res, 400, 'URL inválida');
    return;
  }
  const pathname = parsedUrl.pathname;

  if (req.method === 'POST' && isCrossOrigin(req)) {
    sendError(res, 403, 'Origen no permitido');
    return;
  }

  // =========================================================================
  // API: Multiplayer room (host's own browser on this computer)
  // =========================================================================
  if (pathname.startsWith('/api/room/') && req.socket.localPort === Number(PORT)) {
    await room.handle(req, res, parsedUrl, { mainListener: true });
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
    if (!modId || !/^\d+$/.test(modId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Falta el parámetro modId o no es válido' }));
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
        const totalSize = gbRes.headers['content-length'] || fileInfo._nFilesize;
        const headers = {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
          'X-File-Name': encodeURIComponent(fileName),
          'X-Scene-Title': encodeURIComponent(modName)
        };
        // An empty Content-Length header makes fetch() fail: only send it when known
        if (totalSize && /^\d+$/.test(String(totalSize))) headers['Content-Length'] = String(totalSize);
        res.writeHead(200, headers);
      });
      console.log(`[GameBanana] ✓ Stream completado para "${modName}" (${modId})!`);
    } catch (err) {
      console.error('[GameBanana] Error downloading mod:', err);
      // If the stream already started, abort it so the client sees the failure instead of hanging
      sendError(res, 500, `Error al descargar la escena: ${err.message}`);
    }
    return;
  }

  // =========================================================================
  // API: Universal Archive Unpacker & Transcoder (.rar, .zip, .7z)
  // =========================================================================
  if (pathname === '/api/unpack-archive' && req.method === 'POST') {
    handlePostBody(req, res, async (inputBuf) => {
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
    return;
  }

  // =========================================================================
  // API: Video Transcoding endpoint
  // =========================================================================
  if (pathname === '/api/transcode-video' && req.method === 'POST') {
    handlePostBody(req, res, async (inputBuf) => {
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
    return;
  }

  // =========================================================================
  // Static Files & Range Requests
  // =========================================================================
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'Método no permitido');
    return;
  }

  let reqUrl;
  try {
    reqUrl = decodeURIComponent(pathname);
  } catch {
    // Malformed escape such as "/%": used to throw and kill the whole server
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }
  if (reqUrl === '/' || reqUrl === '') {
    reqUrl = '/index.html';
  }

  const filePath = path.join(PUBLIC_DIR, reqUrl);
  const relPath = path.relative(PUBLIC_DIR, filePath);

  // Must stay inside the project folder (with a separator: "/x/Juego_backup" is outside)
  // and must not expose git data, the Python venv or temp files
  if (relPath.startsWith('..') || path.isAbsolute(relPath) || reqUrl.includes('\0') || isPrivatePath(relPath)) {
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
      const r = parseRange(range, total);
      if (!r) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Content-Type': 'text/plain' });
        res.end();
        return;
      }
      const { start, end } = r;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': (end - start) + 1,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });

      if (req.method === 'HEAD') { res.end(); return; }
      // pipeline() closes the file when the browser aborts the request (every video seek)
      pipeline(fs.createReadStream(filePath, { start, end }), res, () => {});
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });

      if (req.method === 'HEAD') { res.end(); return; }
      pipeline(fs.createReadStream(filePath), res, () => {});
    }
  });
}

// Close the free internet tunnel together with the game server
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    room.tunnel.stop();
    process.exit(0);
  });
}
process.on('exit', () => room.tunnel.stop());

server.listen(PORT, HOST, () => {
  console.log(`\n==================================================`);
  console.log(`🎙️  VOICE DUB HERO - SERVIDOR INICIADO`);
  console.log(`🎮  Accede al juego en: http://localhost:${PORT}`);
  console.log(`🌐  Proxy GameBanana + Video Transcoder Activo`);
  console.log(`==================================================\n`);
});
