/**
 * Voice Dub Hero - Multiplayer room (LAN / IP, no paid servers)
 *
 * The host's own computer is the server. When the host clicks "Crear sala", the game
 * server opens two extra listeners on the local network:
 *   - HTTP  (default port 3001): used by players who run the game on their own computer
 *     and join by typing the host's IP.
 *   - HTTPS (default port 3443, self-signed certificate): the "link" mode. Anyone opens
 *     the link in a browser, types a name and joins. HTTPS is required by browsers to
 *     allow the microphone on a page that is not served from localhost.
 *
 * Real-time updates are pushed with Server-Sent Events; actions are plain HTTP requests.
 * Shared scenes and each player's recorded takes are stored in ./multiplayer_room/.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { pipeline } from 'stream';
import { TunnelManager } from './tunnel.js';

const MAX_SCENE_BYTES = 800 * 1024 * 1024;
// Big scenes are uploaded in parts: the free internet tunnel rejects request bodies > 100 MB
const MAX_PART_BYTES = 60 * 1024 * 1024;
const MAX_PARTS = Math.ceil(MAX_SCENE_BYTES / (40 * 1024 * 1024));
const MAX_TAKES_BYTES = 90 * 1024 * 1024; // all of one player's takes (tunnel limit is 100 MB)
const MAX_JSON_BYTES = 64 * 1024;
const ID_RE = /^[A-Za-z0-9_\-]{1,120}$/;
const OFFLINE_REMOVE_MS = 30000;
const POLL_WAIT_MS = 25000;
const ONLINE_GRACE_MS = 8000;

export function getLanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function sendJson(res, status, data) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON_BYTES) {
        reject(Object.assign(new Error('Petición demasiado grande'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON inválido'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Stream a request body into a file (written to .tmp, then renamed) with a size limit */
function saveBodyToFile(req, filePath, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > maxBytes) {
      reject(Object.assign(new Error('Archivo demasiado grande'), { status: 413 }));
      req.resume();
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const out = fs.createWriteStream(tmp);
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes && !tooBig) {
        tooBig = true;
        req.unpipe(out);
        out.destroy();
        req.resume();
      }
    });
    pipeline(req, out, (err) => {
      if (tooBig || err) {
        try { fs.unlinkSync(tmp); } catch {}
        reject(tooBig ? Object.assign(new Error('Archivo demasiado grande'), { status: 413 }) : err);
        return;
      }
      try {
        fs.renameSync(tmp, filePath);
        resolve(size);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Join uploaded parts (in order) into one file, then delete the parts */
async function concatParts(partPaths, filePath) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.join`;
  const out = fs.createWriteStream(tmp);
  try {
    for (const part of partPaths) {
      await new Promise((resolve, reject) => {
        const input = fs.createReadStream(part);
        input.on('error', reject);
        input.on('end', resolve);
        input.pipe(out, { end: false });
      });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    out.destroy();
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  } finally {
    for (const part of partPaths) {
      try { fs.unlinkSync(part); } catch {}
    }
  }
  return fs.statSync(filePath).size;
}

function streamFile(req, res, filePath, contentType) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      sendJson(res, 404, { error: 'No encontrado' });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    pipeline(fs.createReadStream(filePath), res, () => {});
  });
}

function cleanName(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 24);
}

function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

export class GameRoom {
  constructor({ roomDir, httpPort = 3001, httpsPort = 3443, lanHandler }) {
    this.roomDir = roomDir;
    this.httpPort = httpPort;
    this.httpsPort = httpsPort;
    this.lanHandler = lanHandler;
    // Free internet access (Cloudflare Quick Tunnel, no account)
    this.tunnel = new TunnelManager({ toolsDir: path.join(path.dirname(roomDir), 'tools') });
    // State version + pending long-polls (used through the tunnel, where SSE isn't available)
    this.version = 0;
    this.waiters = new Set();

    this.open = false;
    this.hostName = '';
    this.httpServer = null;
    this.httpsServer = null;
    this.httpsAvailable = false;
    this.httpsError = '';

    /** token -> player */
    this.players = new Map();
    this.session = null;
    this.sessionTimer = null;
    /** sceneId -> { id, title, size, characters, duration, uploadedBy } */
    this.scenes = new Map();
    this.streams = new Set();
    this.broadcastQueued = false;
    /** sceneId -> { playerId, parts, received: Set } for uploads in parts */
    this.uploads = new Map();

    fs.mkdirSync(path.join(roomDir, 'scenes'), { recursive: true });
    this.loadSceneIndex();

    // Keep SSE connections alive through proxies / sleeping network stacks
    this.keepAlive = setInterval(() => {
      for (const s of this.streams) {
        try { s.res.write(': ping\n\n'); } catch {}
      }
    }, 15000);
    this.keepAlive.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Persistence of shared scenes
  // ---------------------------------------------------------------------------

  sceneIndexPath() {
    return path.join(this.roomDir, 'scenes', 'index.json');
  }

  loadSceneIndex() {
    try {
      const list = JSON.parse(fs.readFileSync(this.sceneIndexPath(), 'utf8'));
      for (const s of list) {
        if (s && ID_RE.test(s.id) && fs.existsSync(this.sceneFile(s.id))) this.scenes.set(s.id, s);
      }
    } catch {}
  }

  saveSceneIndex() {
    try {
      fs.writeFileSync(this.sceneIndexPath(), JSON.stringify([...this.scenes.values()], null, 2));
    } catch (e) {
      console.warn('[Sala] No se pudo guardar el índice de escenas:', e.message);
    }
  }

  sceneFile(id) {
    return path.join(this.roomDir, 'scenes', `${id}.zip`);
  }

  takesFile(sessionId, playerId) {
    return path.join(this.roomDir, 'sessions', sessionId, `${playerId}.zip`);
  }

  /** Keep only the two most recent sessions' recordings on disk */
  pruneSessions(keepId) {
    const dir = path.join(this.roomDir, 'sessions');
    let entries = [];
    try {
      entries = fs.readdirSync(dir).map(name => ({ name, t: fs.statSync(path.join(dir, name)).mtimeMs }));
    } catch {
      return;
    }
    entries.sort((a, b) => b.t - a.t);
    for (const e of entries.slice(2)) {
      if (e.name === keepId) continue;
      try { fs.rmSync(path.join(dir, e.name), { recursive: true, force: true }); } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // LAN listeners (opened only while the room is open)
  // ---------------------------------------------------------------------------

  ensureCertificate() {
    const certDir = path.join(this.roomDir, 'cert');
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    }
    fs.mkdirSync(certDir, { recursive: true });
    const ips = getLanAddresses();
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map(ip => `IP:${ip}`)].join(',');
    const baseArgs = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
      '-days', '825', '-subj', '/CN=Voice Dub Hero (sala local)'];
    for (const bin of ['openssl', '/usr/bin/openssl', '/opt/homebrew/bin/openssl', '/usr/local/bin/openssl']) {
      for (const args of [[...baseArgs, '-addext', `subjectAltName=${san}`], baseArgs]) {
        const r = spawnSync(bin, args, { timeout: 30000, stdio: 'ignore' });
        if (r.status === 0 && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
          return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
        }
      }
    }
    throw new Error('No se encontró OpenSSL para crear el certificado HTTPS');
  }

  listen(server, port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    });
  }

  async startLan(hostName) {
    this.hostName = cleanName(hostName) || this.hostName || 'Anfitrión';
    if (this.open) return this.hostStatus();

    const handler = (req, res) => this.lanHandler(req, res);
    const httpServer = http.createServer(handler);
    try {
      await this.listen(httpServer, this.httpPort);
    } catch (err) {
      throw new Error(err.code === 'EADDRINUSE'
        ? `El puerto ${this.httpPort} ya está en uso. Cierra la otra aplicación que lo usa.`
        : `No se pudo abrir la sala: ${err.message}`);
    }
    this.httpServer = httpServer;

    this.httpsAvailable = false;
    this.httpsError = '';
    try {
      const creds = this.ensureCertificate();
      const httpsServer = https.createServer(creds, handler);
      await this.listen(httpsServer, this.httpsPort);
      this.httpsServer = httpsServer;
      this.httpsAvailable = true;
    } catch (err) {
      this.httpsError = err.code === 'EADDRINUSE' ? `El puerto ${this.httpsPort} ya está en uso` : err.message;
      console.warn('[Sala] HTTPS no disponible:', this.httpsError);
    }

    this.open = true;
    console.log(`[Sala] Abierta por ${this.hostName} en ${getLanAddresses().join(', ') || 'esta red'} ` +
      `(HTTP ${this.httpPort}${this.httpsAvailable ? `, HTTPS ${this.httpsPort}` : ''})`);
    this.queueBroadcast();
    return this.hostStatus();
  }

  async stopLan() {
    this.open = false;
    this.clearSessionTimer();
    this.session = null;
    for (const s of [...this.streams]) {
      try {
        s.res.write(`event: closed\ndata: {}\n\n`);
        s.res.end();
      } catch {}
    }
    this.streams.clear();
    for (const w of [...this.waiters]) {
      clearTimeout(w.timer);
      sendJson(w.res, 200, { closed: true });
    }
    this.waiters.clear();
    this.tunnel.stop();
    for (const p of this.players.values()) {
      if (p.removeTimer) clearTimeout(p.removeTimer);
    }
    this.players.clear();
    const closeServer = (srv) => new Promise((r) => {
      if (!srv) return r();
      srv.close(() => r());
      srv.closeAllConnections?.();
    });
    await Promise.all([closeServer(this.httpServer), closeServer(this.httpsServer)]);
    this.httpServer = null;
    this.httpsServer = null;
    console.log('[Sala] Cerrada');
    return this.hostStatus();
  }

  hostStatus() {
    const ips = getLanAddresses();
    return {
      open: this.open,
      tunnel: this.tunnel.status(),
      hostName: this.hostName,
      ips,
      httpPort: this.httpPort,
      httpsPort: this.httpsPort,
      httpsAvailable: this.httpsAvailable,
      httpsError: this.httpsError,
      links: ips.map(ip => ({
        ip,
        secure: this.httpsAvailable ? `https://${ip}:${this.httpsPort}/` : null,
        plain: `http://${ip}:${this.httpPort}/`
      }))
    };
  }

  // ---------------------------------------------------------------------------
  // State broadcast (Server-Sent Events)
  // ---------------------------------------------------------------------------

  publicPlayers() {
    const picks = this.session?.picks || {};
    const pickByPlayer = {};
    for (const [character, playerId] of Object.entries(picks)) pickByPlayer[playerId] = character;
    return [...this.players.values()]
      .sort((a, b) => (b.isHost - a.isHost) || (a.joinedAt - b.joinedAt))
      .map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        online: p.streams > 0 || Date.now() - (p.lastSeen || 0) < ONLINE_GRACE_MS,
        character: pickByPlayer[p.id] || null,
        ready: !!this.session && this.session.ready.has(p.id)
      }));
  }

  publicSession() {
    const s = this.session;
    if (!s) return null;
    const nameOf = (id) => [...this.players.values()].find(p => p.id === id)?.name || 'Jugador';
    return {
      id: s.id,
      sceneId: s.sceneId,
      sceneTitle: s.sceneTitle,
      sceneDuration: s.sceneDuration,
      characters: s.characters,
      chosenBy: s.chosenBy,
      status: s.status,
      picks: Object.fromEntries(Object.entries(s.picks).map(([c, id]) => [c, { playerId: id, name: nameOf(id) }])),
      ready: [...s.ready],
      participants: s.participants,
      cancelledBy: s.cancelledBy || null,
      // Lines recorded so far by each player (they record take by take, each at their own pace)
      progress: s.progress,
      submissions: Object.values(s.submissions)
    };
  }

  snapshot() {
    return {
      open: this.open,
      hostName: this.hostName,
      serverNow: Date.now(),
      players: this.publicPlayers(),
      scenes: [...this.scenes.values()],
      session: this.publicSession()
    };
  }

  queueBroadcast() {
    if (this.broadcastQueued) return;
    this.broadcastQueued = true;
    setImmediate(() => {
      this.broadcastQueued = false;
      this.version += 1;
      const snap = this.snapshot();
      const data = `event: state\ndata: ${JSON.stringify(snap)}\n\n`;
      for (const s of this.streams) {
        try { s.res.write(data); } catch {}
      }
      for (const w of [...this.waiters]) {
        clearTimeout(w.timer);
        this.waiters.delete(w);
        sendJson(w.res, 200, { version: this.version, state: snap });
      }
    });
  }

  /** A player's connection (SSE stream or long-poll) opened */
  playerConnected(player) {
    const wasOnline = player.streams > 0 || Date.now() - (player.lastSeen || 0) < ONLINE_GRACE_MS;
    player.streams += 1;
    player.lastSeen = Date.now();
    if (player.removeTimer) {
      clearTimeout(player.removeTimer);
      player.removeTimer = null;
    }
    return wasOnline;
  }

  playerDisconnected(player) {
    player.streams = Math.max(0, player.streams - 1);
    player.lastSeen = Date.now();
    // Give a reload / flaky Wi-Fi a moment before freeing the player's character
    if (player.streams === 0) this.scheduleRemoval(player);
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  clearSessionTimer() {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
  }

  completeSession() {
    const s = this.session;
    if (!s || s.status !== 'dubbing') return;
    this.clearSessionTimer();
    s.status = 'complete';
    console.log(`[Sala] Doblaje en grupo terminado: "${s.sceneTitle}" (${Object.keys(s.submissions).length} jugadores)`);
    this.queueBroadcast();
  }

  /** Complete when every participant still in the room has sent their takes */
  maybeComplete() {
    const s = this.session;
    if (!s || s.status !== 'dubbing') return;
    const present = new Set([...this.players.values()].map(p => p.id));
    const pending = s.participants.filter(id => !s.submissions[id] && present.has(id));
    if (pending.length === 0 && Object.keys(s.submissions).length > 0) this.completeSession();
  }

  /** Forget a player who has no live connection for a while (closed tab, lost Wi-Fi…) */
  scheduleRemoval(player) {
    if (player.removeTimer) clearTimeout(player.removeTimer);
    player.removeTimer = setTimeout(() => {
      player.removeTimer = null;
      if (player.streams > 0) return;
      this.releasePlayer(player);
      this.players.delete(player.token);
      // Don't make the others wait forever for somebody who left mid-session
      this.maybeComplete();
      this.queueBroadcast();
    }, OFFLINE_REMOVE_MS);
    player.removeTimer.unref?.();
  }

  releasePlayer(player) {
    const s = this.session;
    if (s) {
      for (const [c, id] of Object.entries(s.picks)) {
        if (id === player.id && s.status === 'setup') delete s.picks[c];
      }
      s.ready.delete(player.id);
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP API: /api/room/*
  // ---------------------------------------------------------------------------

  playerFromReq(req, url) {
    const token = req.headers['x-room-token'] || url.searchParams.get('token') || '';
    return token ? this.players.get(String(token)) || null : null;
  }

  /**
   * @param {{ mainListener: boolean }} ctx  mainListener = request arrived on the local
   *   game server (127.0.0.1), i.e. from the host's own browser.
   * @returns {Promise<boolean>} whether the request was handled
   */
  async handle(req, res, url, ctx) {
    const p = url.pathname;
    if (!p.startsWith('/api/room/')) return false;
    const route = p.slice('/api/room/'.length);
    const isHostRequest = ctx.mainListener && isLoopback(req);

    try {
      // ---- info available to everyone -------------------------------------
      if (route === 'whoami' && req.method === 'GET') {
        sendJson(res, 200, { canHost: isHostRequest, lan: !ctx.mainListener, open: this.open, hostName: this.hostName });
        return true;
      }
      if (route === 'time' && req.method === 'GET') {
        sendJson(res, 200, { now: Date.now() });
        return true;
      }

      // ---- host administration (only from the host's own computer) --------
      if (route.startsWith('host/')) {
        if (!isHostRequest) {
          sendJson(res, 403, { error: 'Solo el anfitrión puede hacer esto' });
          return true;
        }
        if (route === 'host/status' && req.method === 'GET') {
          sendJson(res, 200, this.hostStatus());
        } else if (route === 'host/tunnel/start' && req.method === 'POST') {
          if (!this.open) {
            sendJson(res, 409, { error: 'Primero crea la sala' });
          } else {
            this.tunnel.start(this.httpPort);
            sendJson(res, 200, this.hostStatus());
          }
        } else if (route === 'host/tunnel/stop' && req.method === 'POST') {
          this.tunnel.stop();
          sendJson(res, 200, this.hostStatus());
        } else if (route === 'host/start' && req.method === 'POST') {
          const body = await readJsonBody(req);
          sendJson(res, 200, await this.startLan(body.name));
        } else if (route === 'host/stop' && req.method === 'POST') {
          sendJson(res, 200, await this.stopLan());
        } else {
          sendJson(res, 404, { error: 'No encontrado' });
        }
        return true;
      }

      if (route === 'join' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const name = cleanName(body.name);
        if (!name) {
          sendJson(res, 400, { error: 'Escribe un nombre de usuario' });
          return true;
        }
        if (!this.open) {
          sendJson(res, 409, { error: isHostRequest ? 'Primero crea la sala' : 'La sala está cerrada' });
          return true;
        }
        let player = body.token ? this.players.get(String(body.token)) : null;
        if (!player) {
          const token = crypto.randomBytes(16).toString('hex');
          player = { id: newId('p_'), token, name, isHost: isHostRequest, streams: 0, joinedAt: Date.now(), removeTimer: null };
          this.players.set(token, player);
        }
        player.name = name;
        if (player.streams === 0) this.scheduleRemoval(player); // until its live connection opens
        if (isHostRequest) {
          player.isHost = true;
          this.hostName = name;
        }
        console.log(`[Sala] ${player.name} se unió${player.isHost ? ' (anfitrión)' : ''}`);
        this.queueBroadcast();
        sendJson(res, 200, { token: player.token, playerId: player.id, state: this.snapshot() });
        return true;
      }

      if (route === 'events' && req.method === 'GET') {
        const player = this.playerFromReq(req, url);
        if (!player || !this.open) {
          sendJson(res, player ? 409 : 401, { error: player ? 'La sala está cerrada' : 'Únete a la sala primero' });
          return true;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write('retry: 2000\n\n');
        const entry = { res, player };
        this.streams.add(entry);
        this.playerConnected(player);
        res.write(`event: state\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
        this.queueBroadcast();
        req.on('close', () => {
          this.streams.delete(entry);
          this.playerDisconnected(player);
          this.queueBroadcast();
        });
        return true;
      }

      // Long-polling alternative to SSE (Cloudflare Quick Tunnels don't support SSE):
      // answers at once if the state changed since `since`, otherwise waits for a change.
      if (route === 'poll' && req.method === 'GET') {
        const player = this.playerFromReq(req, url);
        if (!player) {
          sendJson(res, 401, { error: 'Únete a la sala primero' });
          return true;
        }
        if (!this.open) {
          sendJson(res, 200, { closed: true });
          return true;
        }
        const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
        const wasOnline = this.playerConnected(player);
        res.on('close', () => this.playerDisconnected(player));
        if (!wasOnline) this.queueBroadcast(); // tell the others this player is here
        if (since !== this.version || !wasOnline) {
          if (wasOnline) sendJson(res, 200, { version: this.version, state: this.snapshot() });
          else this.waiters.add({ res, timer: null }); // answered by the broadcast just queued
          return true;
        }
        const waiter = { res, timer: null };
        waiter.timer = setTimeout(() => {
          this.waiters.delete(waiter);
          sendJson(res, 200, { version: this.version, state: null });
        }, POLL_WAIT_MS);
        this.waiters.add(waiter);
        req.on('close', () => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
        });
        return true;
      }

      // ---- everything below requires a joined player ----------------------
      const player = this.playerFromReq(req, url);
      if (!player) {
        sendJson(res, 401, { error: 'Únete a la sala primero' });
        return true;
      }
      if (!this.open) {
        sendJson(res, 409, { error: 'La sala está cerrada' });
        return true;
      }

      if (route === 'leave' && req.method === 'POST') {
        this.releasePlayer(player);
        if (player.removeTimer) clearTimeout(player.removeTimer);
        this.players.delete(player.token);
        this.queueBroadcast();
        sendJson(res, 200, { ok: true });
        return true;
      }

      // Shared scene packages
      const sceneMatch = /^scenes\/([^/]+)$/.exec(route);
      if (sceneMatch) {
        const id = decodeURIComponent(sceneMatch[1]);
        if (!ID_RE.test(id)) {
          sendJson(res, 400, { error: 'Id de escena inválido' });
          return true;
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (!this.scenes.has(id)) {
            sendJson(res, 404, { error: 'Escena no compartida' });
            return true;
          }
          streamFile(req, res, this.sceneFile(id), 'application/zip');
          return true;
        }
        if (req.method === 'PUT') {
          let meta = {};
          try { meta = JSON.parse(decodeURIComponent(req.headers['x-room-meta'] || '%7B%7D')); } catch {}
          const partCount = parseInt(req.headers['x-part-count'] || '1', 10);
          const partIndex = parseInt(req.headers['x-part-index'] || '0', 10);
          let size;
          if (partCount > 1) {
            if (!(partCount <= MAX_PARTS && partIndex >= 0 && partIndex < partCount)) {
              req.resume();
              sendJson(res, 400, { error: 'Parte de la escena inválida' });
              return true;
            }
            let up = this.uploads.get(id);
            if (!up || up.playerId !== player.id || up.parts !== partCount || partIndex === 0) {
              up = { playerId: player.id, parts: partCount, received: new Set() };
              this.uploads.set(id, up);
            }
            await saveBodyToFile(req, `${this.sceneFile(id)}.part${partIndex}`, MAX_PART_BYTES);
            up.received.add(partIndex);
            if (up.received.size < partCount) {
              sendJson(res, 200, { ok: true, part: partIndex, received: up.received.size, parts: partCount });
              return true;
            }
            this.uploads.delete(id);
            const parts = Array.from({ length: partCount }, (_, i) => `${this.sceneFile(id)}.part${i}`);
            size = await concatParts(parts, this.sceneFile(id));
          } else {
            size = await saveBodyToFile(req, this.sceneFile(id), MAX_SCENE_BYTES);
          }
          this.scenes.set(id, {
            id,
            title: String(meta.title || 'Escena').slice(0, 200),
            characters: Array.isArray(meta.characters) ? meta.characters.map(c => String(c).slice(0, 60)).slice(0, 30) : [],
            duration: Number(meta.duration) || 0,
            gamebananaId: Number(meta.gamebananaId) || null,
            size,
            uploadedBy: player.name
          });
          this.saveSceneIndex();
          this.queueBroadcast();
          sendJson(res, 200, { ok: true, size });
          return true;
        }
      }

      if (route === 'select-scene' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const scene = this.scenes.get(String(body.sceneId || ''));
        if (!scene) {
          sendJson(res, 404, { error: 'La escena aún no se ha subido a la sala' });
          return true;
        }
        if (this.session?.status === 'dubbing') {
          sendJson(res, 409, { error: 'Hay un doblaje en curso: cancelad o terminad primero' });
          return true;
        }
        this.clearSessionTimer();
        const characters = (Array.isArray(body.characters) && body.characters.length ? body.characters : scene.characters)
          .map(c => String(c).slice(0, 60)).slice(0, 30);
        this.session = {
          id: newId('s_'),
          sceneId: scene.id,
          sceneTitle: scene.title,
          sceneDuration: Number(body.duration) || scene.duration || 60,
          characters,
          chosenBy: player.name,
          status: 'setup',
          picks: {},
          ready: new Set(),
          participants: [],
          progress: {},
          submissions: {}
        };
        this.pruneSessions(this.session.id);
        console.log(`[Sala] ${player.name} eligió "${scene.title}"`);
        this.queueBroadcast();
        sendJson(res, 200, { ok: true, sessionId: this.session.id });
        return true;
      }

      const s = this.session;
      const body = (req.method === 'POST') ? await readJsonBody(req) : {};
      const sameSession = s && (!body.sessionId || body.sessionId === s.id);

      if (route === 'ready' && req.method === 'POST') {
        if (sameSession) {
          s.ready.add(player.id);
          this.queueBroadcast();
        }
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (route === 'pick' && req.method === 'POST') {
        if (!sameSession || s.status !== 'setup') {
          sendJson(res, 409, { error: 'Ahora no se puede cambiar de personaje' });
          return true;
        }
        const character = body.character == null ? null : String(body.character);
        if (character !== null && !s.characters.includes(character)) {
          sendJson(res, 400, { error: 'Ese personaje no está en la escena' });
          return true;
        }
        if (character !== null && s.picks[character] && s.picks[character] !== player.id) {
          sendJson(res, 409, { error: 'Otro jugador ya eligió ese personaje' });
          return true;
        }
        for (const [c, id] of Object.entries(s.picks)) {
          if (id === player.id) delete s.picks[c];
        }
        if (character !== null) s.picks[character] = player.id;
        this.queueBroadcast();
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (route === 'start' && req.method === 'POST') {
        if (!sameSession || s.status !== 'setup') {
          sendJson(res, 409, { error: 'El doblaje ya empezó o no hay escena elegida' });
          return true;
        }
        const participants = [...new Set(Object.values(s.picks))];
        if (participants.length === 0) {
          sendJson(res, 409, { error: 'Al menos una persona tiene que elegir un personaje' });
          return true;
        }
        const notReady = [...this.players.values()].filter(p => p.streams > 0 && !s.ready.has(p.id));
        if (notReady.length > 0) {
          sendJson(res, 409, { error: `Esperando a que ${notReady.map(p => p.name).join(', ')} termine de recibir la escena` });
          return true;
        }
        // Everybody goes to their own take studio: each records the lines of their
        // character one by one (and can redo any of them) at the same time as the others
        s.status = 'dubbing';
        s.participants = participants;
        s.progress = {};
        s.submissions = {};
        s.cancelledBy = null;
        console.log(`[Sala] ¡${player.name} inició el doblaje en grupo de "${s.sceneTitle}"!`);
        this.queueBroadcast();
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (route === 'progress' && req.method === 'POST') {
        if (sameSession && s.status === 'dubbing' && s.participants.includes(player.id)) {
          const recorded = Math.max(0, Math.min(999, parseInt(body.recorded, 10) || 0));
          const total = Math.max(0, Math.min(999, parseInt(body.total, 10) || 0));
          s.progress[player.id] = { recorded, total };
          this.queueBroadcast();
        }
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (route === 'finish-now' && req.method === 'POST') {
        if (!player.isHost) {
          sendJson(res, 403, { error: 'Solo el anfitrión puede terminar sin esperar' });
          return true;
        }
        if (!sameSession || s.status !== 'dubbing' || Object.keys(s.submissions).length === 0) {
          sendJson(res, 409, { error: 'Todavía nadie ha enviado sus tomas' });
          return true;
        }
        this.completeSession();
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (route === 'cancel' && req.method === 'POST') {
        if (sameSession && s.status === 'dubbing') {
          this.clearSessionTimer();
          s.status = 'setup';
          s.progress = {};
          s.submissions = {};
          s.participants = [];
          s.cancelledBy = player.name;
          this.queueBroadcast();
        }
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (route === 'end' && req.method === 'POST') {
        if (s && s.status !== 'dubbing') {
          this.clearSessionTimer();
          this.session = null;
          this.queueBroadcast();
        }
        sendJson(res, 200, { ok: true });
        return true;
      }

      // Each player's takes (one ZIP with every recorded line of their character)
      const takesMatch = /^session\/([^/]+)\/takes(?:\/([^/]+))?$/.exec(route);
      if (takesMatch) {
        const sessionId = decodeURIComponent(takesMatch[1]);
        if (!ID_RE.test(sessionId)) {
          sendJson(res, 400, { error: 'Sesión inválida' });
          return true;
        }
        if (req.method === 'PUT' && !takesMatch[2]) {
          if (!s || s.id !== sessionId || s.status !== 'dubbing' || !s.participants.includes(player.id)) {
            req.resume();
            sendJson(res, 409, { error: 'Estas tomas ya no pertenecen a un doblaje en curso' });
            return true;
          }
          const size = await saveBodyToFile(req, this.takesFile(sessionId, player.id), MAX_TAKES_BYTES);
          const character = Object.entries(s.picks).find(([, id]) => id === player.id)?.[0] || '';
          const count = Math.max(0, Math.min(999, parseInt(req.headers['x-take-count'], 10) || 0));
          s.submissions[player.id] = { playerId: player.id, playerName: player.name, character, count, size };
          console.log(`[Sala] ${player.name} envió sus ${count} tomas de ${character}`);
          this.queueBroadcast();
          this.maybeComplete();
          sendJson(res, 200, { ok: true });
          return true;
        }
        if ((req.method === 'GET' || req.method === 'HEAD') && takesMatch[2]) {
          const playerId = decodeURIComponent(takesMatch[2]);
          const info = s && s.id === sessionId ? s.submissions[playerId] : null;
          if (!ID_RE.test(playerId) || !info) {
            sendJson(res, 404, { error: 'Tomas no encontradas' });
            return true;
          }
          streamFile(req, res, this.takesFile(sessionId, playerId), 'application/zip');
          return true;
        }
      }

      sendJson(res, 404, { error: 'No encontrado' });
      return true;
    } catch (err) {
      console.error(`[Sala] Error en ${route}:`, err);
      sendJson(res, err.status || 500, { error: err.message || 'Error interno' });
      return true;
    }
  }
}
