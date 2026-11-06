/**
 * Voice Dub Hero - Multiplayer mode (LAN / IP, no paid servers)
 *
 * - Ask for a user name first, then either create a room (the host's computer is the
 *   server), join by typing the host's IP, or open the room link (name only).
 * - Anyone can choose a scene: everybody is taken into it in real time. The scene files
 *   travel through the room, so only one person needs to have downloaded it.
 * - Each player picks a character and everybody dubs AT THE SAME TIME, each in their own
 *   take studio: the lines of their character are recorded one by one (any take can be
 *   listened to and redone), at each player's own pace. Everybody sees the others'
 *   progress live.
 * - Shared downloads: while connected, every scene in a player's library is shared with the
 *   room and the others receive it automatically in "Mis Escenas" (can be switched off).
 * - When every player has sent their takes, everybody receives the combined dub (each
 *   line with the voice of whoever dubbed it) in "Mis Doblajes" and it starts playing.
 */

import { ZipEngine } from './zip-engine.js';
import { GameDB } from './db.js';
import { SFX } from './sfx.js';

const NAME_KEY = 'vdh_mp_name';
const SESSION_KEY = 'vdh_mp_session';
const LAST_IP_KEY = 'vdh_mp_last_ip';
const DONE_KEY = 'vdh_mp_done_sessions';
const AUTOSHARE_KEY = 'vdh_mp_autoshare';
const IGNORED_KEY = 'vdh_mp_ignored_scenes';
const ROOM_HTTP_PORT = 3001;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// localStorage only holds per-browser conveniences (name, last IP, reconnect token)
function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function lsDel(key) {
  try { localStorage.removeItem(key); } catch {}
}

function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Normalise the binary formats a scene file can have after IndexedDB into a Uint8Array */
export function toU8(raw) {
  if (!raw) return null;
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (typeof raw === 'object' && raw.buffer instanceof ArrayBuffer) {
    return new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength || raw.length);
  }
  if (typeof raw === 'object') {
    // Very old saves: plain object {0: byte, 1: byte, ...}
    let len = raw.length;
    if (len == null) {
      const keys = Object.keys(raw).filter(k => !isNaN(k));
      if (keys.length === 0) return null;
      len = Math.max(...keys.map(Number)) + 1;
    }
    const u8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) u8[i] = raw[i] || 0;
    return u8;
  }
  return null;
}

/** Pack a library scene (metadata + all its files) into a ZIP blob to share it */
export async function packScene(scene) {
  const meta = {};
  for (const [k, v] of Object.entries(scene)) {
    if (k !== 'rawFiles') meta[k] = v;
  }
  meta.dialogues = (scene.dialogues || []).map(d => {
    const { audioEl, ...rest } = d;
    return rest;
  });
  const files = { 'scene.json': new TextEncoder().encode(JSON.stringify(meta)) };
  for (const [key, value] of Object.entries(scene.rawFiles || {})) {
    const u8 = toU8(value);
    if (u8) files[`raw/${key}`] = u8;
  }
  return ZipEngine.createZip(files);
}

/** Inverse of packScene */
export async function unpackScene(buffer) {
  const files = await ZipEngine.unzip(buffer);
  const metaRaw = files['scene.json'];
  if (!metaRaw) throw new Error('El paquete de la escena está incompleto');
  const scene = JSON.parse(new TextDecoder().decode(metaRaw));
  scene.rawFiles = {};
  for (const [key, data] of Object.entries(files)) {
    if (key.startsWith('raw/')) scene.rawFiles[key.slice(4)] = data;
  }
  return scene;
}

// =============================================================================
// Room API client
// =============================================================================

export class RoomClient {
  constructor(base) {
    this.base = String(base || '').replace(/\/+$/, '');
    this.token = null;
    this.offset = 0;
    this.es = null;
  }

  url(p) {
    return this.base + p;
  }

  async request(method, p, body) {
    const headers = {};
    if (this.token) headers['X-Room-Token'] = this.token;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(this.url(p), { method, headers, body: payload, cache: 'no-store' });
    } catch {
      throw new Error('No se pudo conectar con la sala. Revisa la IP y que estéis en la misma red Wi-Fi.');
    }
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** Cloudflare Quick Tunnels don't support Server-Sent Events: use long-polling there */
  usesTunnel() {
    try {
      return new URL(this.base || window.location.href).hostname.endsWith('.trycloudflare.com');
    } catch {
      return false;
    }
  }

  connect(handlers) {
    this.disconnect();
    if (this.usesTunnel()) {
      this.startPolling(handlers);
      return;
    }
    const { onState, onClosed, onLost } = handlers;
    let gotState = false;
    const es = new EventSource(this.url(`/api/room/events?token=${encodeURIComponent(this.token)}`));
    es.addEventListener('state', () => { gotState = true; }, { once: true });
    es.addEventListener('state', (e) => {
      try { onState(JSON.parse(e.data)); } catch (err) { console.warn('[Sala] Estado inválido', err); }
    });
    es.addEventListener('closed', () => {
      this.disconnect();
      onClosed();
    });
    es.onerror = () => {
      if (this.es !== es) return;
      if (!gotState) {
        // Live stream blocked on this network/proxy: fall back to long-polling
        es.close();
        this.es = null;
        this.startPolling(handlers);
        return;
      }
      // CONNECTING = the browser retries by itself; CLOSED = the server refused us
      if (es.readyState === EventSource.CLOSED) {
        this.es = null;
        onLost();
      }
    };
    this.es = es;
  }

  startPolling({ onState, onClosed, onLost }) {
    const ctrl = { stopped: false, abort: new AbortController() };
    this.poller = ctrl;
    (async () => {
      let since = -1;
      let failures = 0;
      while (!ctrl.stopped) {
        try {
          const res = await fetch(this.url(`/api/room/poll?token=${encodeURIComponent(this.token)}&since=${since}`), {
            cache: 'no-store',
            signal: ctrl.abort.signal
          });
          if (ctrl.stopped) return;
          if (res.status === 401) {
            this.poller = null;
            onLost();
            return;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          failures = 0;
          if (data.closed) {
            this.poller = null;
            onClosed();
            return;
          }
          if (data.state) {
            since = data.version;
            onState(data.state);
          } else if (typeof data.version === 'number') {
            since = data.version;
          }
        } catch (err) {
          if (ctrl.stopped) return;
          failures += 1;
          if (failures >= 6) {
            this.poller = null;
            onLost();
            return;
          }
          await new Promise(r => setTimeout(r, 1500 * failures));
        }
      }
    })();
  }

  disconnect() {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    if (this.poller) {
      this.poller.stopped = true;
      try { this.poller.abort.abort(); } catch {}
      this.poller = null;
    }
  }

  /** Binary upload / download with progress (fetch can't report upload progress) */
  transfer(method, p, { body = null, headers = {}, onProgress = null, responseType = 'json' } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, this.url(p));
      xhr.responseType = responseType;
      if (this.token) xhr.setRequestHeader('X-Room-Token', this.token);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      const progress = (e) => {
        if (onProgress && e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      };
      if (method === 'GET') xhr.onprogress = progress;
      else if (xhr.upload) xhr.upload.onprogress = progress;
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response);
          return;
        }
        let msg = xhr.status === 413
          ? 'El archivo es demasiado grande para enviarlo por internet (máximo 100 MB)'
          : `Error ${xhr.status}`;
        try {
          const data = responseType === 'json'
            ? xhr.response
            : JSON.parse(new TextDecoder().decode(xhr.response));
          if (data?.error) msg = data.error;
        } catch {}
        reject(Object.assign(new Error(msg), { status: xhr.status }));
      };
      xhr.onerror = () => reject(new Error('Se perdió la conexión con la sala'));
      xhr.send(body);
    });
  }
}

// =============================================================================
// Controller + "Multijugador" screen
// =============================================================================

export class MultiplayerController {
  constructor(app) {
    this.app = app;
    this.client = null;
    this.state = null;
    this.me = null; // { playerId, name }
    this.canHost = false;
    this.linkMode = false;
    this.hostInfo = null;
    this.editingName = false;
    this.connecting = false;
    this.error = '';
    this.transfer = null; // { label, percent, error }
    this.readyFor = null;
    this.preparingFor = null;
    this.collectingFor = null;
    this.studioSessionId = null;
    this.inRoomStudio = false;
    this.changedSinceSubmit = null;
    this.lastDubId = null;
    this.done = new Set(lsGet(DONE_KEY, []));
  }

  get name() {
    return lsGet(NAME_KEY, '');
  }

  isConnected() {
    return !!(this.client && this.me && this.state);
  }

  /** Kept for app.js: group dubbing happens in the normal take studio now */
  isBusy() {
    return false;
  }

  myPick() {
    const picks = this.state?.session?.picks || {};
    return Object.entries(picks).find(([, p]) => p.playerId === this.me?.playerId)?.[0] || null;
  }

  isHostPlayer() {
    return !!this.state?.players?.find(p => p.id === this.me?.playerId)?.isHost;
  }

  toast(msg, type = 'info') {
    this.app.showToast(msg, type);
  }

  micHelp() {
    if (!window.isSecureContext) {
      return '🎙️ El navegador solo deja usar el micrófono en páginas seguras. Abre el enlace https:// de la sala (o instala el juego y únete por IP).';
    }
    return '🎙️ No se pudo acceder al micrófono. Permite el acceso al micrófono en el navegador.';
  }

  // ---------------------------------------------------------------------------
  // Startup / connection
  // ---------------------------------------------------------------------------

  async init() {
    // Closing / reloading the page also breaks the live connection: that's not a lost room
    window.addEventListener('pagehide', () => { this.unloading = true; });
    try {
      const res = await fetch('/api/room/whoami', { cache: 'no-store' });
      if (res.ok) {
        const who = await res.json();
        this.canHost = !!who.canHost;
        this.linkMode = !!who.lan;
      }
    } catch {
      // Static hosting without the game server: only joining by IP is possible
    }

    const saved = lsGet(SESSION_KEY, null);
    if (this.linkMode) {
      // Opened from the room link: go straight to the room screen (only asks the name)
      this.app.navigate('room');
      if (saved && saved.base === '' && this.name) {
        await this.join('', this.name, { silent: true });
      }
      return;
    }
    if (saved && this.name) {
      if (saved.base === '' && this.canHost) {
        try {
          const st = await fetch('/api/room/host/status', { cache: 'no-store' }).then(r => r.json());
          if (st.open) {
            this.hostInfo = st;
            await this.join('', this.name, { silent: true });
          } else {
            lsDel(SESSION_KEY);
          }
        } catch {}
      } else if (saved.base) {
        await this.join(saved.base, this.name, { silent: true });
      }
    }
  }

  /**
   * Accepts the room code (internet), the full link, or an IP (same network):
   *   "brave-apple-salmon-kit" -> https://brave-apple-salmon-kit.trycloudflare.com
   *   "https://….trycloudflare.com/" -> that origin
   *   "192.168.1.25" -> http://192.168.1.25:3001
   */
  baseFromInput(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) {
      try {
        return new URL(raw).origin;
      } catch {
        return null;
      }
    }
    const host = raw.replace(/\/.*$/, '').toLowerCase();
    if (host.endsWith('.trycloudflare.com')) return `https://${host}`;
    // Room code: words joined by hyphens (no dots, no port)
    if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(host)) return `https://${host}.trycloudflare.com`;
    if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) return null;
    const hasPort = /:\d+$/.test(host) && !/^\[.*\]$/.test(host);
    return `http://${hasPort ? host : `${host}:${ROOM_HTTP_PORT}`}`;
  }

  async join(base, name, { silent = false } = {}) {
    this.connecting = true;
    this.error = '';
    this.refresh();
    const client = new RoomClient(base);
    try {
      const saved = lsGet(SESSION_KEY, null);
      const res = await client.request('POST', '/api/room/join', {
        name,
        token: saved && saved.base === base ? saved.token : undefined
      });
      client.token = res.token;
      this.client = client;
      this.me = { playerId: res.playerId, name };
      lsSet(SESSION_KEY, { base, token: res.token });
      this.applyState(res.state);
      client.connect({
        onState: (st) => this.applyState(st),
        onClosed: () => this.handleClosed(this.isHostPlayer() ? '🔒 Cerraste la sala.' : '🔒 El anfitrión cerró la sala.'),
        onLost: () => this.handleLost()
      });
      if (!silent) {
        SFX.playSuccess();
        this.toast(`¡Te uniste a la sala de ${this.state?.hostName || 'tu amigo'}!`, 'success');
      }
      this.syncLibrary();
    } catch (err) {
      this.client = null;
      this.error = err.message;
      if (silent) lsDel(SESSION_KEY);
      else SFX.playError();
    } finally {
      this.connecting = false;
      this.refresh(true);
    }
  }

  async createRoom() {
    const name = this.name;
    if (!name) return;
    this.connecting = true;
    this.error = '';
    this.refresh();
    try {
      const res = await fetch('/api/room/host/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo crear la sala');
      this.hostInfo = data;
      this.connecting = false;
      await this.join('', name, { silent: true });
      if (this.isConnected()) {
        SFX.playSuccess();
        this.toast('🏠 ¡Sala creada! Comparte el enlace o tu IP con tus amigos.', 'success');
      }
    } catch (err) {
      this.error = err.message;
      SFX.playError();
    } finally {
      this.connecting = false;
      this.refresh(true);
    }
  }

  async closeRoom() {
    try {
      await fetch('/api/room/host/stop', { method: 'POST' });
    } catch {}
    this.handleClosed('🔒 Cerraste la sala.');
  }

  async leave() {
    try { await this.client?.request('POST', '/api/room/leave', {}); } catch {}
    this.handleClosed('👋 Saliste de la sala.');
  }

  handleClosed(message) {
    clearTimeout(this.tunnelTimer);
    this.tunnelTimer = null;
    if (this.inRoomStudio && this.app.currentView === 'take_studio') {
      this.inRoomStudio = false;
      this.app.stopTakePlayback();
    }
    this.client?.disconnect();
    this.client = null;
    this.state = null;
    this.me = null;
    this.readyFor = null;
    this.transfer = null;
    lsDel(SESSION_KEY);
    if (message) this.toast(message, 'info');
    this.refresh(true);
  }

  async handleLost() {
    if (this.unloading) return;
    // The host restarted / dropped us: try to come back with the same name (a few times)
    const now = Date.now();
    this.lostTimes = (this.lostTimes || []).filter(t => now - t < 30000);
    this.lostTimes.push(now);
    if (this.lostTimes.length > 3) {
      this.handleClosed('⚠️ Se perdió la conexión con la sala.');
      return;
    }
    const base = this.client?.base ?? '';
    const name = this.me?.name || this.name;
    this.client = null;
    this.state = null;
    if (name) await this.join(base, name, { silent: true });
    if (!this.isConnected()) this.handleClosed('⚠️ Se perdió la conexión con la sala.');
  }

  // ---------------------------------------------------------------------------
  // Real-time state
  // ---------------------------------------------------------------------------

  applyState(state) {
    const prev = this.state;
    this.state = state;
    if (!state.open) {
      this.handleClosed('🔒 La sala está cerrada.');
      return;
    }
    const s = state.session;
    const prevS = prev?.session;

    if (s && (!prevS || prevS.id !== s.id)) this.onSceneChosen(s, !prev);

    const sceneIds = (state.scenes || []).map(x => x.id).join('|');
    if (prev && sceneIds !== (prev.scenes || []).map(x => x.id).join('|')) this.syncLibrary();

    // The group dub was cancelled (or the scene changed) while we were in our studio
    if (this.studioSessionId && this.app.currentView === 'take_studio' && this.inRoomStudio &&
        (!s || s.id !== this.studioSessionId || s.status === 'setup')) {
      this.inRoomStudio = false;
      this.app.stopTakePlayback();
      this.app.navigate('room');
      if (s?.cancelledBy) this.toast(`⏹️ ${s.cancelledBy} canceló el doblaje en grupo.`, 'info');
    }

    if (s && s.status === 'dubbing' && prevS?.status !== 'dubbing' && prev) {
      this.onDubbingStarted(s);
    }

    if (s && s.status === 'complete' && !this.done.has(s.id)) {
      this.collectResult(s);
    }

    this.updateStudioStrip();

    if (s && s.status === 'setup' && this.readyFor === s.id) {
      // Server forgot our ready flag (e.g. we reconnected): send it again
      if (!s.ready.includes(this.me?.playerId)) this.sendReady(s.id);
    }

    this.refresh();
  }

  onSceneChosen(s, initial) {
    if (s.status === 'complete') return;
    if (this.app.currentView !== 'room' && !this.isBusy()) this.app.navigate('room');
    if (!initial && s.chosenBy !== this.me?.name) {
      SFX.playSuccess();
      this.toast(`🎬 ${s.chosenBy} eligió «${s.sceneTitle}». ¡Elige tu personaje!`, 'success');
    }
    this.ensureSceneReady(s);
  }

  async sendReady(sessionId) {
    try { await this.client?.request('POST', '/api/room/ready', { sessionId }); } catch {}
  }

  async ensureSceneReady(s) {
    if (this.readyFor === s.id || this.preparingFor === s.id) return;
    this.preparingFor = s.id;
    try {
      if (!this.localSceneFor(s.sceneId)) {
        const roomScene = (this.state?.scenes || []).find(x => x.id === s.sceneId) || { id: s.sceneId, title: s.sceneTitle };
        await this.downloadScene(roomScene);
      }
      if (this.state?.session?.id === s.id) await this.sendReady(s.id);
      this.readyFor = s.id;
    } catch (err) {
      this.transfer = { error: `No se pudo recibir la escena: ${err.message}` };
    } finally {
      this.preparingFor = null;
      this.refresh();
    }
  }

  // ---------------------------------------------------------------------------
  // Shared library: what anybody downloads reaches everybody in the room
  // ---------------------------------------------------------------------------

  autoShareEnabled() {
    return lsGet(AUTOSHARE_KEY, true) !== false;
  }

  setAutoShare(on) {
    lsSet(AUTOSHARE_KEY, !!on);
    if (on) this.syncLibrary();
    this.refresh(true);
  }

  ignoredScenes() {
    return new Set(lsGet(IGNORED_KEY, []));
  }

  /** The player deleted this scene: don't download it again from the room */
  forgetScene(id) {
    const set = this.ignoredScenes();
    set.add(id);
    lsSet(IGNORED_KEY, [...set].slice(-300));
  }

  /** My copy of a room scene (same id, or the same GameBanana mod downloaded separately) */
  localSceneFor(sceneId) {
    const exact = this.app.scenes.find(x => x.id === sceneId);
    if (exact) return exact;
    const r = (this.state?.scenes || []).find(x => x.id === sceneId);
    if (r?.gamebananaId) return this.app.scenes.find(x => x.gamebananaId === r.gamebananaId) || null;
    return null;
  }

  sceneInRoom(local) {
    return (this.state?.scenes || []).some(r => r.id === local.id || (local.gamebananaId && r.gamebananaId === local.gamebananaId));
  }

  /** Upload one of my scenes to the room, in parts of 45 MB (the internet tunnel caps requests) */
  uploadScene(local) {
    if (!this.uploadJobs) this.uploadJobs = new Map();
    if (this.uploadJobs.has(local.id)) return this.uploadJobs.get(local.id);
    const job = (async () => {
      this.transfer = { label: `Preparando «${local.title}» para la sala…`, percent: 0 };
      this.refresh();
      const blob = await packScene(local);
      this.transfer = { label: `Compartiendo «${local.title}» con la sala (${formatMB(blob.size)})…`, percent: 0 };
      this.refresh();
      const meta = {
        title: local.title,
        characters: this.app.getDubbableCharacters(local),
        duration: local.duration,
        gamebananaId: local.gamebananaId || null
      };
      const PART = 45 * 1024 * 1024;
      const parts = Math.max(1, Math.ceil(blob.size / PART));
      for (let i = 0; i < parts; i++) {
        const chunk = blob.slice(i * PART, Math.min(blob.size, (i + 1) * PART));
        await this.client.transfer('PUT', `/api/room/scenes/${encodeURIComponent(local.id)}`, {
          body: chunk,
          headers: {
            'Content-Type': 'application/zip',
            'X-Room-Meta': encodeURIComponent(JSON.stringify(meta)),
            'X-Part-Index': String(i),
            'X-Part-Count': String(parts)
          },
          onProgress: (f) => this.setTransferPercent((i + f) / parts)
        });
      }
    })();
    this.uploadJobs.set(local.id, job);
    job.finally(() => {
      this.uploadJobs.delete(local.id);
      if (this.uploadJobs.size === 0 && (this.downloadJobs?.size || 0) === 0) this.transfer = null;
      this.refresh();
    }).catch(() => {});
    return job;
  }

  /** Download a room scene into my library ("Mis Escenas") */
  downloadScene(roomScene) {
    if (!this.downloadJobs) this.downloadJobs = new Map();
    if (this.downloadJobs.has(roomScene.id)) return this.downloadJobs.get(roomScene.id);
    const job = (async () => {
      this.transfer = { label: `Recibiendo «${roomScene.title}» de la sala…`, percent: 0 };
      this.refresh();
      const buf = await this.client.transfer('GET', `/api/room/scenes/${encodeURIComponent(roomScene.id)}`, {
        responseType: 'arraybuffer',
        onProgress: (f) => this.setTransferPercent(f)
      });
      this.transfer = { label: `Guardando «${roomScene.title}» en Mis Escenas…`, percent: 1 };
      this.updateTransferUI();
      const scene = await unpackScene(buf);
      scene.sharedFromRoom = true;
      if (roomScene.uploadedBy) scene.sharedBy = roomScene.uploadedBy;
      await GameDB.saveScene(scene);
      this.app.scenes = await GameDB.getAllScenes();
      // A scene received on purpose is no longer "deleted by me"
      const ignored = this.ignoredScenes();
      if (ignored.delete(scene.id)) lsSet(IGNORED_KEY, [...ignored]);
      this.app.refreshAfterBackgroundChange();
      return this.app.scenes.find(x => x.id === scene.id);
    })();
    this.downloadJobs.set(roomScene.id, job);
    job.finally(() => {
      this.downloadJobs.delete(roomScene.id);
      if (this.downloadJobs.size === 0 && (this.uploadJobs?.size || 0) === 0) this.transfer = null;
      this.refresh();
    }).catch(() => {});
    return job;
  }

  /**
   * Receive the room's scenes I don't have and share mine that the room doesn't have.
   * Runs one transfer at a time in the background; calls while running are merged.
   */
  async syncLibrary() {
    if (!this.isConnected()) return;
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    if (!this.syncFailed) this.syncFailed = new Set();
    try {
      do {
        this.syncAgain = false;
        const ignored = this.ignoredScenes();
        for (const r of [...(this.state?.scenes || [])]) {
          if (!this.isConnected()) return;
          if (this.localSceneFor(r.id) || ignored.has(r.id) || this.syncFailed.has(r.id)) continue;
          // Don't compete with a take that is being recorded right now
          while (this.app.isTakeRecording || this.app.isTakeArming) await new Promise(res => setTimeout(res, 1000));
          try {
            await this.downloadScene(r);
            this.toast(`📥 ${r.uploadedBy || 'La sala'} compartió «${r.title}». Ya está en Mis Escenas.`, 'success');
          } catch (err) {
            this.syncFailed.add(r.id);
            this.toast(`No se pudo recibir «${r.title}»: ${err.message}`, 'error');
          }
        }
        if (this.autoShareEnabled()) {
          for (const local of [...this.app.scenes]) {
            if (!this.isConnected()) return;
            if (local.sharedFromRoom || this.sceneInRoom(local) || this.syncFailed.has(local.id)) continue;
            while (this.app.isTakeRecording || this.app.isTakeArming) await new Promise(res => setTimeout(res, 1000));
            try {
              await this.uploadScene(local);
            } catch (err) {
              this.syncFailed.add(local.id);
              this.toast(`No se pudo compartir «${local.title}»: ${err.message}`, 'error');
            }
          }
        }
      } while (this.syncAgain && this.isConnected());
    } finally {
      this.syncing = false;
      this.refresh();
    }
  }

  setTransferPercent(f) {
    if (!this.transfer) return;
    this.transfer.percent = f;
    this.updateTransferUI();
  }

  updateTransferUI() {
    const bar = document.getElementById('mp-transfer-bar');
    const label = document.getElementById('mp-transfer-label');
    if (bar && this.transfer) bar.style.width = `${Math.round((this.transfer.percent || 0) * 100)}%`;
    if (label && this.transfer) label.textContent = `${this.transfer.label} ${Math.round((this.transfer.percent || 0) * 100)}%`;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async selectScene(sceneId) {
    if (!this.isConnected()) return;
    const local = this.app.scenes.find(x => x.id === sceneId);
    try {
      if (local && !this.sceneInRoom(local)) await this.uploadScene(local);
      // The same mod may already be in the room under another id
      const roomId = local && !(this.state.scenes || []).some(r => r.id === sceneId)
        ? ((this.state.scenes || []).find(r => local.gamebananaId && r.gamebananaId === local.gamebananaId)?.id || sceneId)
        : sceneId;
      SFX.playClick();
      await this.client.request('POST', '/api/room/select-scene', {
        sceneId: roomId,
        characters: local ? this.app.getDubbableCharacters(local) : undefined,
        duration: local?.duration
      });
    } catch (err) {
      SFX.playError();
      this.toast(`No se pudo elegir la escena: ${err.message}`, 'error');
      this.refresh();
    }
  }

  async pickCharacter(character) {
    const s = this.state?.session;
    if (!s || s.status !== 'setup') return;
    const releasing = this.myPick() === character;
    try {
      await this.client.request('POST', '/api/room/pick', { sessionId: s.id, character: releasing ? null : character });
      SFX.playClick();
      if (!releasing) {
        // Ask for the microphone now, so the permission prompt doesn't appear mid-scene
        const mic = await this.app.audio.requestMicrophone();
        if (!mic) {
          this.toast(this.micHelp(), 'error');
          await this.client.request('POST', '/api/room/pick', { sessionId: s.id, character: null });
        }
      }
    } catch (err) {
      SFX.playError();
      this.toast(err.message, 'error');
    }
  }

  async startGroup() {
    const s = this.state?.session;
    if (!s) return;
    try {
      await this.client.request('POST', '/api/room/start', { sessionId: s.id });
    } catch (err) {
      SFX.playError();
      this.toast(err.message, 'error');
    }
  }

  async cancelGroup() {
    const s = this.state?.session;
    if (!s) return;
    try { await this.client.request('POST', '/api/room/cancel', { sessionId: s.id }); } catch {}
  }

  async endSession() {
    try {
      await this.client.request('POST', '/api/room/end', {});
    } catch (err) {
      this.toast(err.message, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Group dubbing: everybody at the same time, each in their own take studio
  // ---------------------------------------------------------------------------

  /** The room session the take studio is working for (null in solo mode) */
  studioContext() {
    const s = this.state?.session;
    const scene = this.app.selectedScene;
    if (!this.isConnected() || !s || s.status !== 'dubbing' || !scene || this.localSceneFor(s.sceneId)?.id !== scene.id) return null;
    const myChar = this.myPick();
    if (!myChar || String(this.app.selectedCharacter).toLowerCase() !== myChar.toLowerCase()) return null;
    return {
      sessionId: s.id,
      myChar,
      submitted: !!(s.submissions || []).find(x => x.playerId === this.me.playerId),
      changedSinceSubmit: this.changedSinceSubmit === s.id
    };
  }

  onDubbingStarted(s) {
    const myChar = this.myPick();
    if (myChar) {
      SFX.playSuccess();
      this.toast(`🎙️ ¡A doblar! Graba las frases de ${myChar} una por una.`, 'success');
      this.openStudio();
    } else {
      this.toast(`🎬 Empezó el doblaje de «${s.sceneTitle}». Puedes seguir el progreso de todos.`, 'info');
      if (this.app.currentView !== 'room') this.app.navigate('room');
    }
  }

  /** Go to the take studio with the shared scene and my character */
  async openStudio() {
    const s = this.state?.session;
    const myChar = this.myPick();
    if (!s || s.status !== 'dubbing' || !myChar) return;
    const scene = this.localSceneFor(s.sceneId);
    if (!scene) {
      this.toast('Todavía estás recibiendo la escena…', 'info');
      return;
    }
    this.app.navigate('take_studio', { scene, character: myChar });
    // A new group session starts from empty takes (earlier solo takes of this scene don't count)
    if (this.studioSessionId !== s.id) {
      this.studioSessionId = s.id;
      for (const take of this.app.userTakeRecordings.values()) {
        if (take?.url) URL.revokeObjectURL(take.url);
      }
      this.app.userTakeRecordings.clear();
      this.app.currentTakeIndex = 0;
    }
    this.inRoomStudio = true;
    this.app.playbackMode = 'dubbing';
    this.app.selectedCharacter = myChar;
    this.app.render();
    await this.app.setupTakeStudio();
  }

  myLines() {
    const scene = this.localSceneFor(this.state?.session?.sceneId) || this.app.selectedScene;
    const myChar = this.myPick();
    if (!scene || !myChar) return [];
    return (scene.dialogues || []).filter(d => (d.character || '').toLowerCase() === myChar.toLowerCase());
  }

  /** Called by the take studio after a take is recorded or deleted */
  onTakesChanged() {
    const s = this.state?.session;
    if (!this.studioContext() || !s) return;
    const lines = this.myLines();
    const recorded = lines.filter(d => this.app.userTakeRecordings.has(d.id)).length;
    if ((s.submissions || []).some(x => x.playerId === this.me.playerId)) this.changedSinceSubmit = s.id;
    this.client.request('POST', '/api/room/progress', { sessionId: s.id, recorded, total: lines.length }).catch(() => {});
  }

  /** Pack my character's takes and send them to the room */
  async submitTakes() {
    const s = this.state?.session;
    const ctx = this.studioContext();
    if (!s || !ctx || this.transfer) return;
    const lines = this.myLines();
    const missing = lines.filter(d => !this.app.userTakeRecordings.has(d.id));
    if (missing.length > 0) {
      this.toast(`Te faltan ${missing.length} frase(s) por grabar.`, 'error');
      return;
    }
    this.app.stopTakePlayback();
    const files = {};
    const meta = [];
    for (const d of lines) {
      const take = this.app.userTakeRecordings.get(d.id);
      const blob = take.blob;
      const mime = blob?.type || 'audio/webm';
      const file = `takes/${d.id}`;
      files[file] = new Uint8Array(await blob.arrayBuffer());
      meta.push({
        dialogueId: d.id,
        character: d.character,
        caption: d.caption,
        timestamp: d.timestamp,
        duration: d.duration,
        audioMimeType: mime,
        peaks: Array.from(take.peaks || []),
        score: take.score || 90,
        file
      });
    }
    files['takes.json'] = new TextEncoder().encode(JSON.stringify(meta));
    const zip = await ZipEngine.createZip(files);
    this.transfer = { label: 'Enviando tus tomas a la sala…', percent: 0 };
    this.updateStudioStrip(true);
    try {
      await this.client.transfer('PUT', `/api/room/session/${encodeURIComponent(s.id)}/takes`, {
        body: zip,
        headers: { 'Content-Type': 'application/zip', 'X-Take-Count': String(meta.length) },
        onProgress: (f) => this.setTransferPercent(f)
      });
      this.transfer = null;
      if (this.changedSinceSubmit === s.id) this.changedSinceSubmit = null;
      SFX.playSuccess();
      this.toast('📤 ¡Tomas enviadas! En cuanto terminen los demás veréis el doblaje.', 'success');
      // Wait in the room screen, where everybody's progress is shown
      this.inRoomStudio = false;
      this.app.navigate('room');
    } catch (err) {
      this.transfer = null;
      SFX.playError();
      this.toast(`No se pudieron enviar tus tomas: ${err.message}`, 'error');
      this.updateStudioStrip(true);
    }
  }

  async finishNow() {
    const s = this.state?.session;
    if (!s) return;
    if (!confirm('¿Terminar ya el doblaje con las tomas enviadas? Las frases de quien no haya enviado sonarán con la voz original.')) return;
    try {
      await this.client.request('POST', '/api/room/finish-now', { sessionId: s.id });
    } catch (err) {
      this.toast(err.message, 'error');
    }
  }

  /** Who is dubbing what, and how far each one is */
  renderProgressList(s) {
    const subs = s.submissions || [];
    return Object.entries(s.picks || {}).map(([character, pick]) => {
      const prog = s.progress?.[pick.playerId];
      const sent = subs.find(x => x.playerId === pick.playerId);
      const online = (this.state.players || []).find(p => p.id === pick.playerId);
      const total = prog?.total || ((this.localSceneFor(s.sceneId)?.dialogues || [])
        .filter(d => (d.character || '').toLowerCase() === character.toLowerCase()).length);
      const recorded = sent ? total : (prog?.recorded || 0);
      const pct = total > 0 ? Math.round((recorded / total) * 100) : 0;
      return `
        <div class="mp-prog">
          <div class="mp-prog-head">
            <span>${pick.playerId === this.me.playerId ? '⭐ ' : ''}<b>${esc(pick.name)}</b> → 🎭 ${esc(character)}${online ? '' : ' <span class="mp-help">(desconectado)</span>'}</span>
            <span class="${sent ? 'mp-prog-done' : ''}">${sent ? '✅ Enviado' : `${recorded}/${total} frases`}</span>
          </div>
          <div class="mp-bar mp-bar-thin"><div class="mp-bar-fill" style="width:${sent ? 100 : pct}%"></div></div>
        </div>
      `;
    }).join('');
  }

  /** Small live panel shown inside the take studio while dubbing in a room */
  renderStudioStrip() {
    const s = this.state?.session;
    const ctx = this.studioContext();
    if (!s || !ctx) return '';
    const lines = this.myLines();
    const recorded = lines.filter(d => this.app.userTakeRecordings.has(d.id)).length;
    const allDone = recorded >= lines.length && lines.length > 0;
    let action = '';
    if (this.transfer && !this.transfer.error) {
      const pct = Math.round((this.transfer.percent || 0) * 100);
      action = `<span id="mp-transfer-label" class="mp-transfer-label">${esc(this.transfer.label)} ${pct}%</span>`;
    } else if (ctx.submitted && !ctx.changedSinceSubmit) {
      action = `<span class="mp-prog-done">✅ Tomas enviadas</span> <button class="btn-secondary mp-room-back">⬅️ Volver a la sala</button>`;
    } else if (allDone) {
      action = `<button class="btn-cyan mp-btn mp-submit-takes">📤 ${ctx.submitted ? 'Reenviar mis tomas' : 'Enviar mis tomas a la sala'}</button>`;
    } else {
      action = `<span class="mp-help">Graba tus ${lines.length} frases (puedes repetir cualquiera) y envíalas.</span>`;
    }
    return `
      <div class="mp-studio-strip">
        <div class="mp-row mp-space">
          <b>👥 Doblaje en grupo · tú doblas a ${esc(ctx.myChar)}</b>
          <div class="mp-row">${action}</div>
        </div>
        <div class="mp-prog-list">${this.renderProgressList(s)}</div>
      </div>
    `;
  }

  updateStudioStrip(force = false) {
    if (this.app.currentView !== 'take_studio') return;
    const el = document.getElementById('mp-studio-strip');
    if (!el) return;
    // Don't rebuild buttons under the user's pointer unless something relevant changed
    const html = this.renderStudioStrip();
    if (force || el.innerHTML !== html) {
      el.innerHTML = html;
      this.bindStudioStrip();
    }
  }

  bindStudioStrip() {
    document.querySelectorAll('.mp-submit-takes').forEach(b => { b.onclick = () => this.submitTakes(); });
    document.querySelectorAll('.mp-room-back').forEach(b => {
      b.onclick = () => {
        this.app.stopTakePlayback();
        this.inRoomStudio = false;
        this.app.navigate('room');
      };
    });
  }

  async collectResult(s) {
    if (this.collectingFor === s.id || this.done.has(s.id)) return;
    this.collectingFor = s.id;
    try {
      const scene = this.localSceneFor(s.sceneId);
      const subs = (s.submissions || []).filter(x => x.count > 0);
      if (!scene || subs.length === 0) {
        this.markDone(s.id);
        if (subs.length === 0) this.toast('El doblaje terminó, pero nadie envió tomas.', 'info');
        return;
      }
      const takes = [];
      for (const sub of subs) {
        this.transfer = { label: `Recibiendo las tomas de ${sub.playerName}…`, percent: 0 };
        this.refresh();
        const buf = await this.client.transfer('GET',
          `/api/room/session/${encodeURIComponent(s.id)}/takes/${encodeURIComponent(sub.playerId)}`, {
            responseType: 'arraybuffer',
            onProgress: (f) => this.setTransferPercent(f)
          });
        const files = await ZipEngine.unzip(buf);
        const meta = JSON.parse(new TextDecoder().decode(files['takes.json'] || new Uint8Array()));
        for (const t of meta) {
          const data = files[t.file];
          if (!data) continue;
          const audioData = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          takes.push({
            dialogueId: t.dialogueId,
            character: t.character,
            caption: t.caption,
            timestamp: t.timestamp,
            duration: t.duration,
            audioData,
            audioMimeType: t.audioMimeType || 'audio/webm',
            audioBlob: null,
            peaks: t.peaks || [],
            score: t.score || 90,
            playerName: sub.playerName
          });
        }
      }
      this.transfer = null;
      takes.sort((a, b) => a.timestamp - b.timestamp);

      const cast = subs.map(x => `${x.character}: ${x.playerName}`).join(' · ');
      const avg = takes.length ? Math.round(takes.reduce((a, t) => a + (t.score || 90), 0) / takes.length) : 90;
      const dub = {
        id: `room_${s.id}`,
        sceneId: scene.id,
        sceneTitle: scene.title,
        characterDubbed: cast,
        effectApplied: 'clean',
        date: new Date().toISOString(),
        score: avg * 100,
        rank: avg >= 92 ? 'S' : (avg >= 82 ? 'A' : 'B'),
        duration: scene.duration || s.sceneDuration || 60,
        takes,
        room: {
          sessionId: s.id,
          hostName: this.state?.hostName || '',
          players: subs.map(x => x.playerName)
        },
        sceneSnapshot: {
          id: scene.id,
          title: scene.title,
          duration: scene.duration,
          videoKey: scene.videoKey,
          backingTrackKey: scene.backingTrackKey,
          characters: scene.characters,
          dialogues: scene.dialogues,
          rawFiles: scene.rawFiles,
          imageFiles: scene.imageFiles,
          iconName: scene.iconName
        }
      };
      await GameDB.saveRecording(dub);
      await this.app.loadSavedDubs();
      this.markDone(s.id);
      this.inRoomStudio = false;
      SFX.playVictory?.();
      this.toast(`🎉 ¡Doblaje en grupo listo! (${cast})`, 'success');
      await this.app.openPlayDub(dub);
    } catch (err) {
      this.transfer = { error: `No se pudo recibir el doblaje: ${err.message}` };
      this.refresh();
    } finally {
      this.collectingFor = null;
    }
  }

  markDone(sessionId) {
    this.done.add(sessionId);
    lsSet(DONE_KEY, [...this.done].slice(-50));
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  navLabel() {
    if (!this.isConnected()) return '👥 Multijugador';
    const online = (this.state.players || []).filter(p => p.online).length;
    return `👥 Sala (${online})`;
  }

  /** Re-render the room screen after a state change (other screens are left alone) */
  refresh(force = false) {
    const navBtn = document.getElementById('nav-room');
    if (navBtn) navBtn.textContent = this.navLabel();
    if (this.app.currentView !== 'room') return;
    // Live updates must not wipe what the user is typing (screen changes pass force)
    const el = document.activeElement;
    const typing = el?.classList?.contains('mp-input') && !el.readOnly;
    if (typing && !force) {
      this.updateLivePlayers();
      return;
    }
    this.app.render();
  }

  updateLivePlayers() {
    const el = document.getElementById('mp-live-players');
    if (el) el.innerHTML = this.renderPlayerChips();
  }

  renderPlayerChips() {
    return (this.state?.players || []).map(p => `
      <span class="mp-chip ${p.online ? '' : 'mp-chip-off'} ${p.id === this.me?.playerId ? 'mp-chip-me' : ''}">
        <span class="mp-dot ${p.online ? 'on' : ''}"></span>
        ${p.isHost ? '👑 ' : ''}${esc(p.name)}${p.id === this.me?.playerId ? ' (tú)' : ''}
        ${p.character ? `<span class="mp-chip-role">🎭 ${esc(p.character)}</span>` : ''}
      </span>
    `).join('');
  }

  render() {
    if (!this.isConnected()) return this.renderConnect();
    const s = this.state.session;
    if (s && s.status === 'dubbing') return this.renderDubbing(s);
    if (s && s.status === 'complete') return this.renderComplete(s);
    if (s) return this.renderSetup(s);
    return this.renderLobby();
  }

  renderHeader(title, subtitle) {
    return `
      <div class="mp-header">
        <div>
          <span class="mp-tag">👥 MULTIJUGADOR • INTERNET O RED LOCAL</span>
          <h2 class="mp-title">${title}</h2>
          ${subtitle ? `<p class="mp-subtitle">${subtitle}</p>` : ''}
        </div>
      </div>
    `;
  }

  renderTransfer() {
    if (!this.transfer) return '';
    if (this.transfer.error) {
      return `<div class="mp-card mp-error">⚠️ ${esc(this.transfer.error)}</div>`;
    }
    const pct = Math.round((this.transfer.percent || 0) * 100);
    return `
      <div class="mp-card mp-transfer">
        <div id="mp-transfer-label" class="mp-transfer-label">${esc(this.transfer.label)} ${pct}%</div>
        <div class="mp-bar"><div id="mp-transfer-bar" class="mp-bar-fill" style="width:${pct}%"></div></div>
      </div>
    `;
  }

  renderConnect() {
    const name = this.name;
    // Link mode only ever asks for the name, then joins
    const askName = !name || this.editingName || this.linkMode;
    const errorBox = this.error ? `<div class="mp-card mp-error">⚠️ ${esc(this.error)}</div>` : '';

    if (askName) {
      return `
        <div class="mp-wrap">
          ${this.renderHeader('¿Cómo te llamas?', this.linkMode
            ? 'Te invitaron a una sala de doblaje. Escribe tu nombre y entras directamente.'
            : 'Primero elige tu nombre de usuario. Así te verán los demás en la sala.')}
          ${errorBox}
          <div class="mp-card">
            <label class="mp-label" for="mp-name">👤 Nombre de usuario</label>
            <div class="mp-row">
              <input id="mp-name" class="mp-input" maxlength="24" placeholder="Ej: Ana, DobladorPro…" value="${esc(name)}" autocomplete="nickname" />
              <button id="mp-name-ok" class="btn-cyan mp-btn" ${this.connecting ? 'disabled' : ''}>${this.connecting ? '⏳ Entrando…' : (this.linkMode ? '🚀 Entrar a la sala' : 'Continuar ➡️')}</button>
            </div>
          </div>
        </div>
      `;
    }

    if (this.linkMode) {
      return `
        <div class="mp-wrap">
          ${this.renderHeader(`Hola, ${esc(name)} 👋`, this.connecting ? 'Entrando a la sala…' : 'Pulsa para entrar a la sala.')}
          ${errorBox}
          <div class="mp-card mp-row">
            <button id="mp-join-link" class="btn-cyan mp-btn" ${this.connecting ? 'disabled' : ''}>🚀 Entrar a la sala</button>
            <button id="mp-edit-name" class="btn-secondary">✏️ Cambiar nombre</button>
          </div>
        </div>
      `;
    }

    const lastIp = lsGet(LAST_IP_KEY, '');
    return `
      <div class="mp-wrap">
        ${this.renderHeader(`Hola, ${esc(name)} 👋`, 'Juega con tus amigos usando tu propio ordenador como servidor: sin pagar servidores.')}
        <div class="mp-row" style="margin-bottom:1rem;"><button id="mp-edit-name" class="btn-secondary">✏️ Cambiar nombre</button></div>
        ${errorBox}
        <div class="mp-grid">
          ${this.canHost ? `
            <div class="mp-card">
              <h3 class="mp-card-title">🏠 Crear sala</h3>
              <p class="mp-help">Tu ordenador será el anfitrión. Te daremos un <b>enlace</b>, un <b>código</b> para jugar por internet y tu <b>IP</b> para la misma red.</p>
              <button id="mp-create" class="btn-cyan mp-btn" ${this.connecting ? 'disabled' : ''}>${this.connecting ? '⏳ Creando…' : '🏠 Crear sala'}</button>
            </div>
          ` : ''}
          <div class="mp-card">
            <h3 class="mp-card-title">🔌 Unirse con código o IP</h3>
            <p class="mp-help">Por internet: escribe el <b>código</b> que ve el anfitrión (ej: brave-apple-salmon-kit). En la misma red también vale su <b>IP</b> (ej: 192.168.1.25).</p>
            <div class="mp-row">
              <input id="mp-ip" class="mp-input" placeholder="código o 192.168.1.25" value="${esc(lastIp)}" autocapitalize="off" autocorrect="off" spellcheck="false" />
              <button id="mp-join-ip" class="btn-cyan mp-btn" ${this.connecting ? 'disabled' : ''}>${this.connecting ? '⏳' : 'Unirse'}</button>
            </div>
          </div>
        </div>
        <div class="mp-card mp-tips">
          <b>💡 Cómo funciona</b>
          <ul>
            <li>Por <b>internet</b>: el anfitrión pulsa <b>«Activar juego por internet»</b> y comparte el enlace o el código. Es gratis: usa un túnel de Cloudflare que no necesita cuenta ni tarjeta.</li>
            <li>En la <b>misma red Wi-Fi</b> también podéis uniros con la IP del anfitrión.</li>
            <li>Si la escena solo la tiene una persona, se envía sola a los demás al elegirla.</li>
          </ul>
        </div>
      </div>
    `;
  }

  renderInternetBox(info) {
    const t = info.tunnel || { state: 'off' };
    let body = '';
    if (t.state === 'online' && t.url) {
      body = `
        <div class="mp-label">🔗 Enlace (solo piden su nombre y entran, desde cualquier sitio)</div>
        <div class="mp-row">
          <input class="mp-input mp-mono" readonly value="${esc(t.url)}/" id="mp-link-online" />
          <button class="btn-secondary mp-copy" data-copy="${esc(t.url)}/">📋 Copiar</button>
        </div>
        <div class="mp-label" style="margin-top:0.75rem;">🔑 Código de sala (para quien tenga el juego instalado)</div>
        <div class="mp-row">
          <span class="mp-ip mp-code">${esc(t.code)}</span>
          <button class="btn-secondary mp-copy" data-copy="${esc(t.code)}">📋 Copiar</button>
        </div>
        <p class="mp-help">Funciona mientras la sala esté abierta. Si cierras la sala o el juego, la próxima vez tendrás un enlace y código nuevos.</p>
        <button id="mp-tunnel-stop" class="btn-secondary">⏹️ Desactivar juego por internet</button>`;
    } else if (t.state === 'installing') {
      const pct = Math.round((t.progress || 0) * 100);
      body = `
        <p class="mp-help">📥 Descargando el túnel gratuito de Cloudflare (solo la primera vez)… ${pct}%</p>
        <div class="mp-bar"><div class="mp-bar-fill" style="width:${pct}%"></div></div>`;
    } else if (t.state === 'starting') {
      body = `<p class="mp-help">⏳ Conectando con internet… (unos segundos)</p><div class="mp-spinner"></div>`;
    } else {
      body = `
        ${t.state === 'error' ? `<p class="mp-help mp-error-text">⚠️ ${esc(t.error)}</p>` : ''}
        <p class="mp-help">Crea un enlace público para que tus amigos entren desde su casa. <b>Es gratis</b>: usa un túnel de Cloudflare que no necesita cuenta ni tarjeta, así que no te pueden cobrar. La primera vez se descarga un pequeño programa (~40 MB).</p>
        <button id="mp-tunnel-start" class="btn-cyan mp-btn">${t.state === 'error' ? '🔄 Reintentar' : '🌍 Activar juego por internet'}</button>`;
    }
    return `
      <div class="mp-card mp-share mp-online">
        <h3 class="mp-card-title">🌍 Jugar por internet</h3>
        ${body}
      </div>
    `;
  }

  async setTunnel(on) {
    try {
      const res = await fetch(`/api/room/host/tunnel/${on ? 'start' : 'stop'}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo cambiar el modo internet');
      this.hostInfo = data;
      SFX.playClick();
    } catch (err) {
      SFX.playError();
      this.toast(err.message, 'error');
    }
    this.refresh();
    this.watchTunnel();
  }

  /** Follow the tunnel while it installs / connects, and notice if it drops */
  watchTunnel() {
    clearTimeout(this.tunnelTimer);
    this.tunnelTimer = null;
    if (!this.isConnected() || !this.isHostPlayer() || !this.canHost) return;
    const st = this.hostInfo?.tunnel?.state;
    const delay = (st === 'installing' || st === 'starting') ? 800 : 5000;
    this.tunnelTimer = setTimeout(async () => {
      try {
        const info = await fetch('/api/room/host/status', { cache: 'no-store' }).then(r => r.json());
        const before = this.hostInfo?.tunnel?.state;
        this.hostInfo = info;
        const after = info.tunnel?.state;
        if (before !== after || after === 'installing') {
          if (after === 'online' && before !== 'online') {
            SFX.playSuccess();
            this.toast('🌍 ¡Sala online! Comparte el enlace o el código.', 'success');
          }
          if (after === 'installing') this.updateTunnelProgress(info.tunnel.progress);
          else this.refresh();
        }
      } catch {}
      this.watchTunnel();
    }, delay);
  }

  updateTunnelProgress(progress) {
    const box = document.querySelector('.mp-online');
    const bar = box?.querySelector('.mp-bar-fill');
    const txt = box?.querySelector('.mp-help');
    const pct = Math.round((progress || 0) * 100);
    if (bar) bar.style.width = `${pct}%`;
    if (txt) txt.textContent = `📥 Descargando el túnel gratuito de Cloudflare (solo la primera vez)… ${pct}%`;
    if (!bar) this.refresh();
  }

  renderShareBox() {
    if (!this.isHostPlayer()) return '';
    const info = this.hostInfo;
    if (!info) return `<div class="mp-card">⏳ Cargando los datos para invitar…</div>`;
    const links = info.links || [];
    const internet = this.renderInternetBox(info);
    if (links.length === 0) {
      return `${internet}<div class="mp-card mp-error">⚠️ Este ordenador no está conectado a ninguna red local.</div>`;
    }
    const main = links[0];
    return `
      ${internet}
      <div class="mp-card mp-share">
        <h3 class="mp-card-title">🏠 Invitar en la misma red Wi-Fi</h3>
        ${main.secure ? `
          <div class="mp-label">🔗 Enlace (solo piden su nombre y entran)</div>
          <div class="mp-row">
            <input class="mp-input mp-mono" readonly value="${esc(main.secure)}" id="mp-link-secure" />
            <button class="btn-secondary mp-copy" data-copy="${esc(main.secure)}">📋 Copiar</button>
          </div>
          <p class="mp-help">Al abrirlo, el navegador avisará <i>"La conexión no es privada"</i> (el certificado lo crea tu ordenador). Pulsad <b>Configuración avanzada → Continuar</b>. Es necesario para poder usar el micrófono.</p>
        ` : `
          <div class="mp-label">🔗 Enlace</div>
          <div class="mp-row">
            <input class="mp-input mp-mono" readonly value="${esc(main.plain)}" />
            <button class="btn-secondary mp-copy" data-copy="${esc(main.plain)}">📋 Copiar</button>
          </div>
          <p class="mp-help">⚠️ No se pudo activar HTTPS (${esc(info.httpsError || 'sin OpenSSL')}): con este enlace tus amigos pueden ver y recibir el doblaje, pero para grabar tienen que instalar el juego y unirse por IP.</p>
        `}
        <div class="mp-label" style="margin-top:0.75rem;">🔌 Unirse por IP (con el juego instalado)</div>
        <div class="mp-ip-list">${links.map(l => `<span class="mp-ip">${esc(l.ip)}</span>`).join('')}</div>
      </div>
    `;
  }

  renderLobby() {
    const st = this.state;
    const roomScenes = st.scenes || [];
    const cards = [
      ...this.app.scenes.map(s => ({ id: s.id, title: s.title, characters: this.app.getDubbableCharacters(s), cover: this.app.getSceneCoverUrl(s), local: true, inRoom: this.sceneInRoom(s), by: s.sharedBy })),
      ...roomScenes.filter(r => !this.localSceneFor(r.id)).map(r => ({ id: r.id, title: r.title, characters: r.characters || [], cover: '', local: false, inRoom: true, by: r.uploadedBy, receiving: !!this.downloadJobs?.has(r.id) }))
    ];
    const autoShare = this.autoShareEnabled();
    return `
      <div class="mp-wrap">
        ${this.renderHeader(`Sala de ${esc(st.hostName)}`, 'Cualquiera puede elegir una escena: entraréis todos a la vez y cada uno dobla su personaje al mismo tiempo.')}
        <div class="mp-card">
          <div class="mp-row mp-space">
            <div id="mp-live-players" class="mp-players">${this.renderPlayerChips()}</div>
            ${this.isHostPlayer()
              ? '<button id="mp-close-room" class="btn-secondary">🔒 Cerrar sala</button>'
              : '<button id="mp-leave" class="btn-secondary">🚪 Salir de la sala</button>'}
          </div>
        </div>
        ${this.renderShareBox()}
        <div class="mp-card mp-row mp-space">
          <label class="mp-toggle">
            <input type="checkbox" id="mp-autoshare" ${autoShare ? 'checked' : ''} />
            <span>🔄 <b>Descarga compartida</b>: lo que descargue cualquiera llega a todos</span>
          </label>
          <span class="mp-help">${autoShare ? 'Tus escenas se comparten con la sala y recibes las de los demás.' : 'Solo recibes las escenas de los demás; las tuyas no se comparten.'}</span>
        </div>
        ${this.renderTransfer()}
        <h3 class="mp-section">🎬 Elige una escena para todos</h3>
        ${cards.length === 0 ? `
          <div class="mp-card">No tienes escenas todavía. Descarga una en <b>Escenas Online</b> o importa un ZIP: al elegirla se enviará a todos.</div>
        ` : `
          <div class="mp-scene-grid">
            ${cards.map(c => `
              <div class="mp-scene">
                ${c.cover ? `<img src="${esc(c.cover)}" class="mp-scene-img" alt="" />` : '<div class="mp-scene-img mp-scene-ph">🎬</div>'}
                <div class="mp-scene-body">
                  <div class="mp-scene-title">${esc(c.title)}</div>
                  <div class="mp-scene-meta">${c.characters.map(ch => esc(ch)).join(' • ') || '—'}</div>
                  <div class="mp-scene-meta">${c.local
                    ? (c.inRoom ? `✅ En tu biblioteca y en la sala${c.by ? ` (de ${esc(c.by)})` : ''}` : '📚 Solo en tu biblioteca')
                    : (c.receiving ? `📥 Recibiendo… (de ${esc(c.by || 'la sala')})` : `👥 Compartida por ${esc(c.by || 'la sala')}`)}</div>
                  <button class="btn-cyan mp-btn mp-pick-scene" data-scene-id="${esc(c.id)}">🎬 Elegir para todos</button>
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    `;
  }

  renderSetup(s) {
    const scene = this.localSceneFor(s.sceneId);
    const players = this.state.players || [];
    const online = players.filter(p => p.online);
    const notReady = online.filter(p => !s.ready.includes(p.id));
    const pickCount = Object.keys(s.picks).length;
    const myPick = this.myPick();
    let reason = '';
    if (!scene) reason = 'Recibiendo la escena…';
    else if (pickCount === 0) reason = 'Elegid al menos un personaje';
    else if (notReady.length) reason = `Esperando a ${notReady.map(p => p.name).join(', ')}…`;

    return `
      <div class="mp-wrap">
        ${this.renderHeader(`🎬 ${esc(s.sceneTitle)}`, `Elegida por ${esc(s.chosenBy)}. Cada uno elige su personaje y empezáis todos a la vez.`)}
        <div class="mp-card">
          <div class="mp-row mp-space">
            <div id="mp-live-players" class="mp-players">${this.renderPlayerChips()}</div>
            <button id="mp-change-scene" class="btn-secondary">🔄 Cambiar escena</button>
          </div>
        </div>
        ${this.renderTransfer()}
        ${s.cancelledBy ? `<div class="mp-card mp-note">⏹️ ${esc(s.cancelledBy)} canceló el doblaje. ¡Podéis volver a empezar cuando queráis!</div>` : ''}
        <h3 class="mp-section">🎭 Elige tu personaje</h3>
        <div class="mp-char-grid">
          ${s.characters.map(c => {
            const pick = s.picks[c];
            const mine = pick && pick.playerId === this.me.playerId;
            const taken = pick && !mine;
            const img = scene ? this.app.getCharacterImageUrl(scene, c) : '';
            const lines = scene ? (scene.dialogues || []).filter(d => (d.character || '').toLowerCase() === c.toLowerCase()).length : 0;
            return `
              <button class="mp-char ${mine ? 'mp-char-mine' : ''} ${taken ? 'mp-char-taken' : ''}" data-char="${esc(c)}" ${taken || !scene ? 'disabled' : ''}>
                ${img ? `<img src="${esc(img)}" class="mp-char-img" alt="" />` : '<div class="mp-char-img mp-scene-ph">🎭</div>'}
                <div class="mp-char-name">${esc(c)}</div>
                <div class="mp-char-meta">${lines} frases</div>
                <div class="mp-char-who">${mine ? '✅ Tú' : (taken ? `🎙️ ${esc(pick.name)}` : (myPick ? 'Voz original' : '👆 Elegir'))}</div>
              </button>
            `;
          }).join('')}
        </div>
        <p class="mp-help">Los personajes que nadie elija sonarán con su voz original. Usad auriculares para que el micrófono no capte el sonido de la escena.</p>
        <div class="mp-row mp-center">
          <button id="mp-start" class="btn-cyan mp-btn mp-big" ${reason ? 'disabled' : ''}>▶️ ¡Empezar a doblar juntos!</button>
        </div>
        ${reason ? `<p class="mp-help mp-center">${esc(reason)}</p>` : ''}
      </div>
    `;
  }

  renderDubbing(s) {
    const myChar = this.myPick();
    const mine = (s.submissions || []).find(x => x.playerId === this.me.playerId);
    const subsCount = (s.submissions || []).length;
    let main = '';
    if (myChar && !mine) {
      main = `
        <div class="mp-card mp-center">
          <p style="font-size:1.1rem;">🎙️ Tú doblas a <b>${esc(myChar)}</b>. Graba tus frases una por una y envíalas.</p>
          <button id="mp-open-studio" class="btn-cyan mp-btn mp-big">🎙️ Ir a mi estudio de grabación</button>
        </div>`;
    } else if (myChar && mine) {
      main = `
        <div class="mp-card mp-center">
          <p style="font-size:1.1rem;">✅ Enviaste tus ${mine.count} tomas de <b>${esc(myChar)}</b>. Esperando a los demás…</p>
          <button id="mp-open-studio" class="btn-secondary mp-btn">✏️ Cambiar alguna toma</button>
        </div>`;
    } else {
      main = `<div class="mp-card mp-center"><p>👀 No elegiste personaje: verás el doblaje cuando terminen los demás.</p></div>`;
    }
    return `
      <div class="mp-wrap">
        ${this.renderHeader(`🎙️ Doblando «${esc(s.sceneTitle)}»`, 'Cada uno graba las frases de su personaje a su ritmo, todos a la vez. Al terminar se juntan todas las voces.')}
        ${this.renderTransfer()}
        ${main}
        <div class="mp-card">
          <h3 class="mp-card-title">📊 Progreso de todos</h3>
          <div class="mp-prog-list">${this.renderProgressList(s)}</div>
        </div>
        <div class="mp-row mp-space">
          <div id="mp-live-players" class="mp-players">${this.renderPlayerChips()}</div>
          <div class="mp-row">
            ${this.isHostPlayer() && subsCount > 0 ? '<button id="mp-finish-now" class="btn-secondary">⏭️ Terminar sin esperar</button>' : ''}
            <button id="mp-cancel" class="btn-secondary">⏹️ Cancelar para todos</button>
          </div>
        </div>
      </div>
    `;
  }

  renderComplete(s) {
    const voices = (s.submissions || []).filter(t => t.count > 0);
    const dubId = `room_${s.id}`;
    const dub = this.app.savedDubs.find(d => d.id === dubId);
    const hasDub = !!dub;
    const missing = dub ? this.app.getMissingCharacters(dub) : [];
    return `
      <div class="mp-wrap">
        ${this.renderHeader('🎉 ¡Doblaje en grupo terminado!', `«${esc(s.sceneTitle)}»`)}
        ${this.renderTransfer()}
        <div class="mp-card">
          <div class="mp-players">${voices.map(t => `<span class="mp-chip">🎙️ ${esc(t.playerName)} <span class="mp-chip-role">🎭 ${esc(t.character)}</span></span>`).join('') || 'Nadie grabó voz.'}</div>
          ${missing.length ? `<p class="mp-help">🗣️ Con voz original: <b>${missing.map(esc).join(', ')}</b>. Cada uno puede completarlos por su lado en su propia copia.</p>` : ''}
        </div>
        <div class="mp-row mp-center">
          ${hasDub ? `<button id="mp-watch" class="btn-cyan mp-btn mp-big" data-dub-id="${esc(dubId)}">▶️ Ver el doblaje</button>` : (this.collectingFor ? '<span>⏳ Recibiendo el doblaje…</span>' : '')}
          ${missing.length ? `<button id="mp-complete-missing" class="btn-cyan mp-btn" data-dub-id="${esc(dubId)}" style="background: linear-gradient(135deg, var(--neon-green), #00a852); color:#000;">🎙️ Completar las voces que faltan (${missing.length})</button>` : ''}
          <button id="mp-again" class="btn-secondary mp-btn">🔁 Repetir esta escena</button>
          <button id="mp-change-scene" class="btn-secondary mp-btn">🎬 Elegir otra escena</button>
        </div>
      </div>
    `;
  }

  bind() {
    const $ = (id) => document.getElementById(id);

    const nameInput = $('mp-name');
    if (nameInput) {
      const submit = async () => {
        const v = nameInput.value.replace(/[<>]/g, '').trim().slice(0, 24);
        if (!v) {
          nameInput.focus();
          this.toast('Escribe un nombre de usuario.', 'error');
          return;
        }
        lsSet(NAME_KEY, v);
        this.editingName = false;
        nameInput.blur();
        SFX.playClick();
        if (this.linkMode) {
          await this.join('', v);
        } else {
          this.refresh(true);
        }
      };
      $('mp-name-ok').onclick = submit;
      nameInput.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      if (!this.connecting) setTimeout(() => nameInput.focus(), 50);
    }

    if ($('mp-edit-name')) $('mp-edit-name').onclick = () => { this.editingName = true; this.refresh(true); };
    if ($('mp-join-link')) $('mp-join-link').onclick = () => this.join('', this.name);
    if ($('mp-create')) $('mp-create').onclick = () => this.createRoom();

    const ipInput = $('mp-ip');
    if (ipInput) {
      const go = () => {
        const base = this.baseFromInput(ipInput.value);
        if (!base) {
          this.toast('Escribe el código de la sala (ej: brave-apple-salmon-kit) o una IP (ej: 192.168.1.25)', 'error');
          return;
        }
        lsSet(LAST_IP_KEY, ipInput.value.trim());
        this.join(base, this.name);
      };
      $('mp-join-ip').onclick = go;
      ipInput.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    }

    if ($('mp-close-room')) {
      $('mp-close-room').onclick = () => {
        if (confirm('¿Cerrar la sala? Todos los invitados saldrán.')) this.closeRoom();
      };
    }
    if ($('mp-leave')) $('mp-leave').onclick = () => this.leave();

    document.querySelectorAll('.mp-copy').forEach(btn => {
      btn.onclick = async () => {
        const text = btn.dataset.copy;
        try {
          await navigator.clipboard.writeText(text);
          this.toast('📋 Enlace copiado. ¡Envíalo a tus amigos!', 'success');
        } catch {
          const input = btn.parentElement.querySelector('input');
          if (input) { input.select(); document.execCommand?.('copy'); }
          this.toast('Selecciona el enlace y cópialo.', 'info');
        }
      };
    });

    document.querySelectorAll('.mp-pick-scene').forEach(btn => {
      btn.onclick = () => this.selectScene(btn.dataset.sceneId);
    });
    document.querySelectorAll('.mp-char').forEach(btn => {
      btn.onclick = () => this.pickCharacter(btn.dataset.char);
    });
    if ($('mp-start')) $('mp-start').onclick = () => this.startGroup();
    if ($('mp-cancel')) {
      $('mp-cancel').onclick = () => {
        if (confirm('¿Cancelar el doblaje para todos? Se perderán las tomas de esta ronda.')) this.cancelGroup();
      };
    }
    if ($('mp-open-studio')) $('mp-open-studio').onclick = () => this.openStudio();
    if ($('mp-finish-now')) $('mp-finish-now').onclick = () => this.finishNow();
    if ($('mp-change-scene')) $('mp-change-scene').onclick = () => this.endSession();
    if ($('mp-again')) {
      $('mp-again').onclick = () => {
        const s = this.state?.session;
        if (s) this.selectScene(s.sceneId);
      };
    }
    if ($('mp-complete-missing')) {
      $('mp-complete-missing').onclick = () => {
        const dub = this.app.savedDubs.find(d => d.id === $('mp-complete-missing').dataset.dubId);
        if (dub) this.app.completeMissingVoices(dub);
      };
    }
    if ($('mp-watch')) {
      $('mp-watch').onclick = () => {
        const dub = this.app.savedDubs.find(d => d.id === $('mp-watch').dataset.dubId);
        if (dub) this.app.openPlayDub(dub);
      };
    }

    if ($('mp-autoshare')) $('mp-autoshare').onchange = (e) => this.setAutoShare(e.target.checked);
    if ($('mp-tunnel-start')) $('mp-tunnel-start').onclick = () => this.setTunnel(true);
    if ($('mp-tunnel-stop')) $('mp-tunnel-stop').onclick = () => this.setTunnel(false);

    // The host needs the addresses to invite people
    if (this.isConnected() && this.isHostPlayer() && this.canHost && !this.tunnelTimer) {
      if (!this.hostInfo) {
        fetch('/api/room/host/status', { cache: 'no-store' })
          .then(r => r.json())
          .then(info => {
            this.hostInfo = info;
            this.refresh();
          })
          .catch(() => {});
      }
      this.watchTunnel();
    }
  }
}
