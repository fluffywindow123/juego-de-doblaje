/**
 * Voice Dub Hero - Free internet access for the multiplayer room
 *
 * Uses a Cloudflare "Quick Tunnel" (trycloudflare.com): no account, no e-mail and no
 * payment method, so it can never generate a bill. It gives the room a public
 * https://<words>.trycloudflare.com address with a valid certificate (so browsers allow
 * the microphone). The <words> part works as the room code.
 *
 * Only the host needs the small `cloudflared` program. If it isn't installed, it is
 * downloaded once from Cloudflare's official GitHub releases into ./tools/.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { spawn, spawnSync } from 'child_process';

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const URL_RE = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/i;
const START_TIMEOUT_MS = 60000;

function releaseAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : (process.arch === 'x64' ? 'amd64' : null);
  if (!arch) return null;
  if (process.platform === 'darwin') return { file: `cloudflared-darwin-${arch}.tgz`, archive: 'tgz' };
  if (process.platform === 'linux') return { file: `cloudflared-linux-${arch}`, archive: null };
  if (process.platform === 'win32') return { file: `cloudflared-windows-${arch}.exe`, archive: null };
  return null;
}

function download(url, dest, onProgress, redirects = 8) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) {
      reject(new Error('Demasiadas redirecciones al descargar el túnel'));
      return;
    }
    const req = https.get(url, { headers: { 'User-Agent': 'VoiceDubHero' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`La descarga respondió con el código ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        received += c.length;
        if (total > 0) onProgress(received / total);
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('La descarga del túnel tardó demasiado')));
  });
}

export class TunnelManager {
  constructor({ toolsDir }) {
    this.toolsDir = toolsDir;
    this.proc = null;
    this.state = 'off'; // off | installing | starting | online | error
    this.url = null;
    this.code = null;
    this.error = '';
    this.progress = 0;
    this.port = null;
    this.wanted = false;
    this.onChange = null;
  }

  localBinary() {
    return path.join(this.toolsDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  }

  works(bin) {
    try {
      const r = spawnSync(bin, ['--version'], { timeout: 15000, encoding: 'utf8' });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  findBinary() {
    const candidates = [
      this.localBinary(),
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared',
      'cloudflared'
    ];
    for (const bin of candidates) {
      if (bin !== 'cloudflared' && !fs.existsSync(bin)) continue;
      if (this.works(bin)) return bin;
    }
    return null;
  }

  status() {
    return {
      state: this.state,
      url: this.url,
      code: this.code,
      error: this.error,
      progress: this.progress
    };
  }

  setState(state, extra = {}) {
    Object.assign(this, { state }, extra);
    this.onChange?.();
  }

  async install() {
    const asset = releaseAsset();
    if (!asset) {
      throw new Error('Este sistema no es compatible con la descarga automática. Instala "cloudflared" manualmente.');
    }
    fs.mkdirSync(this.toolsDir, { recursive: true });
    const tmp = path.join(this.toolsDir, `${asset.file}.download`);
    this.setState('installing', { progress: 0, error: '' });
    try {
      await download(RELEASE_BASE + asset.file, tmp, (f) => { this.progress = f; });
      const bin = this.localBinary();
      if (asset.archive === 'tgz') {
        const r = spawnSync('tar', ['-xzf', tmp, '-C', this.toolsDir], { timeout: 60000 });
        if (r.status !== 0) throw new Error('No se pudo descomprimir el túnel');
      } else {
        fs.renameSync(tmp, bin);
      }
      try { fs.unlinkSync(tmp); } catch {}
      if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
      if (!this.works(bin)) throw new Error('El programa del túnel descargado no funciona en este ordenador');
      return bin;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  /** Start (installing first if needed). Resolves when the request is accepted, not when online. */
  start(port) {
    this.wanted = true;
    this.port = port;
    if (this.state === 'installing' || this.state === 'starting' || this.state === 'online') return this.status();
    this.run().catch((err) => {
      this.setState('error', { error: err.message || String(err) });
    });
    return this.status();
  }

  async run() {
    let bin = this.findBinary();
    if (!bin) bin = await this.install();
    if (!this.wanted) {
      this.setState('off');
      return;
    }
    this.setState('starting', { url: null, code: null, error: '', progress: 1 });

    const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.proc = proc;
    let lastLines = [];

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const timer = setTimeout(() => {
        if (this.proc === proc && this.state !== 'online') {
          this.setState('error', { error: 'Cloudflare no respondió a tiempo. Comprueba tu conexión a internet e inténtalo de nuevo.' });
          this.killProc();
        }
        done();
      }, START_TIMEOUT_MS);

      const onData = (chunk) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) lastLines = [...lastLines.slice(-6), line.trim()];
        }
        const m = URL_RE.exec(text);
        if (m && !this.url && this.proc === proc) {
          this.url = `https://${m[1].toLowerCase()}.trycloudflare.com`;
          this.code = m[1].toLowerCase();
        }
        if (this.url && this.state !== 'online' && /Registered tunnel connection|Connection [a-f0-9-]+ registered/i.test(text)) {
          clearTimeout(timer);
          this.setState('online');
          console.log(`[Sala] 🌍 Online en ${this.url}`);
          done();
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (err) => {
        clearTimeout(timer);
        if (this.proc === proc) this.setState('error', { error: `No se pudo abrir el túnel: ${err.message}` });
        done();
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (this.proc !== proc) return done();
        this.proc = null;
        if (this.wanted) {
          const detail = lastLines.find(l => /ERR|error|failed/i.test(l)) || `código ${code}`;
          this.setState('error', { url: null, code: null, error: `El túnel se cerró (${detail}). Pulsa reintentar.` });
        } else {
          this.setState('off', { url: null, code: null });
        }
        done();
      });
    });
  }

  killProc() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch {}
    }
  }

  stop() {
    this.wanted = false;
    this.killProc();
    if (this.state !== 'installing') this.setState('off', { url: null, code: null, error: '' });
    return this.status();
  }
}
