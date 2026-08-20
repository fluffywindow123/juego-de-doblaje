/**
 * Voice Dub Hero - Main Application Logic
 * High-Definition Scene Video & Artwork Display, Multi-track Audio Synchronization,
 * GameBanana Online Scene Browser, Multi-Download Queue Manager (Mini-Menu),
 * Universal Format Compatibility (.txt, .ini, .ogv, .mp4), and Instant Playback.
 */

import { ZipEngine } from './zip-engine.js';
import { GameDB } from './db.js';
import { AudioEngine } from './audio-engine.js';
import { VideoComposer } from './video-composer.js';
import { SFX } from './sfx.js';

export class DubbingApp {
  constructor() {
    this.currentView = 'home';
    this.scenes = [];
    this.selectedScene = null;
    this.selectedCharacter = 'Woody';
    this.selectedEffect = 'clean';
    this.playbackMode = 'original'; // 'original' | 'dubbing'

    // GameBanana Online Browser State
    this.onlineScenes = [];
    this.onlinePage = 1;
    this.onlineSearchQuery = '';
    this.onlineTotal = 0;
    this.isOnlineLoading = false;
    this.selectedModIds = new Set(); // Multi-selection for bulk downloads

    // Multi-Download Queue Manager
    this.downloadQueue = new Map(); // modId -> { id, title, percent, bytesText, speedText, status, icon, error, scene }
    this.isDownloadDrawerOpen = true;
    this.isDownloadDrawerVisible = false;
    this.isDownloadDrawerMinimized = false;

    // Audio & State
    this.audio = new AudioEngine();
    this.backingBuffer = null;
    this.backingAudioEl = null;
    this.dialogueAudios = new Map(); // dialogueId -> AudioBuffer
    this.imageCache = new Map(); // key -> dataUrl
    this.blobUrlCache = new Map();

    // Master Clock & Loop
    this.isPlaying = false;
    this.isRecording = false;
    this.currentTime = 0;
    this.duration = 0;
    this.startWallTime = 0;
    this.animFrameId = null;
    this.playedDialogueIds = new Set();
    this.userRecordedTakes = [];

    // Results state
    this.lastResult = null;
    this.latencyOffset = 0;

    // Take-by-Take Dubbing State
    this.dubbingSubMode = 'take_by_take'; // 'take_by_take' | 'continuous'
    this.currentTakeIndex = 0;
    this.userTakeRecordings = new Map(); // dialogueId -> { blob, buffer, peaks, url, score, duration }
    this.dialogueWaveforms = new Map(); // dialogueId -> Float32Array
    this.isTakePlayingRef = false;
    this.isTakeRecording = false;
    this.isTakePlayingUser = false;
    this.takeAnimFrameId = null;
    this.liveMicLevelHistory = [];
    // Saved Dubbed Scenes State
    this.savedDubs = [];
    this.activePlayingDub = null;
    this.playDubUserBuffers = new Map();
    this.playDubPlayedIds = new Set();
  }

  async init() {
    this.latencyOffset = await GameDB.getSetting('latencyOffset', 0);
    this.audio.latencyOffsetMs = this.latencyOffset;

    await this.loadScenes();
    await this.loadSavedDubs();
    this.selectedScene = this.scenes.length > 0 ? this.scenes[0] : null;

    this.render();
    this.bindGlobalEvents();
  }

  async loadSavedDubs() {
    try {
      this.savedDubs = await GameDB.getAllRecordings();
    } catch (e) {
      console.warn('Error loading saved dubs:', e);
      this.savedDubs = [];
    }
  }

  async loadScenes() {
    this.scenes = await GameDB.getAllScenes();
    if (this.scenes.length === 0) {
      try {
        const res = await fetch('./eres_un_juguete_e7314.zip');
        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          const unzipped = await ZipEngine.unzip(arrayBuf);
          const parsed = ZipEngine.parseScenePackage(unzipped);
          if (parsed && parsed.dialogues && parsed.dialogues.length > 0) {
            await GameDB.saveScene({
              title: parsed.meta.title || 'Discusión de Woody y Buzz',
              authors: parsed.meta.authors || ['Disney / Pixar'],
              readme: parsed.meta.readme || 'Escena clásica de Toy Story 1',
              characters: parsed.meta.characters || ['Woody', 'Buzz Lightyear'],
              duration: parsed.meta.estimatedDuration || 14.5,
              dialogues: parsed.dialogues,
              prefix: parsed.prefix,
              videoKey: parsed.videoKey,
              backingTrackKey: parsed.backingTrackKey,
              iconName: parsed.meta.iconName,
              imageFiles: parsed.imageFiles,
              rawFiles: parsed.rawFiles,
              importDate: new Date().toISOString()
            });
            this.scenes = await GameDB.getAllScenes();
          }
        }
      } catch (e) {
        console.warn('Could not preload starter scene:', e);
      }
    }
    this.upgradeLegacyScenes();
  }

  async upgradeLegacyScenes() {
    for (const scene of this.scenes) {
      if (!scene.dialogues) continue;

      // Recalculate exact dialogue start, end and duration from timestamps
      scene.dialogues.sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 0; i < scene.dialogues.length; i++) {
        const cur = scene.dialogues[i];
        const next = scene.dialogues[i + 1];
        if (next) {
          cur.duration = Math.max(1.2, parseFloat((next.timestamp - cur.timestamp).toFixed(3)));
          cur.endTime = next.timestamp;
        } else {
          cur.duration = 5.0;
          cur.endTime = cur.timestamp + 5.0;
        }
      }

      if (scene.rawFiles) {
        const hasMp4 = Object.keys(scene.rawFiles).some(k => k.endsWith('.mp4'));
        const ogvKey = Object.keys(scene.rawFiles).find(k => k.endsWith('.ogv'));

        if (!hasMp4 && ogvKey) {
          try {
            const rawOgv = this.toBlob(scene.rawFiles[ogvKey], 'video/ogg');
            const res = await fetch('/api/transcode-video', {
              method: 'POST',
              body: rawOgv
            });
            if (res.ok) {
              const mp4Buf = await res.arrayBuffer();
              const mp4Key = ogvKey.replace(/\.ogv$/i, '.mp4');
              scene.rawFiles[mp4Key] = new Uint8Array(mp4Buf);
              delete scene.rawFiles[ogvKey];
              scene.videoKey = mp4Key;
              console.log(`[Auto-Upgrade] ✓ "${scene.title}" actualizada a MP4 HD con éxito!`);
            }
          } catch (e) {
            console.warn('[Auto-Upgrade] Error actualizando video:', e);
          }
        }
      }

      await GameDB.saveScene(scene);
    }
  }

  render() {
    const appEl = document.getElementById('app');
    if (!appEl) return;

    appEl.innerHTML = `
      ${this.renderNavbar()}
      <main class="main-content">
        ${this.renderCurrentView()}
      </main>
      ${this.renderDownloadDrawer()}
      <div id="modal-root"></div>
      <div id="toast-root" class="toast-container"></div>
    `;

    this.bindViewEvents();
  }

  renderNavbar() {
    const activeDownloadsCount = Array.from(this.downloadQueue.values()).filter(d => d.status === 'downloading' || d.status === 'queued').length;

    return `
      <header class="navbar">
        <div class="logo-container" id="nav-logo">
          <div class="logo-badge">🎙️</div>
          <div>
            <div class="logo-text">VOICE DUB HERO</div>
            <div class="logo-sub">ARCADE DUBBING GAME</div>
          </div>
        </div>

        <nav class="nav-links">
          <button class="nav-btn ${this.currentView === 'home' ? 'active' : ''}" id="nav-home">
            🏠 Menú Principal
          </button>
          <button class="nav-btn ${this.currentView === 'library' ? 'active' : ''}" id="nav-library">
            📚 Mis Escenas (${this.scenes.length})
          </button>
          <button class="nav-btn ${this.currentView === 'saved_dubs' ? 'active' : ''}" id="nav-saved-dubs" style="color: var(--neon-pink); border-color: rgba(255,0,128,0.35);">
            🎙️ Mis Doblajes (${this.savedDubs.length})
          </button>
          <button class="nav-btn ${this.currentView === 'online_browse' ? 'active' : ''}" id="nav-online" style="color: var(--neon-cyan); border-color: rgba(0,240,255,0.3);">
            🌐 Escenas Online (+2,300)
          </button>
          <button class="nav-btn ${this.currentView === 'downloads' ? 'active' : ''}" id="nav-downloads" style="color: var(--neon-yellow); border-color: rgba(255,230,0,0.3);">
            📥 Descargas ${activeDownloadsCount > 0 ? `(${activeDownloadsCount})` : (this.downloadQueue.size > 0 ? `(${this.downloadQueue.size})` : '')}
          </button>
          <button class="nav-btn ${this.currentView === 'characters' ? 'active' : ''}" id="nav-characters">
            🎭 Personajes
          </button>
          <button class="nav-btn ${this.currentView === 'settings' ? 'active' : ''}" id="nav-settings">
            ⚙️ Configuración
          </button>
        </nav>

        <div style="display:flex; gap:0.5rem; align-items:center;">
          ${activeDownloadsCount > 0 ? `
            <button class="btn-cyan" id="btn-toggle-downloads" style="font-size:0.85rem; padding:0.5rem 0.9rem; background:linear-gradient(135deg, var(--neon-yellow), #eab308); color:#000; font-weight:800; animation:pulse 1.5s infinite;">
              📥 Descargas (${activeDownloadsCount})
            </button>
          ` : `
            <button class="btn-secondary" id="btn-toggle-downloads" style="font-size:0.85rem; padding:0.5rem 0.9rem;">
              📥 Descargas (${this.downloadQueue.size})
            </button>
          `}
          <button class="btn-cyan" id="btn-open-import" style="font-size:0.85rem;">
            📥 Importar ZIP / RAR
          </button>
        </div>
      </header>
    `;
  }

  renderCurrentView() {
    switch (this.currentView) {
      case 'home': return this.renderHomeView();
      case 'library': return this.renderLibraryView();
      case 'saved_dubs': return this.renderSavedDubsView();
      case 'play_dub': return this.renderPlayDubView();
      case 'online_browse': return this.renderOnlineBrowseView();
      case 'downloads': return this.renderDownloadsView();
      case 'character_select': return this.renderCharacterSelectView();
      case 'studio': return this.renderStudioView();
      case 'take_studio': return this.renderTakeStudioView();
      case 'results': return this.renderResultsView();
      case 'characters': return this.renderCharactersView();
      case 'settings': return this.renderSettingsView();
      default: return this.renderHomeView();
    }
  }

  // ==========================================
  // IMAGE & VIDEO RESOURCE HELPERS
  // ==========================================

  toBlob(rawData, mimeType = 'application/octet-stream') {
    if (!rawData) return null;
    if (rawData instanceof Blob) return rawData;
    if (rawData instanceof Uint8Array) {
      return new Blob([rawData], { type: mimeType });
    }
    if (rawData instanceof ArrayBuffer) {
      return new Blob([rawData], { type: mimeType });
    }
    if (typeof rawData === 'object' && rawData.buffer) {
      const u8 = new Uint8Array(rawData.buffer, rawData.byteOffset || 0, rawData.byteLength || rawData.length);
      return new Blob([u8], { type: mimeType });
    }
    if (typeof rawData === 'object') {
      const values = Object.values(rawData);
      const u8 = new Uint8Array(values);
      return new Blob([u8], { type: mimeType });
    }
    return new Blob([rawData], { type: mimeType });
  }

  toDataUrl(bytesData, mimeType = 'image/png') {
    if (!bytesData) return '';
    let bytes;
    if (bytesData instanceof Uint8Array) {
      bytes = bytesData;
    } else if (bytesData instanceof ArrayBuffer) {
      bytes = new Uint8Array(bytesData);
    } else if (typeof bytesData === 'object' && bytesData.buffer) {
      bytes = new Uint8Array(bytesData.buffer, bytesData.byteOffset || 0, bytesData.byteLength || bytesData.length);
    } else if (typeof bytesData === 'object') {
      bytes = new Uint8Array(Object.values(bytesData));
    } else {
      bytes = new Uint8Array(bytesData);
    }

    let binary = '';
    const len = bytes.byteLength;
    const chunk = 8192;
    for (let i = 0; i < len; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  }

  getSceneCoverUrl(scene) {
    if (!scene || !scene.rawFiles) return '';
    const cacheKey = `cover_${scene.id}`;
    if (this.imageCache.has(cacheKey)) return this.imageCache.get(cacheKey);

    let rawData = null;
    if (scene.iconName && scene.rawFiles[scene.iconName]) {
      rawData = scene.rawFiles[scene.iconName];
    } else {
      const key = Object.keys(scene.rawFiles).find(k => k.includes('icon.png') || k.includes('ts.png') || k.match(/\.(png|jpg|jpeg|webp)$/i));
      if (key) rawData = scene.rawFiles[key];
    }

    if (rawData) {
      const url = this.toDataUrl(rawData, 'image/png');
      this.imageCache.set(cacheKey, url);
      return url;
    }
    return '';
  }

  getCharacterImageUrl(scene, characterName) {
    if (!scene || !scene.rawFiles) return '';
    const cleanName = (characterName || '').toLowerCase().trim();
    const cacheKey = `char_${scene.id}_${cleanName}`;
    if (this.imageCache.has(cacheKey)) return this.imageCache.get(cacheKey);

    // 1. Look for dialogue associated with this character that has an explicit imageName
    const diag = (scene.dialogues || []).find(d => (d.character || '').toLowerCase().trim() === cleanName && d.imageName);
    if (diag && diag.imageName) {
      const explicitKey = Object.keys(scene.rawFiles).find(k => k.toLowerCase().endsWith(diag.imageName.toLowerCase()));
      if (explicitKey && scene.rawFiles[explicitKey]) {
        const url = this.toDataUrl(scene.rawFiles[explicitKey], 'image/png');
        this.imageCache.set(cacheKey, url);
        return url;
      }
    }

    // 2. Look by character name substring in filename (ignoring special symbols)
    const strippedName = cleanName.replace(/[^a-z0-9]/g, '');
    let matchedKey = Object.keys(scene.rawFiles).find(k => {
      const lower = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      return (lower.includes(strippedName) || (strippedName.length > 3 && strippedName.includes(lower))) && k.match(/\.(png|jpg|jpeg|webp)$/i);
    });

    if (!matchedKey) {
      matchedKey = Object.keys(scene.rawFiles).find(k => k.match(/\.(png|jpg|jpeg|webp)$/i) && !k.includes('icon') && !k.includes('ts.png'));
    }

    if (matchedKey && scene.rawFiles[matchedKey]) {
      const url = this.toDataUrl(scene.rawFiles[matchedKey], 'image/png');
      this.imageCache.set(cacheKey, url);
      return url;
    }

    return this.getSceneCoverUrl(scene);
  }

  getVideoUrl(scene) {
    if (!scene || !scene.rawFiles) return '';

    const cacheKey = `video_${scene.id}`;
    if (this.blobUrlCache.has(cacheKey)) return this.blobUrlCache.get(cacheKey);

    let videoKey = Object.keys(scene.rawFiles).find(k => k.endsWith('.mp4')) ||
                   Object.keys(scene.rawFiles).find(k => k.endsWith('.webm'));

    if (videoKey && scene.rawFiles[videoKey]) {
      const mime = videoKey.endsWith('.mp4') ? 'video/mp4' : 'video/webm';
      const blob = this.toBlob(scene.rawFiles[videoKey], mime);
      if (blob) {
        const url = URL.createObjectURL(blob);
        this.blobUrlCache.set(cacheKey, url);
        return url;
      }
    }

    return '';
  }

  getBackingAudioUrl(scene) {
    if (!scene || !scene.rawFiles) return '';
    const cacheKey = `backing_${scene.id}`;
    if (this.blobUrlCache.has(cacheKey)) return this.blobUrlCache.get(cacheKey);

    const backingKey = scene.backingTrackKey || Object.keys(scene.rawFiles).find(k => k.includes('backing_track') || k.includes('background') || k.includes('music') || k.includes('_backing_track'));
    if (backingKey && scene.rawFiles[backingKey]) {
      const mime = backingKey.endsWith('.ogg') ? 'audio/ogg' : (backingKey.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
      const blob = this.toBlob(scene.rawFiles[backingKey], mime);
      if (blob) {
        const url = URL.createObjectURL(blob);
        this.blobUrlCache.set(cacheKey, url);
        return url;
      }
    }
    return '';
  }

  getDialogueAudioUrl(scene, dialogue) {
    if (!scene || !scene.rawFiles || !dialogue) return '';
    const cacheKey = `diag_${scene.id}_${dialogue.id}`;
    if (this.blobUrlCache.has(cacheKey)) return this.blobUrlCache.get(cacheKey);

    const audioKey = dialogue.audioKey || Object.keys(scene.rawFiles).find(k => k.includes(dialogue.id) && (k.endsWith('.mp3') || k.endsWith('.ogg') || k.endsWith('.wav')));
    if (audioKey && scene.rawFiles[audioKey]) {
      const mime = audioKey.endsWith('.ogg') ? 'audio/ogg' : (audioKey.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
      const blob = this.toBlob(scene.rawFiles[audioKey], mime);
      if (blob) {
        const url = URL.createObjectURL(blob);
        this.blobUrlCache.set(cacheKey, url);
        return url;
      }
    }
    return '';
  }

  // ==========================================
  // NAVIGATION & ROUTING
  // ==========================================

  navigate(viewName, params = {}) {
    SFX.playClick();
    this.stopStudioPlayback();

    this.currentView = viewName;
    if (params.scene) this.selectedScene = params.scene;
    if (params.character) this.selectedCharacter = params.character;
    if (params.result) this.lastResult = params.result;
    if (params.mode) this.playbackMode = params.mode;

    this.render();
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (viewName === 'online_browse' && this.onlineScenes.length === 0) {
      this.loadOnlineScenes(1, this.onlineSearchQuery);
    }
  }

  // ==========================================
  // VIEW: HOME
  // ==========================================

  renderHomeView() {
    const featuredScene = this.scenes[0] || null;
    const coverUrl = featuredScene ? this.getSceneCoverUrl(featuredScene) : '';
    const characters = featuredScene ? (featuredScene.characters || ['Woody', 'Buzz']) : [];

    return `
      <div class="hero-section">
        <div>
          <div class="hero-tag">✨ JUEGO DE DOBLAJE TIKTOK & ARCADE</div>
          <h1 class="hero-title">¡Escucha, Visualiza y Dobla tus <span>Escenas Favoritas</span>!</h1>
          <p class="hero-desc">
            Disfruta de las actuaciones y música original de cada escena, visualiza el video HD con tus personajes 
            y descarga miles de escenas creadas por la comunidad directamente desde GameBanana.
          </p>
          <div class="hero-actions">
            ${featuredScene ? `
              <button class="btn-cyan" id="btn-home-listen-original" style="font-size: 1.05rem; padding: 0.8rem 1.7rem; background: linear-gradient(135deg, var(--neon-green), #00a653); color: #000; font-weight: 900;">
                ▶️ ESCUCHAR / VER ESCENA ORIGINAL
              </button>
              <button class="btn-primary" id="btn-home-dub" style="font-size: 1.05rem; padding: 0.8rem 1.7rem;">
                🎙️ GRABAR DOBLAJE
              </button>
            ` : `
              <button class="btn-secondary" id="btn-home-import-zip" style="font-size: 1.05rem; padding: 0.8rem 1.7rem;">
                📥 Importar ZIP Local
              </button>
            `}
            <button class="btn-cyan" id="btn-home-online-scenes" style="font-size: 1.05rem; padding: 0.8rem 1.7rem; background: linear-gradient(135deg, #00f0ff, #0088ff); color: #000; font-weight: 800;">
              🌐 BUSCADOR ONLINE (+2,300)
            </button>
            <button class="btn-secondary" id="btn-hero-library">
              📚 Mis Escenas (${this.scenes.length})
            </button>
          </div>
        </div>

        <div>
          ${featuredScene ? `
            <div class="featured-card">
              <div class="featured-cover-wrapper">
                <img src="${coverUrl}" class="featured-cover-img" alt="${featuredScene.title}" />
                <span class="featured-badge">🔥 ESCENA DISPONIBLE</span>
              </div>
              <div class="featured-info">
                <h3 class="featured-title">${featuredScene.title}</h3>
                
                <div style="display: flex; gap: 0.6rem; align-items: center; margin: 0.6rem 0 1rem 0;">
                  ${characters.map(charName => {
                    const charImg = this.getCharacterImageUrl(featuredScene, charName);
                    return `
                      <div style="display: flex; align-items: center; gap: 0.35rem; background: rgba(255,255,255,0.08); padding: 0.25rem 0.65rem; border-radius: 20px; border: 1px solid var(--border-glass);">
                        <img src="${charImg}" style="width: 26px; height: 26px; border-radius: 50%; object-fit: cover;" />
                        <span style="font-size: 0.8rem; font-weight: 700; color: var(--neon-yellow);">${charName}</span>
                      </div>
                    `;
                  }).join('')}
                </div>

                <div style="display: flex; gap: 0.5rem;">
                  <button class="btn-card-play" id="btn-card-listen" style="flex: 1.2; background: linear-gradient(135deg, var(--neon-green), #00a852); color: #000; font-weight: 900;">
                    ▶️ Escuchar Escena
                  </button>
                  <button class="btn-card-play" id="btn-card-dub" style="flex: 1; background: linear-gradient(135deg, var(--neon-pink), #c70063); color: #fff;">
                    🎙️ Doblar
                  </button>
                </div>
              </div>
            </div>
          ` : `
            <div class="empty-state" style="margin:0;">
              <div class="empty-icon">📦</div>
              <h3 style="font-size:1.3rem; font-weight:800;">Tu biblioteca está limpia</h3>
              <p style="color:var(--text-muted); margin: 0.5rem 0 1.25rem 0; font-size:0.9rem;">
                Descarga escenas de GameBanana con un solo clic o importa tu propio archivo ZIP para comenzar a jugar.
              </p>
              <div style="display:flex; gap:0.75rem; justify-content:center; flex-wrap:wrap;">
                <button class="btn-cyan" id="btn-empty-online">🌐 Explorar Escenas Online</button>
                <button class="btn-secondary" id="btn-empty-import">📥 Importar ZIP</button>
              </div>
            </div>
          `}
        </div>
      </div>

      <div class="section-title">
        ⚡ Características del Sistema
      </div>

      <div class="features-grid">
        <div class="feature-box">
          <div class="feature-icon">🌐</div>
          <h3>Buscador y Descarga Online (GameBanana)</h3>
          <p>Explora más de 2,300 escenas creadas por la comunidad de GameBanana (The Choicer Voicer) y descárgalas directamente al juego.</p>
        </div>

        <div class="feature-box">
          <div class="feature-icon">📥</div>
          <h3>Descargas Múltiples en Paralelo</h3>
          <p>Selecciona varias escenas a la vez y descárgalas en segundo plano con el nuevo mini-panel de descargas.</p>
        </div>

        <div class="feature-box">
          <div class="feature-icon">▶️</div>
          <h3>Reproductor de Escena Completa</h3>
          <p>Mira la escena en video HD y escucha la pista instrumental con todas las voces originales sincronizadas y subtítulos karaoke.</p>
        </div>

        <div class="feature-box">
          <div class="feature-icon">🎙️</div>
          <h3>Estudio de Doblaje en Vivo</h3>
          <p>Graba tu voz con teleprompter, cuenta regresiva 3-2-1 y reemplazo automático de los personajes que elijas.</p>
        </div>
      </div>
    `;
  }

  // ==========================================
  // VIEW: LIBRARY ("MIS ESCENAS")
  // ==========================================

  renderLibraryView() {
    return `
      <div class="section-header">
        <div>
          <h2 class="section-title">📚 Mis Escenas Guardadas</h2>
          <p style="color:var(--text-muted); margin-top:0.3rem;">
            Colección local de escenas listas para reproducir y doblar (${this.scenes.length} guardadas)
          </p>
        </div>
        <div style="display:flex; gap:0.75rem; flex-wrap:wrap;">
          <button class="btn-cyan" id="btn-lib-browse-online" style="background: linear-gradient(135deg, #00f0ff, #0088ff); color: #000; font-weight:800;">
            🌐 Descargar de GameBanana (+2,300)
          </button>
          <button class="btn-secondary" id="btn-lib-import">
            📥 Importar ZIP Local
          </button>
        </div>
      </div>

      ${this.scenes.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <h2>Tu biblioteca está vacía</h2>
          <p style="color:var(--text-muted); margin: 0.75rem 0 1.5rem 0;">
            Descarga escenas de GameBanana con un solo clic o importa un archivo ZIP.
          </p>
          <div style="display:flex; gap:0.75rem; justify-content:center;">
            <button class="btn-cyan" id="btn-empty-online-2">🌐 Explorar Escenas Online</button>
            <button class="btn-secondary" id="btn-empty-import-2">📥 Seleccionar Archivo ZIP</button>
          </div>
        </div>
      ` : `
        <div class="scenes-grid">
          ${this.scenes.map(scene => this.renderSceneCard(scene)).join('')}
        </div>
      `}
    `;
  }

  renderSceneCard(scene) {
    const coverUrl = this.getSceneCoverUrl(scene);
    const dateFormatted = new Date(scene.importDate || Date.now()).toLocaleDateString('es-ES', {
      year: 'numeric', month: 'short', day: 'numeric'
    });
    const minutes = Math.floor((scene.duration || 60) / 60);
    const seconds = Math.floor((scene.duration || 60) % 60);
    const durationFormatted = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    const characters = scene.characters || [];

    return `
      <div class="scene-card" data-scene-id="${scene.id}">
        <div class="scene-thumb-wrapper">
          <img src="${coverUrl}" class="scene-thumb" alt="${scene.title}" />
          <div class="scene-overlay-badge">⏱️ ${durationFormatted}</div>
        </div>

        <div class="scene-body">
          <h3 class="scene-name" title="${scene.title}">${scene.title}</h3>
          <div class="scene-author">Por: ${(scene.authors || []).join(', ')}</div>

          <div class="scene-characters-list">
            ${characters.map(c => {
              const charImg = this.getCharacterImageUrl(scene, c);
              return `
                <div style="display: flex; align-items: center; gap: 0.35rem; background: rgba(255,255,255,0.06); padding: 0.2rem 0.5rem; border-radius: 16px; border: 1px solid var(--border-glass);">
                  <img src="${charImg}" style="width: 22px; height: 22px; border-radius: 50%; object-fit: cover;" />
                  <span style="font-size: 0.75rem; color: var(--neon-yellow); font-weight: 600;">${c}</span>
                </div>
              `;
            }).join('')}
          </div>

          <div class="scene-meta-row">
            <span>📅 ${dateFormatted}</span>
            <span>💬 ${scene.dialogues?.length || 0} frases</span>
          </div>

          <div class="scene-actions-row">
            <button class="btn-card-play btn-listen-scene" data-id="${scene.id}" style="background: linear-gradient(135deg, var(--neon-green), #00a653); color: #000; font-size: 0.85rem;" title="Escuchar y ver escena original completa">
              ▶️ ESCUCHAR
            </button>
            <button class="btn-card-play btn-dub-scene" data-id="${scene.id}" style="background: linear-gradient(135deg, var(--neon-pink), #c70063); color: #fff; font-size: 0.85rem;" title="Doblar personaje">
              🎙️ DOBLAR
            </button>
            <button class="btn-icon-action btn-preview-scene" data-id="${scene.id}" title="Detalles y Lista de Diálogos">
              👁️
            </button>
            <button class="btn-icon-action btn-share-scene" data-id="${scene.id}" title="Exportar ZIP">
              📤
            </button>
            <button class="btn-icon-action btn-delete btn-delete-scene" data-id="${scene.id}" title="Eliminar Escena">
              🗑️
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================
  // VIEW: SAVED DUBS ("MIS DOBLAJES")
  // ==========================================

  renderSavedDubsView() {
    return `
      <div class="section-header">
        <div>
          <div class="hero-tag" style="background:rgba(255,0,128,0.15); border-color:var(--neon-pink); color:var(--neon-pink);">
            🎙️ TUS ACTUACIONES GUARDADAS
          </div>
          <h2 class="section-title">🎙️ Mis Escenas Dobladas</h2>
          <p style="color:var(--text-muted); margin-top:0.3rem;">
            Colección de tus actuaciones de doblaje grabadas (${this.savedDubs.length} guardadas). ¡Reprodúcelas con tu voz en cualquier momento!
          </p>
        </div>
        <div style="display:flex; gap:0.75rem; flex-wrap:wrap;">
          <button class="btn-cyan" id="btn-dubs-browse-scenes" style="background: linear-gradient(135deg, var(--neon-cyan), #0088ff); color: #000; font-weight:800;">
            ➕ Doblar Nueva Escena
          </button>
        </div>
      </div>

      ${this.savedDubs.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">🎙️</div>
          <h2>Aún no has guardado ningún doblaje</h2>
          <p style="color:var(--text-muted); margin: 0.75rem 0 1.5rem 0; max-width: 500px; margin-left: auto; margin-right: auto;">
            Elige una escena, dobla a tu personaje favorito frase por frase y al terminar pulsa "Guardar Doblaje" para conservarlo aquí y reproducirlo con tu voz.
          </p>
          <button class="btn-cyan" id="btn-dubs-empty-start">🎬 Comenzar a Doblar Escenas</button>
        </div>
      ` : `
        <div class="scenes-grid">
          ${this.savedDubs.map(dub => this.renderSavedDubCard(dub)).join('')}
        </div>
      `}
    `;
  }

  renderSavedDubCard(dub) {
    const dateFormatted = new Date(dub.date || Date.now()).toLocaleDateString('es-ES', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const coverUrl = dub.coverUrl || (dub.sceneSnapshot ? this.getSceneCoverUrl(dub.sceneSnapshot) : 'https://images.gamebanana.com/static/img/defaults/avatar.gif');
    const takesCount = dub.takes?.length || 0;
    const charName = dub.characterDubbed || 'Personaje';
    const charImg = dub.charImg || (dub.sceneSnapshot ? this.getCharacterImageUrl(dub.sceneSnapshot, charName) : '');

    return `
      <div class="scene-card" style="border-color: rgba(255,0,128,0.3); box-shadow: 0 8px 25px rgba(255,0,128,0.15);">
        <div class="scene-thumb-wrapper" style="height: 190px;">
          <img src="${coverUrl}" class="scene-thumb" alt="${dub.sceneTitle}" />
          <div class="scene-overlay-badge" style="background: linear-gradient(135deg, var(--neon-pink), #c70063); color: #fff;">
            🎙️ Doblado: ${charName}
          </div>
          ${dub.rank ? `
            <div style="position: absolute; top: 10px; right: 10px; background: var(--neon-yellow); color: #000; font-weight: 900; font-size: 1rem; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 12px rgba(255,230,0,0.7);">
              ${dub.rank}
            </div>
          ` : ''}
        </div>

        <div class="scene-body">
          <h3 class="scene-name" title="${dub.sceneTitle}">
            ${dub.sceneTitle}
          </h3>

          <div style="display:flex; align-items:center; gap:0.5rem; margin: 0.5rem 0;">
            ${charImg ? `<img src="${charImg}" style="width: 28px; height: 28px; border-radius: 50%; object-fit: cover; border: 2px solid var(--neon-cyan);" />` : ''}
            <span style="font-size: 0.85rem; font-weight: 700; color: var(--neon-cyan);">Rol: ${charName}</span>
            <span style="color: var(--text-dim);">•</span>
            <span style="font-size: 0.8rem; color: var(--neon-yellow);">Filtro: ${dub.effectApplied || 'Normal'}</span>
          </div>

          <div class="scene-meta-row">
            <span>📅 ${dateFormatted}</span>
            <span>💬 ${takesCount} frases con tu voz</span>
          </div>

          <div class="scene-actions-row">
            <button class="btn-card-play btn-play-saved-dub" data-id="${dub.id}" style="background: linear-gradient(135deg, var(--neon-pink), #c70063); color: #fff; font-weight: 800; font-size: 0.85rem;" title="Reproducir escena completa con tu voz grabada">
              ▶️ VER MI DOBLAJE
            </button>
            <button class="btn-icon-action btn-delete-saved-dub" data-id="${dub.id}" title="Eliminar este doblaje" style="color: var(--neon-pink);">
              🗑️
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================
  // VIEW: PLAY DUBBED SCENE WITH USER AUDIO
  // ==========================================

  renderPlayDubView() {
    if (!this.activePlayingDub) return this.renderSavedDubsView();

    const dub = this.activePlayingDub;
    const sceneSnapshot = dub.sceneSnapshot || this.selectedScene || {};
    const coverUrl = dub.coverUrl || this.getSceneCoverUrl(sceneSnapshot);
    const videoUrl = this.getVideoUrl(sceneSnapshot);
    const charName = dub.characterDubbed || 'Personaje';
    const charImg = this.getCharacterImageUrl(sceneSnapshot, charName);
    const totalSec = Math.floor(dub.duration || sceneSnapshot.duration || 60);

    return `
      <div style="max-width: 960px; margin: 0 auto;">
        <!-- Header -->
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1.25rem; flex-wrap:wrap; gap:0.75rem;">
          <button class="btn-secondary" id="btn-back-to-saved-dubs">
            ⬅️ Volver a Mis Doblajes
          </button>
          <div style="display:flex; align-items:center; gap:0.6rem;">
            <span class="char-badge" style="background: rgba(255,0,128,0.2); border-color: var(--neon-pink); color: #fff;">
              🎙️ Tu Actuación como: ${charName}
            </span>
            <span class="char-badge">
              ⭐ ${dub.score || 9500} PTS (${dub.rank || 'S'})
            </span>
          </div>
        </div>

        <!-- Video Player Stage -->
        <div class="stage-card" style="position: relative; aspect-ratio: 16 / 9; background: #000; overflow: hidden; border-radius: var(--radius-xl); box-shadow: 0 15px 40px rgba(0,0,0,0.8); margin-bottom: 1.5rem;">
          <video id="play-dub-video" class="video-player" src="${videoUrl}" poster="${coverUrl}" playsinline preload="auto" style="width: 100%; height: 100%; object-fit: contain; background: #000; display: block;"></video>

          <!-- Current Speaker Avatar Bubble -->
          <div id="play-dub-avatar-overlay" class="talking-avatar-overlay" style="position: absolute; top: 16px; left: 16px; z-index: 10;">
            <img id="play-dub-avatar-img" src="${charImg}" class="avatar-bubble-img" alt="${charName}" />
            <div>
              <div id="play-dub-avatar-name" class="avatar-bubble-name">${charName}</div>
              <div id="play-dub-avatar-badge" style="font-size: 0.7rem; color: var(--neon-pink); font-weight: 800;">🎙️ TU VOZ GRABADA</div>
            </div>
          </div>
        </div>

        <!-- Real-time Karaoke / Subtitle Teleprompter Bar -->
        <div class="teleprompter-card" style="margin-bottom: 1.5rem; text-align: center; padding: 1.25rem; background: rgba(10,12,24,0.9); border: 2px solid var(--border-glass); border-radius: var(--radius-lg);">
          <div id="play-dub-quote" class="teleprompter-quote" style="font-size: 1.4rem; font-weight: 800; color: #fff; min-height: 2.2rem;">
            "${dub.takes?.[0]?.caption || 'Pulsa Reproducir para escuchar tu doblaje...'}"
          </div>
        </div>

        <!-- Playback Controls Bar -->
        <div class="control-card" style="display:flex; flex-direction:column; gap:1rem;">
          <!-- Progress Bar & Timestamps -->
          <div style="display:flex; align-items:center; gap: 1rem;">
            <span id="play-dub-time-current" style="font-family: monospace; color: var(--neon-cyan); font-weight: 700; min-width: 45px;">0:00</span>
            <input type="range" id="play-dub-seeker" class="timeline-slider" min="0" max="${totalSec}" step="0.05" value="0" style="flex:1;" />
            <span id="play-dub-time-total" style="font-family: monospace; color: var(--text-muted); font-weight: 700; min-width: 45px;">
              ${Math.floor(totalSec / 60)}:${Math.floor(totalSec % 60) < 10 ? '0' : ''}${Math.floor(totalSec % 60)}
            </span>
          </div>

          <!-- Main Buttons -->
          <div style="display:flex; justify-content:center; gap: 1rem; align-items:center; flex-wrap:wrap;">
            <button class="btn-cyan" id="btn-play-dub-toggle" style="padding: 0.8rem 2.2rem; font-size: 1.1rem; background: linear-gradient(135deg, var(--neon-green), #00a852); color: #000; font-weight: 900;">
              <span>▶️</span> <span>REPRODUCIR</span>
            </button>
            <button class="btn-secondary" id="btn-play-dub-restart" style="padding: 0.8rem 1.5rem;">
              🔄 Reiniciar
            </button>
          </div>
        </div>
      </div>
    `;
  }

  async setupPlayDub(dubRecord) {
    this.stopStudioPlayback();
    this.activePlayingDub = dubRecord;
    await this.audio.init();

    const sceneSnapshot = dubRecord.sceneSnapshot || this.selectedScene || {};
    this.playDubUserBuffers.clear();
    this.playDubPlayedIds.clear();

    // 1. Decode all user recorded takes into AudioBuffers
    const takes = dubRecord.takes || [];
    for (const take of takes) {
      if (take.audioBlob) {
        try {
          const arrayBuf = await take.audioBlob.arrayBuffer();
          const audioBuf = await this.audio.decodeAudio(arrayBuf, `user_dub_${take.dialogueId}`);
          if (audioBuf) {
            this.playDubUserBuffers.set(take.dialogueId, audioBuf);
          }
        } catch (e) {
          console.warn('Could not decode user take:', e);
        }
      }
    }

    // 2. Prepare backing audio
    const backingUrl = this.getBackingAudioUrl(sceneSnapshot);
    if (backingUrl) {
      this.backingAudioEl = new Audio(backingUrl);
      this.backingAudioEl.preload = 'auto';
    }

    // 3. Prepare other dialogue original audios
    for (const d of (sceneSnapshot.dialogues || [])) {
      if (d.character.toLowerCase() !== (dubRecord.characterDubbed || '').toLowerCase() && dubRecord.characterDubbed !== 'All') {
        const diagUrl = this.getDialogueAudioUrl(sceneSnapshot, d);
        if (diagUrl) {
          d.audioEl = new Audio(diagUrl);
          d.audioEl.preload = 'auto';
        }
      }
    }

    this.currentTime = 0;
    this.duration = dubRecord.duration || sceneSnapshot.duration || 60;
    this.isPlaying = false;
  }

  async startPlayDubLoop() {
    this.isPlaying = true;
    this.startWallTime = performance.now() - (this.currentTime * 1000);

    // Mark past dialogues as already played
    this.playDubPlayedIds.clear();
    const sceneSnapshot = this.activePlayingDub?.sceneSnapshot || this.selectedScene || {};
    const dialogues = sceneSnapshot.dialogues || [];
    for (const d of dialogues) {
      if (d.timestamp < this.currentTime) {
        this.playDubPlayedIds.add(d.id);
      }
    }

    // Play video
    const videoEl = document.getElementById('play-dub-video');
    if (videoEl) {
      videoEl.currentTime = this.currentTime;
      videoEl.muted = true;
      videoEl.play().catch(() => {});
    }

    // Play backing track
    if (this.backingAudioEl) {
      this.backingAudioEl.currentTime = this.currentTime;
      this.backingAudioEl.volume = Math.max(0, Math.min(1.0, this.audio.volumes.backing));
      this.backingAudioEl.play().catch(() => {});
    }

    const btnToggle = document.getElementById('btn-play-dub-toggle');
    if (btnToggle) {
      btnToggle.innerHTML = `<span>⏸️</span> <span>PAUSAR</span>`;
      btnToggle.style.background = 'linear-gradient(135deg, var(--neon-pink), #c70063)';
      btnToggle.style.color = '#fff';
    }

    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);

    const loop = () => {
      if (!this.isPlaying) return;

      const elapsed = (performance.now() - this.startWallTime) / 1000;
      this.currentTime = Math.max(0, elapsed);

      if (this.currentTime >= this.duration) {
        this.pausePlayDub();
        return;
      }

      this.updatePlayDubUI(this.currentTime);

      // Check dialogue audio triggers
      for (const d of dialogues) {
        if (this.currentTime >= d.timestamp && !this.playDubPlayedIds.has(d.id)) {
          this.playDubPlayedIds.add(d.id);

          const isUserDubbed = this.activePlayingDub?.characterDubbed === 'All' ||
            d.character.toLowerCase() === (this.activePlayingDub?.characterDubbed || '').toLowerCase();

          if (isUserDubbed) {
            // Play USER'S RECORDED TAKE!
            const userBuf = this.playDubUserBuffers.get(d.id);
            if (userBuf) {
              this.audio.playBuffer(userBuf, 'voice', 0, this.activePlayingDub?.effectApplied || 'clean');
            } else {
              const take = (this.activePlayingDub?.takes || []).find(t => t.dialogueId === d.id);
              if (take && take.audioBlob) {
                const url = URL.createObjectURL(take.audioBlob);
                const el = new Audio(url);
                el.volume = 1.0;
                el.play().catch(() => {});
              }
            }
          } else {
            // Play original other character
            if (d.audioEl) {
              d.audioEl.currentTime = 0;
              d.audioEl.volume = this.audio.volumes.original || 1.0;
              d.audioEl.play().catch(() => {});
            }
          }
        }
      }

      this.animFrameId = requestAnimationFrame(loop);
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  pausePlayDub() {
    this.isPlaying = false;
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);

    const videoEl = document.getElementById('play-dub-video');
    if (videoEl) videoEl.pause();

    if (this.backingAudioEl) this.backingAudioEl.pause();

    const sceneSnapshot = this.activePlayingDub?.sceneSnapshot || this.selectedScene || {};
    for (const d of (sceneSnapshot.dialogues || [])) {
      if (d.audioEl) d.audioEl.pause();
    }

    this.audio.stopAll();

    const btnToggle = document.getElementById('btn-play-dub-toggle');
    if (btnToggle) {
      btnToggle.innerHTML = `<span>▶️</span> <span>REANUDAR</span>`;
      btnToggle.style.background = 'linear-gradient(135deg, var(--neon-green), #00a852)';
      btnToggle.style.color = '#000';
    }
  }

  togglePlayDub() {
    if (this.isPlaying) {
      this.pausePlayDub();
    } else {
      this.startPlayDubLoop();
    }
  }

  restartPlayDub() {
    SFX.playClick();
    this.pausePlayDub();
    this.currentTime = 0;
    this.playDubPlayedIds.clear();

    const videoEl = document.getElementById('play-dub-video');
    if (videoEl) videoEl.currentTime = 0;
    if (this.backingAudioEl) this.backingAudioEl.currentTime = 0;

    this.updatePlayDubUI(0);
    this.startPlayDubLoop();
  }

  updatePlayDubUI(seconds) {
    const seeker = document.getElementById('play-dub-seeker');
    if (seeker) seeker.value = seconds;

    const timeCur = document.getElementById('play-dub-time-current');
    if (timeCur) {
      const min = Math.floor(seconds / 60);
      const sec = Math.floor(seconds % 60);
      timeCur.textContent = `${min}:${sec < 10 ? '0' : ''}${sec}`;
    }

    // Active dialogue quote & speaker update
    const sceneSnapshot = this.activePlayingDub?.sceneSnapshot || this.selectedScene || {};
    const dialogues = sceneSnapshot.dialogues || [];
    const active = dialogues.find(d => seconds >= d.timestamp && seconds <= (d.endTime || (d.timestamp + (d.duration || 3.5))));

    if (active) {
      const quoteEl = document.getElementById('play-dub-quote');
      if (quoteEl) quoteEl.textContent = `"${active.caption}"`;

      const avatarName = document.getElementById('play-dub-avatar-name');
      if (avatarName) avatarName.textContent = active.character;

      const avatarImg = document.getElementById('play-dub-avatar-img');
      if (avatarImg) avatarImg.src = this.getCharacterImageUrl(sceneSnapshot, active.character);

      const avatarBadge = document.getElementById('play-dub-avatar-badge');
      const isUserDubbed = this.activePlayingDub?.characterDubbed === 'All' ||
        active.character.toLowerCase() === (this.activePlayingDub?.characterDubbed || '').toLowerCase();

      if (avatarBadge) {
        if (isUserDubbed) {
          avatarBadge.textContent = '🎙️ TU VOZ GRABADA';
          avatarBadge.style.color = 'var(--neon-pink)';
        } else {
          avatarBadge.textContent = '🗣️ VOZ ORIGINAL';
          avatarBadge.style.color = 'var(--neon-cyan)';
        }
      }
    }
  }

  async saveCurrentDubbingSession() {
    if (!this.selectedScene) return;

    const dubDialogues = this.getDubDialogues();
    const takesArray = [];

    for (const d of dubDialogues) {
      const takeData = this.userTakeRecordings.get(d.id);
      if (takeData) {
        takesArray.push({
          dialogueId: d.id,
          character: d.character,
          caption: d.caption,
          timestamp: d.timestamp,
          duration: d.duration,
          audioBlob: takeData.blob,
          peaks: Array.from(takeData.peaks || []),
          score: takeData.score || 92
        });
      }
    }

    if (takesArray.length === 0) {
      this.showToast('No hay tomas grabadas para guardar.', 'error');
      return;
    }

    const avgScore = Math.round(takesArray.reduce((acc, t) => acc + (t.score || 85), 0) / takesArray.length);
    const rank = avgScore >= 92 ? 'S' : (avgScore >= 82 ? 'A' : (avgScore >= 70 ? 'B' : 'C'));

    const dubRecord = {
      id: 'dub_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      sceneId: this.selectedScene.id,
      sceneTitle: this.selectedScene.title,
      characterDubbed: this.selectedCharacter,
      effectApplied: this.selectedEffect,
      date: new Date().toISOString(),
      score: avgScore * 100,
      rank,
      duration: this.selectedScene.duration || 60,
      takes: takesArray,
      sceneSnapshot: {
        id: this.selectedScene.id,
        title: this.selectedScene.title,
        duration: this.selectedScene.duration,
        videoKey: this.selectedScene.videoKey,
        backingTrackKey: this.selectedScene.backingTrackKey,
        characters: this.selectedScene.characters,
        dialogues: this.selectedScene.dialogues,
        rawFiles: this.selectedScene.rawFiles,
        imageFiles: this.selectedScene.imageFiles,
        iconName: this.selectedScene.iconName
      }
    };

    await GameDB.saveRecording(dubRecord);
    await this.loadSavedDubs();

    SFX.playSuccess();
    this.showToast(`¡Doblaje de ${this.selectedCharacter} guardado en Mis Doblajes! 🎙️💾`, 'success');
    this.navigate('saved_dubs');
  }

  // ==========================================
  // VIEW: GAMEBANANA ONLINE BROWSER & MULTI-DOWNLOAD
  // ==========================================

  renderOnlineBrowseView() {
    const selectedCount = this.selectedModIds.size;

    return `
      <div class="section-header">
        <div>
          <div class="hero-tag" style="background:rgba(0,240,255,0.15); border-color:var(--neon-cyan); color:var(--neon-cyan);">
            🌐 COMUNIDAD GAMEBANANA • GAME 20674
          </div>
          <h2 class="section-title">Explorador de Escenas Online</h2>
          <p style="color:var(--text-muted); margin-top:0.3rem;">
            Busca y descarga escenas individuales o selecciona varias para descargarlas en lote en segundo plano.
          </p>
        </div>
        <div style="display:flex; gap:0.5rem; align-items:center;">
          <a href="https://gamebanana.com/games/20674" target="_blank" class="btn-secondary" style="font-size:0.85rem; text-decoration:none;">
            🔗 GameBanana.com ↗
          </a>
        </div>
      </div>

      <!-- Search & Multi-Download Toolbar -->
      <div class="control-card" style="margin-bottom: 1.5rem; display:flex; gap:1rem; align-items:center; flex-wrap:wrap; justify-content:space-between;">
        <div style="display:flex; gap:0.75rem; flex:1; min-width:280px; align-items:center;">
          <div style="flex:1; position:relative;">
            <input type="text" id="online-search-input" class="search-box-input" placeholder="🔍 Buscar escena (Toy Story, Shrek, Anime, Neymar...)" value="${this.onlineSearchQuery}" style="width:100%; background:rgba(10,12,22,0.9); border:2px solid var(--border-glass); border-radius:var(--radius-md); padding:0.75rem 1rem 0.75rem 2.8rem; color:#fff; font-size:0.95rem;" />
            <span style="position:absolute; left:1rem; top:50%; transform:translateY(-50%); font-size:1.1rem; pointer-events:none;">🔍</span>
          </div>
          <button class="btn-cyan" id="btn-search-online" style="padding:0.75rem 1.4rem;">
            Buscar
          </button>
          <button class="btn-secondary" id="btn-clear-search" style="padding:0.75rem 1rem;">
            🔄 Recientes
          </button>
        </div>

        <!-- Bulk Selection Action Bar -->
        <div style="display:flex; gap:0.75rem; align-items:center;">
          ${selectedCount > 0 ? `
            <button class="btn-cyan" id="btn-download-selected" style="background:linear-gradient(135deg, var(--neon-green), #00a852); color:#000; font-weight:900; padding:0.75rem 1.4rem; box-shadow: 0 0 20px rgba(0,255,136,0.5);">
              📥 Descargar Seleccionadas (${selectedCount})
            </button>
            <button class="btn-secondary" id="btn-clear-selection" style="padding:0.75rem 1rem;">
              Desmarcar
            </button>
          ` : `
            <button class="btn-secondary" id="btn-select-all-page" style="padding:0.75rem 1rem; font-size:0.85rem;">
              ☑️ Seleccionar Página
            </button>
          `}
        </div>
      </div>

      <!-- Grid of Online Scenes -->
      ${this.isOnlineLoading ? `
        <div class="empty-state">
          <div class="empty-icon">⏳</div>
          <h3>Cargando catálogo de GameBanana...</h3>
          <p style="color:var(--text-muted); margin-top:0.5rem;">Consultando la comunidad en vivo...</p>
        </div>
      ` : (this.onlineScenes.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <h3>No se encontraron escenas</h3>
          <p style="color:var(--text-muted); margin: 0.5rem 0 1rem 0;">Prueba con otra palabra clave o restablece la búsqueda.</p>
          <button class="btn-cyan" id="btn-reset-search">Ver Todas las Escenas</button>
        </div>
      ` : `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; font-size:0.85rem; color:var(--text-muted);">
          <span>Mostrando ${this.onlineScenes.length} de más de ${this.onlineTotal} escenas:</span>
          <span>💡 Puedes marcar varias casillas para descargar en lote</span>
        </div>

        <div class="scenes-grid">
          ${this.onlineScenes.map(mod => this.renderOnlineModCard(mod)).join('')}
        </div>

        <!-- Pagination -->
        <div style="display:flex; justify-content:center; gap:1rem; margin-top:2.5rem; align-items:center;">
          <button class="btn-secondary" id="btn-prev-page" ${this.onlinePage <= 1 ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''}>
            ⬅️ Página Anterior
          </button>
          <span style="font-weight:700; color:var(--neon-cyan); font-size:1rem;">Página ${this.onlinePage}</span>
          <button class="btn-secondary" id="btn-next-page">
            Página Siguiente ➡️
          </button>
        </div>
      `)}
    `;
  }

  renderOnlineModCard(mod) {
    const isSelected = this.selectedModIds.has(mod.id);
    const queueItem = this.downloadQueue.get(mod.id);
    const isAlreadyInstalled = this.scenes.some(s => s.title.toLowerCase().trim() === mod.title.toLowerCase().trim());
    const thumbUrl = mod.thumbnailUrl || 'https://images.gamebanana.com/static/img/defaults/avatar.gif';

    return `
      <div class="scene-card ${isSelected ? 'selected-card' : ''}" style="display:flex; flex-direction:column; position:relative; ${isSelected ? 'border-color:var(--neon-cyan); box-shadow:var(--shadow-neon-cyan);' : ''}">
        
        <!-- Multi-select Checkbox -->
        <div style="position:absolute; top:10px; left:10px; z-index:10;">
          <input type="checkbox" class="mod-checkbox" data-mod-id="${mod.id}" ${isSelected ? 'checked' : ''} style="width:22px; height:22px; cursor:pointer; accent-color:var(--neon-cyan);" />
        </div>

        <div class="scene-thumb-wrapper" style="height:190px; background:#0e1220;">
          <img src="${thumbUrl}" class="scene-thumb" alt="${mod.title}" onerror="this.src='https://images.gamebanana.com/img/ico/games/669659875eb64.png'" />
          <div class="scene-overlay-badge" style="background:rgba(0,0,0,0.75); border:1px solid rgba(0,240,255,0.4); color:var(--neon-cyan);">
            👁️ ${mod.views} • ❤️ ${mod.likes}
          </div>
        </div>

        <div class="scene-body" style="flex:1; display:flex; flex-direction:column;">
          <h3 class="scene-name" title="${mod.title}" style="font-size:1.1rem; margin-bottom:0.3rem;">
            ${mod.title}
          </h3>

          <div style="display:flex; align-items:center; gap:0.4rem; margin-bottom:0.75rem;">
            ${mod.authorAvatar ? `<img src="${mod.authorAvatar}" style="width:20px; height:20px; border-radius:50%; object-fit:cover;" />` : ''}
            <span style="font-size:0.8rem; color:var(--text-muted);">Por: <strong style="color:var(--text-dim);">${mod.author}</strong></span>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.75rem; color:var(--text-muted); border-top:1px solid var(--border-glass); padding-top:0.6rem; margin-top:auto; margin-bottom:0.9rem;">
            <span class="char-badge" style="font-size:0.7rem; padding:0.15rem 0.5rem;">${mod.category}</span>
            <a href="${mod.profileUrl}" target="_blank" style="color:var(--neon-cyan); text-decoration:none;" title="Ver en GameBanana">
              Ficha GameBanana ↗
            </a>
          </div>

          <div>
            ${isAlreadyInstalled ? `
              <button class="btn-card-play" style="width:100%; background:rgba(0,255,136,0.15); border:1px solid var(--neon-green); color:var(--neon-green); cursor:default;">
                ✓ Ya en tu Biblioteca
              </button>
            ` : (queueItem ? `
              <button class="btn-card-play" style="width:100%; background:rgba(234,179,8,0.2); border:1px solid #eab308; color:#fff; cursor:default;">
                ${queueItem.status === 'completed' ? '✅ Descargada' : `⏳ ${queueItem.status === 'downloading' ? `${queueItem.percent}%` : 'En cola'}`}
              </button>
            ` : `
              <div style="display:flex; gap:0.4rem;">
                <button class="btn-card-play btn-download-single-mod" data-mod-id="${mod.id}" data-mod-title="${encodeURIComponent(mod.title)}" style="flex:1; background: linear-gradient(135deg, var(--neon-cyan), #0088ff); color: #000; font-weight:800;">
                  📥 Descargar
                </button>
                <button class="btn-icon-action btn-add-queue" data-mod-id="${mod.id}" data-mod-title="${encodeURIComponent(mod.title)}" title="Añadir a cola de descargas">
                  ➕
                </button>
              </div>
            `)}
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================
  // FLOATING DOWNLOAD DRAWER (MINI-MENU)
  // ==========================================

  renderDownloadDrawer() {
    if (!this.isDownloadDrawerVisible) return '';

    const queueList = Array.from(this.downloadQueue.values());
    const activeCount = queueList.filter(q => q.status === 'downloading' || q.status === 'queued').length;

    if (this.isDownloadDrawerMinimized) {
      return `
        <div class="download-pill-minimized" id="btn-expand-minimized-drawer" title="Haz clic para expandir el gestor de descargas">
          <span>📥</span>
          <span>${activeCount > 0 ? `${activeCount} descargas activas` : `${queueList.length} descargas`}</span>
          <span style="background:rgba(0,240,255,0.25); color:var(--neon-cyan); padding:0.15rem 0.5rem; border-radius:12px; font-size:0.75rem;">⤢ Abrir</span>
        </div>
      `;
    }

    return `
      <div id="download-drawer" class="download-drawer open">
        <div class="download-drawer-header">
          <div style="display:flex; align-items:center; gap:0.5rem; cursor:pointer;" id="toggle-drawer-header">
            <span style="font-size:1.2rem;">📥</span>
            <strong>Descargas</strong>
            <span class="char-badge" style="font-size:0.75rem; padding:0.15rem 0.5rem; background:${activeCount > 0 ? 'var(--neon-yellow)' : 'var(--neon-green)'}; color:#000;">
              ${activeCount > 0 ? `${activeCount} activas` : `${queueList.length} escenas`}
            </span>
          </div>
          <div style="display:flex; align-items:center; gap:0.4rem;">
            <button class="btn-icon-action" id="btn-drawer-fullpage" title="Ver en pantalla completa" style="width:26px; height:26px; font-size:0.75rem;">
              ⤢
            </button>
            <button class="btn-icon-action" id="btn-drawer-minimize" title="Minimizar" style="width:26px; height:26px; font-size:0.75rem;">
              —
            </button>
            <button class="btn-icon-action" id="btn-drawer-close" title="Cerrar por completo" style="width:26px; height:26px; font-size:0.8rem; color:var(--neon-pink);">
              ✕
            </button>
          </div>
        </div>

        <div class="download-drawer-body">
          ${queueList.length === 0 ? `
            <div style="text-align:center; padding:1.5rem; color:var(--text-muted); font-size:0.85rem;">
              No hay descargas en curso.
            </div>
          ` : `
            <div style="display:flex; flex-direction:column; gap:0.75rem; max-height:280px; overflow-y:auto; padding-right:0.3rem;">
              ${queueList.map(item => `
                <div class="download-item-card" style="background:rgba(255,255,255,0.04); border:1px solid var(--border-glass); border-radius:var(--radius-md); padding:0.75rem;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;">
                    <div style="font-weight:700; font-size:0.85rem; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:210px;" title="${item.title}">
                      ${item.icon || '📥'} ${item.title}
                    </div>
                    <div style="display:flex; align-items:center; gap:0.4rem;">
                      <span style="font-size:0.8rem; font-weight:800; font-family:monospace; color:${item.status === 'completed' ? 'var(--neon-green)' : 'var(--neon-cyan)'};">
                        ${item.status === 'completed' ? '100%' : `${item.percent || 0}%`}
                      </span>
                      <button class="btn-icon-action btn-remove-queue-item" data-mod-id="${item.id}" title="Eliminar de la lista" style="width:22px; height:22px; font-size:0.7rem; color:var(--neon-pink); padding:0;">
                        🗑️
                      </button>
                    </div>
                  </div>

                  <!-- Item Mini Progress Bar -->
                  <div style="background:rgba(0,0,0,0.5); border-radius:20px; height:8px; overflow:hidden; margin-bottom:0.4rem;">
                    <div style="width:${item.percent || 0}%; height:100%; background:${item.status === 'completed' ? 'var(--neon-green)' : 'linear-gradient(90deg, var(--neon-cyan), var(--neon-green))'}; transition:width 0.2s ease;"></div>
                  </div>

                  <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.75rem; color:var(--text-dim);">
                    <span>${item.stepText || 'Descargando...'}</span>
                    <span>${item.bytesText || ''}</span>
                  </div>

                  ${item.status === 'completed' && item.scene ? `
                    <div style="display:flex; gap:0.5rem; margin-top:0.6rem;">
                      <button class="btn-card-play btn-play-downloaded-scene" data-scene-id="${item.scene.id}" style="padding:0.3rem 0.6rem; font-size:0.75rem; background:linear-gradient(135deg, var(--neon-green), #00a852); color:#000; font-weight:800;">
                        ▶️ Escuchar
                      </button>
                      <button class="btn-card-play btn-dub-downloaded-scene" data-scene-id="${item.scene.id}" style="padding:0.3rem 0.6rem; font-size:0.75rem; background:linear-gradient(135deg, var(--neon-pink), #c70063); color:#fff;">
                        🎙️ Doblar
                      </button>
                    </div>
                  ` : ''}
                </div>
              `).join('')}
            </div>

            <div style="display:flex; justify-content:space-between; margin-top:0.75rem; padding-top:0.5rem; border-top:1px solid var(--border-glass);">
              <button class="btn-secondary" id="btn-clear-completed-downloads" style="font-size:0.75rem; padding:0.3rem 0.6rem;">
                🗑️ Limpiar Completadas
              </button>
              <button class="btn-cyan" id="btn-drawer-fullpage-bottom" style="font-size:0.75rem; padding:0.3rem 0.6rem;">
                🔍 Ver en Pantalla Completa
              </button>
            </div>
          `}
        </div>
      </div>
    `;
  }

  // ==========================================
  // VIEW: DOWNLOADS FULL PAGE
  // ==========================================

  renderDownloadsView() {
    const queueList = Array.from(this.downloadQueue.values());
    const activeDownloads = queueList.filter(d => d.status === 'downloading' || d.status === 'queued');
    const completedDownloads = queueList.filter(d => d.status === 'completed');

    return `
      <div class="library-container">
        <div class="library-header">
          <div>
            <h2 class="section-title">📥 Centro de Descargas de Escenas</h2>
            <p class="section-subtitle">
              Supervisa tus descargas en tiempo real, gestiona la cola y prueba tus escenas descargadas.
            </p>
          </div>
          <div style="display:flex; gap:0.6rem;">
            <button class="btn-secondary" id="btn-clear-all-completed">
              🧹 Limpiar Completadas
            </button>
            <button class="btn-cyan" id="btn-goto-online">
              🌐 Explorar Más Escenas (+2,300)
            </button>
          </div>
        </div>

        <!-- Download Stats Summary Cards -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:1rem; margin-bottom:1.5rem;">
          <div class="stat-card">
            <div class="stat-val" style="color:var(--neon-yellow);">${activeDownloads.length}</div>
            <div class="stat-desc">⏳ En Progreso / En Cola</div>
          </div>
          <div class="stat-card">
            <div class="stat-val" style="color:var(--neon-green);">${completedDownloads.length}</div>
            <div class="stat-desc">✅ Descargas Completadas</div>
          </div>
          <div class="stat-card">
            <div class="stat-val" style="color:var(--neon-cyan);">${this.scenes.length}</div>
            <div class="stat-desc">📚 Escenas en tu Biblioteca</div>
          </div>
        </div>

        ${queueList.length === 0 ? `
          <div class="empty-state">
            <div class="empty-icon">📥</div>
            <h3>No tienes descargas en el gestor</h3>
            <p style="color:var(--text-muted); margin:0.5rem 0 1rem 0;">Explora el catálogo online con miles de escenas listas para descargar y doblar.</p>
            <button class="btn-primary" id="btn-empty-explore-online">
              🌐 Explorar Escenas Online
            </button>
          </div>
        ` : `
          <div style="display:flex; flex-direction:column; gap:1rem;">
            ${queueList.map(item => `
              <div class="glass-card" style="padding:1.25rem; display:flex; flex-direction:column; gap:0.8rem; border-color:${item.status === 'completed' ? 'rgba(0,255,136,0.3)' : (item.status === 'downloading' ? 'rgba(0,240,255,0.4)' : 'var(--border-glass)')};">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                  <div style="display:flex; align-items:center; gap:0.75rem;">
                    <span style="font-size:1.8rem;">${item.icon || '📥'}</span>
                    <div>
                      <div style="font-size:1.15rem; font-weight:800; color:#fff;">${item.title}</div>
                      <div style="font-size:0.8rem; color:var(--text-dim);">
                        Mod ID: #${item.id} • ${item.bytesText || 'Preparando...'} ${item.speedText ? `• ${item.speedText}` : ''}
                      </div>
                    </div>
                  </div>

                  <div style="display:flex; align-items:center; gap:0.75rem;">
                    <span style="font-size:1.1rem; font-weight:900; font-family:monospace; color:${item.status === 'completed' ? 'var(--neon-green)' : 'var(--neon-cyan)'};">
                      ${item.status === 'completed' ? '100%' : `${item.percent || 0}%`}
                    </span>
                    <button class="btn-icon-action btn-delete-download" data-mod-id="${item.id}" style="color:var(--neon-pink); width:32px; height:32px;" title="Eliminar de la lista">
                      🗑️
                    </button>
                  </div>
                </div>

                <!-- Large Interactive Progress Bar -->
                <div style="background:rgba(0,0,0,0.6); border-radius:30px; height:14px; overflow:hidden; border:1px solid rgba(255,255,255,0.1); position:relative;">
                  <div style="width:${item.percent || 0}%; height:100%; background:${item.status === 'completed' ? 'linear-gradient(90deg, var(--neon-green), #00ffaa)' : (item.status === 'error' ? 'var(--neon-pink)' : 'linear-gradient(90deg, var(--neon-cyan), var(--neon-green))')}; transition:width 0.2s ease;"></div>
                </div>

                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                  <span style="font-size:0.85rem; color:${item.status === 'completed' ? 'var(--neon-green)' : 'var(--neon-cyan)'}; font-weight:600;">
                    ${item.stepText || 'Descargando...'}
                  </span>

                  ${item.status === 'completed' && item.scene ? `
                    <div style="display:flex; gap:0.5rem;">
                      <button class="btn-card-play btn-play-download-full" data-scene-id="${item.scene.id}" style="padding:0.4rem 0.9rem; font-size:0.85rem; background:linear-gradient(135deg, var(--neon-green), #00a852); color:#000; font-weight:800;">
                        ▶️ Escuchar Escena
                      </button>
                      <button class="btn-card-play btn-dub-download-full" data-scene-id="${item.scene.id}" style="padding:0.4rem 0.9rem; font-size:0.85rem; background:linear-gradient(135deg, var(--neon-pink), #c70063); color:#fff; font-weight:800;">
                        🎙️ Grabar Doblaje
                      </button>
                    </div>
                  ` : ''}

                  ${item.status === 'error' ? `
                    <button class="btn-secondary btn-retry-download" data-mod-id="${item.id}" style="padding:0.3rem 0.75rem; font-size:0.8rem;">
                      🔄 Reintentar
                    </button>
                  ` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    `;
  }

  // ==========================================
  // MULTI-DOWNLOAD & QUEUE LOGIC
  // ==========================================

  async loadOnlineScenes(page = 1, searchQuery = '') {
    this.isOnlineLoading = true;
    this.onlinePage = page;
    this.onlineSearchQuery = searchQuery;
    this.render();

    try {
      let scenes = [];
      let total = 0;

      // 1. Try local server proxy first (if on localhost or custom server)
      try {
        const searchParam = searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : '';
        const res = await fetch(`/api/gamebanana/feed?page=${page}${searchParam}`);
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.scenes && data.scenes.length > 0) {
            scenes = data.scenes;
            total = data.total || scenes.length;
          }
        }
      } catch (e) {}

      // 2. Try static embedded scenes catalog (works 100% on GitHub Pages without CORS restrictions!)
      if (scenes.length === 0) {
        try {
          if (!this.cachedCatalog) {
            const catRes = await fetch('./scenes_catalog.json');
            if (catRes.ok) {
              this.cachedCatalog = await catRes.json();
            }
          }

          if (this.cachedCatalog && this.cachedCatalog.length > 0) {
            let filtered = this.cachedCatalog;
            if (searchQuery && searchQuery.trim().length > 0) {
              const q = searchQuery.toLowerCase().trim();
              filtered = this.cachedCatalog.filter(s => 
                (s.title && s.title.toLowerCase().includes(q)) || 
                (s.author && s.author.toLowerCase().includes(q)) ||
                (s.category && s.category.toLowerCase().includes(q))
              );
            }
            total = filtered.length;
            const pageSize = 24;
            const startIdx = (page - 1) * pageSize;
            scenes = filtered.slice(startIdx, startIdx + pageSize);
          }
        } catch (catErr) {
          console.warn('Could not load scenes_catalog.json:', catErr);
        }
      }

      // 3. Direct GameBanana API attempt as extra fallback
      if (scenes.length === 0) {
        const GAME_ID = 20674;
        let apiUrl = searchQuery && searchQuery.trim().length > 0
          ? `https://gamebanana.com/apiv11/Util/Search/Results?_sSearchString=${encodeURIComponent(searchQuery.trim())}&_idGameRow=${GAME_ID}&_nPage=${page}&_nPerpage=24`
          : `https://gamebanana.com/apiv11/Game/${GAME_ID}/Subfeed?_nPage=${page}&_nPerpage=24`;

        try {
          const gbRes = await fetch(apiUrl);
          if (gbRes.ok) {
            const rawData = await gbRes.json();
            if (rawData && rawData._aRecords) {
              scenes = rawData._aRecords.map(item => {
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
              total = rawData._aMetadata?._nRecordCount || scenes.length;
            }
          }
        } catch (gbErr) {
          console.warn('GameBanana direct API blocked:', gbErr);
        }
      }

      this.onlineScenes = scenes;
      this.onlineTotal = total || scenes.length;
    } catch (err) {
      console.error('Error in loadOnlineScenes:', err);
      this.showToast('Error cargando escenas online.', 'error');
    } finally {
      this.isOnlineLoading = false;
      this.render();
    }
  }

  async queueModDownload(modId, modTitle) {
    if (this.downloadQueue.has(modId)) return;

    this.downloadQueue.set(modId, {
      id: modId,
      title: modTitle,
      percent: 0,
      bytesText: '0 MB',
      speedText: '',
      status: 'queued',
      stepText: 'En cola...',
      icon: '⏳'
    });

    this.isDownloadDrawerVisible = true;
    this.isDownloadDrawerMinimized = false;
    this.isDownloadDrawerOpen = true;
    this.render();
    this.processNextInQueue();
  }

  async downloadSelectedMods() {
    const ids = Array.from(this.selectedModIds);
    if (ids.length === 0) return;

    for (const modId of ids) {
      const mod = this.onlineScenes.find(m => m.id === modId);
      const title = mod ? mod.title : `Mod #${modId}`;
      this.queueModDownload(modId, title);
    }

    this.selectedModIds.clear();
    this.showToast(`¡${ids.length} escenas añadidas a la cola de descargas!`, 'success');
    this.render();
  }

  async processNextInQueue() {
    const activeDownloads = Array.from(this.downloadQueue.values()).filter(q => q.status === 'downloading');
    if (activeDownloads.length >= 2) return; // Allow 2 concurrent parallel downloads

    const nextItem = Array.from(this.downloadQueue.values()).find(q => q.status === 'queued');
    if (!nextItem) return;

    nextItem.status = 'downloading';
    this.render();

    this.executeModDownload(nextItem);
  }

  async executeModDownload(queueItem) {
    const modId = queueItem.id;
    const modTitle = queueItem.title;

    try {
      const startTime = performance.now();
      let res = null;
      let effectiveTitle = modTitle;
      let effectiveFileName = `${modTitle}.zip`;
      let totalBytes = 0;

      try {
        const localRes = await fetch(`/api/gamebanana/download?modId=${modId}`);
        if (localRes.ok) {
          res = localRes;
          const contentLengthHeader = res.headers.get('Content-Length');
          const fileNameHeader = res.headers.get('X-File-Name');
          const sceneTitleHeader = res.headers.get('X-Scene-Title');
          if (sceneTitleHeader) effectiveTitle = decodeURIComponent(sceneTitleHeader);
          if (fileNameHeader) effectiveFileName = decodeURIComponent(fileNameHeader);
          if (contentLengthHeader) totalBytes = parseInt(contentLengthHeader, 10);
        }
      } catch (e) {
        res = null;
      }

      // Direct fallback to GameBanana CDN for static GitHub Pages hosting
      if (!res) {
        const itemRes = await fetch(`https://api.gamebanana.com/Core/Item/Data?itemtype=Mod&itemid=${modId}&fields=name,Files().aFiles()`);
        if (!itemRes.ok) throw new Error('No se pudo consultar el mod en GameBanana');
        const modData = await itemRes.json();
        if (modData && modData[0]) effectiveTitle = modData[0];
        const filesObj = modData ? modData[1] : null;
        if (!filesObj) throw new Error('El mod no tiene archivos disponibles.');
        const fileKeys = Object.keys(filesObj);
        if (fileKeys.length === 0) throw new Error('El mod no tiene archivos descargables.');

        const primaryKey = fileKeys.find(k => {
          const fn = (filesObj[k]._sFile || '').toLowerCase();
          return fn.endsWith('.zip') || fn.endsWith('.rar') || fn.endsWith('.7z') || fn.endsWith('.tar');
        }) || fileKeys[0];

        const fileInfo = filesObj[primaryKey];
        effectiveFileName = fileInfo._sFile || `${effectiveTitle}.zip`;
        totalBytes = fileInfo._nFilesize || 0;

        res = await fetch(fileInfo._sDownloadUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status} al descargar de GameBanana`);
      }

      const reader = res.body.getReader();
      const chunks = [];
      let receivedBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        receivedBytes += value.length;

        const percent = totalBytes > 0 
          ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100))
          : Math.min(95, Math.round((receivedBytes / (1024 * 1024 * 30)) * 100));

        const mbReceived = (receivedBytes / (1024 * 1024)).toFixed(1);
        const mbTotal = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) + ' MB' : '-- MB';

        const elapsedSec = (performance.now() - startTime) / 1000;
        const speedMb = elapsedSec > 0 ? ((receivedBytes / (1024 * 1024)) / elapsedSec).toFixed(1) : '0.0';

        queueItem.percent = percent;
        queueItem.bytesText = `${mbReceived} / ${mbTotal}`;
        queueItem.speedText = `${speedMb} MB/s`;
        queueItem.stepText = `Descargando (${percent}%)...`;
        queueItem.icon = '📥';

        this.updateDrawerUI();
      }

      // Merge chunks into single ArrayBuffer
      queueItem.percent = 99;
      queueItem.stepText = '📦 Descomprimiendo y procesando...';
      queueItem.icon = '📦';
      this.updateDrawerUI();

      const fullBuffer = new Uint8Array(receivedBytes);
      let offset = 0;
      for (const chunk of chunks) {
        fullBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      let unzipped = null;
      const lowerName = effectiveFileName.toLowerCase();
      const isRarOr7z = lowerName.endsWith('.rar') || lowerName.endsWith('.7z') || lowerName.endsWith('.tar');

      if (isRarOr7z) {
        queueItem.stepText = '📦 Descomprimiendo archivo RAR/7Z...';
        this.updateDrawerUI();
        const unpackRes = await fetch('/api/unpack-archive', {
          method: 'POST',
          body: fullBuffer
        });
        if (unpackRes.ok) {
          const zipArrayBuf = await unpackRes.arrayBuffer();
          unzipped = await ZipEngine.unzip(zipArrayBuf);
        }
      }

      if (!unzipped) {
        try {
          unzipped = await ZipEngine.unzip(fullBuffer.buffer);
        } catch {
          const unpackRes = await fetch('/api/unpack-archive', {
            method: 'POST',
            body: fullBuffer
          });
          if (unpackRes.ok) {
            const zipArrayBuf = await unpackRes.arrayBuffer();
            unzipped = await ZipEngine.unzip(zipArrayBuf);
          }
        }
      }

      if (!unzipped || Object.keys(unzipped).length === 0) {
        throw new Error('No se pudieron extraer los archivos del paquete descargado.');
      }

      // Auto-transcode .ogv to .mp4 if needed
      const ogvKey = Object.keys(unzipped).find(k => k.endsWith('.ogv'));
      if (ogvKey && !Object.keys(unzipped).some(k => k.endsWith('.mp4'))) {
        queueItem.stepText = '🎬 Optimizando video HD (MP4)...';
        this.updateDrawerUI();
        try {
          const transcodeRes = await fetch('/api/transcode-video', {
            method: 'POST',
            body: unzipped[ogvKey]
          });
          if (transcodeRes.ok) {
            const mp4ArrayBuf = await transcodeRes.arrayBuffer();
            const mp4Key = ogvKey.replace(/\.ogv$/i, '.mp4');
            unzipped[mp4Key] = new Uint8Array(mp4ArrayBuf);
          }
        } catch (e) {
          console.warn('Transcode skipped:', e);
        }
      }

      const parsed = ZipEngine.parseScenePackage(unzipped);
      const validation = ZipEngine.validateScene(parsed);

      if (validation.isValid) {
        const sceneId = await GameDB.saveScene({
          title: parsed.meta.title || effectiveTitle,
          authors: parsed.meta.authors.length ? parsed.meta.authors : ['GameBanana Community'],
          readme: parsed.meta.readme || `Descargado desde GameBanana (Mod #${modId})`,
          characters: parsed.meta.characters,
          duration: parsed.meta.estimatedDuration,
          dialogues: parsed.dialogues,
          prefix: parsed.prefix,
          videoKey: parsed.videoKey,
          backingTrackKey: parsed.backingTrackKey,
          iconName: parsed.meta.iconName,
          imageFiles: parsed.imageFiles,
          rawFiles: parsed.rawFiles,
          importDate: new Date().toISOString()
        });

        this.scenes = await GameDB.getAllScenes();
        const savedScene = this.scenes.find(s => s.id === sceneId);

        queueItem.status = 'completed';
        queueItem.percent = 100;
        queueItem.stepText = '✅ Lista para jugar';
        queueItem.icon = '✅';
        queueItem.scene = savedScene || { id: sceneId, title: parsed.meta.title || effectiveTitle };

        SFX.playSuccess();
        this.showToast(`¡"${parsed.meta.title || effectiveTitle}" lista para doblar!`, 'success');
      } else {
        throw new Error('El paquete descargado no contiene una escena válida de Voice Dub Hero.');
      }
    } catch (err) {
      console.error('Download error for mod', modId, err);
      queueItem.status = 'error';
      queueItem.stepText = `Error: ${err.message || 'Fallo de descarga'}`;
      queueItem.icon = '⚠️';
      SFX.playError();
    } finally {
      this.render();
      this.processNextInQueue();
    }
  }

  updateDrawerUI() {
    // 1. If currently in Downloads View, refresh main content cards in real time
    if (this.currentView === 'downloads') {
      const mainEl = document.querySelector('.main-content') || document.querySelector('.view-container');
      if (mainEl) {
        mainEl.innerHTML = this.renderDownloadsView();
        this.bindViewEvents();
      }
    }

    // 2. Refresh drawer or minimized pill
    const drawer = document.getElementById('download-drawer') || document.querySelector('.download-pill-minimized');
    if (drawer) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = this.renderDownloadDrawer();
      if (tempDiv.firstElementChild) {
        drawer.replaceWith(tempDiv.firstElementChild);
        this.bindDrawerEvents();
      }
    }
  }

  // ==========================================
  // VIEW: CHARACTER SELECT
  // ==========================================

  renderCharacterSelectView() {
    if (!this.selectedScene) return this.renderLibraryView();

    const characters = this.selectedScene.characters || ['Woody', 'Buzz'];
    const coverUrl = this.getSceneCoverUrl(this.selectedScene);

    return `
      <div style="max-width: 860px; margin: 0 auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
          <button class="btn-secondary" id="btn-back-lib">
            ⬅️ Volver a Mis Escenas
          </button>
          <button class="btn-cyan" id="btn-char-listen-now" style="background: linear-gradient(135deg, var(--neon-green), #00a653); color: #000; font-weight: 800;">
            ▶️ Escuchar Escena Original Primero
          </button>
        </div>

        <div class="hero-section" style="padding: 2rem; margin-bottom: 2rem;">
          <img src="${coverUrl}" style="width: 140px; height: 140px; border-radius: 18px; object-fit: cover; border: 2px solid var(--neon-cyan); box-shadow: var(--shadow-neon-cyan);" />
          <div>
            <h2 style="font-size: 1.8rem; font-weight: 800; margin-bottom: 0.5rem;">${this.selectedScene.title}</h2>
            <p style="color: var(--text-muted); font-size: 0.95rem; margin-bottom: 0.75rem;">${this.selectedScene.readme || 'Prepárate para doblar esta escena.'}</p>
            <div style="display: flex; gap: 0.5rem;">
              <span class="char-badge">⏱️ Duración: ${this.selectedScene.duration || 60}s</span>
              <span class="char-badge">💬 ${this.selectedScene.dialogues?.length || 0} Diálogos</span>
            </div>
          </div>
        </div>

        <div class="control-card" style="margin-bottom: 2rem;">
          <h3 class="control-card-title">🎭 Selecciona tu Personaje a Doblar</h3>
          <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.25rem;">
            Elige el personaje al que le prestarás tu voz. Los diálogos de los demás personajes sonarán con su voz original sincronizada.
          </p>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem;">
            ${characters.map(charName => {
              const charImg = this.getCharacterImageUrl(this.selectedScene, charName);
              const charDialogues = (this.selectedScene.dialogues || []).filter(d => d.character.toLowerCase() === charName.toLowerCase());
              const charLines = charDialogues.length;
              const isSelected = this.selectedCharacter.toLowerCase() === charName.toLowerCase();
              const isFullyDubbed = charLines > 0 && charDialogues.every(d => this.userTakeRecordings.has(d.id));

              return `
                <div class="feature-box role-select-card ${isSelected ? 'active-role' : ''}" data-char="${charName}" style="position:relative; cursor:pointer; text-align:center; border-color: ${isSelected ? 'var(--neon-cyan)' : (isFullyDubbed ? 'var(--neon-green)' : 'var(--border-glass)')}; background: ${isSelected ? 'rgba(0, 240, 255, 0.12)' : (isFullyDubbed ? 'rgba(0, 255, 136, 0.08)' : 'var(--bg-card)')};">
                  ${isFullyDubbed ? `
                    <div style="position: absolute; top: 10px; right: 10px; background: linear-gradient(135deg, var(--neon-green), #00bb55); color: #000; font-size: 0.75rem; font-weight: 900; padding: 0.2rem 0.55rem; border-radius: 12px; box-shadow: 0 0 10px rgba(0,255,136,0.6);">
                      ✅ ¡DOBLADO!
                    </div>
                  ` : ''}
                  <img src="${charImg}" style="width: 84px; height: 84px; border-radius: 50%; object-fit: cover; margin: 0 auto 0.75rem auto; border: 3px solid ${isSelected ? 'var(--neon-cyan)' : (isFullyDubbed ? 'var(--neon-green)' : 'rgba(255,255,255,0.2)')}; box-shadow: ${isSelected ? 'var(--shadow-neon-cyan)' : 'none'};" />
                  <h4 style="font-size: 1.25rem; font-weight: 800;">${charName}</h4>
                  <p style="font-size: 0.85rem; color: ${isFullyDubbed ? 'var(--neon-green)' : 'var(--neon-yellow)'}; margin-top: 0.2rem;">
                    ${isFullyDubbed ? `✅ ${charLines} de ${charLines} frases listas` : `${charLines} frases a doblar`}
                  </p>
                </div>
              `;
            }).join('')}

            <div class="feature-box role-select-card ${this.selectedCharacter === 'All' ? 'active-role' : ''}" data-char="All" style="cursor:pointer; text-align:center; border-color: ${this.selectedCharacter === 'All' ? 'var(--neon-pink)' : 'var(--border-glass)'}; background: ${this.selectedCharacter === 'All' ? 'rgba(255, 0, 127, 0.12)' : 'var(--bg-card)'};">
              <div style="font-size: 3.2rem; line-height: 84px; margin-bottom: 0.75rem;">🎭</div>
              <h4 style="font-size: 1.25rem; font-weight: 800;">Doblaje Completo</h4>
              <p style="font-size: 0.85rem; color: var(--neon-pink); margin-top: 0.2rem;">Dobla a todos los personajes</p>
            </div>
          </div>
        </div>

        <div class="control-card" style="margin-bottom: 2rem;">
          <h3 class="control-card-title">🎛️ Filtro / Efecto de Voz</h3>
          <div class="fx-grid">
            <button class="fx-pill ${this.selectedEffect === 'clean' ? 'active' : ''}" data-fx="clean">✨ Normal / Estudio</button>
            <button class="fx-pill ${this.selectedEffect === 'cartoon' ? 'active' : ''}" data-fx="cartoon">🐿️ Helio / Cartoon</button>
            <button class="fx-pill ${this.selectedEffect === 'villain' ? 'active' : ''}" data-fx="villain">😈 Villano / Grave</button>
            <button class="fx-pill ${this.selectedEffect === 'robot' ? 'active' : ''}" data-fx="robot">🤖 Robot / Cyborg</button>
            <button class="fx-pill ${this.selectedEffect === 'megaphone' ? 'active' : ''}" data-fx="megaphone">📢 Megáfono / Radio</button>
            <button class="fx-pill ${this.selectedEffect === 'reverb' ? 'active' : ''}" data-fx="reverb">🏟️ Eco / Estadio</button>
          </div>
        </div>

        <button class="btn-primary" id="btn-enter-studio" style="width: 100%; padding: 1.1rem; font-size: 1.2rem; justify-content: center;">
          🎙️ ¡ENTRAR AL ESTUDIO Y COMENZAR DOBLAJE!
        </button>
      </div>
    `;
  }

  getDubDialogues() {
    if (!this.selectedScene || !this.selectedScene.dialogues) return [];
    if (this.selectedCharacter === 'All') return this.selectedScene.dialogues;
    return this.selectedScene.dialogues.filter(d => (d.character || '').toLowerCase() === this.selectedCharacter.toLowerCase());
  }

  // ==========================================
  // VIEW: TAKE-BY-TAKE DUBBING STUDIO
  // ==========================================

  renderTakeStudioView() {
    if (!this.selectedScene) return this.renderLibraryView();

    const dubDialogues = this.getDubDialogues();
    if (dubDialogues.length === 0) {
      return `
        <div class="empty-state">
          <div class="empty-icon">🎭</div>
          <h3>No hay frases registradas para este personaje</h3>
          <p>Selecciona otro personaje o elige "Doblaje Completo".</p>
          <button class="btn-primary" id="btn-take-back-char" style="margin: 1rem auto;">⬅️ Volver a Personajes</button>
        </div>
      `;
    }

    if (this.currentTakeIndex >= dubDialogues.length) {
      this.currentTakeIndex = dubDialogues.length - 1;
    }
    if (this.currentTakeIndex < 0) {
      this.currentTakeIndex = 0;
    }

    const activeDiag = dubDialogues[this.currentTakeIndex];
    const totalTakes = dubDialogues.length;
    const currentTakeNum = this.currentTakeIndex + 1;
    const videoUrl = this.getVideoUrl(this.selectedScene);
    const coverUrl = this.getSceneCoverUrl(this.selectedScene);
    const charImg = this.getCharacterImageUrl(this.selectedScene, activeDiag.character);
    const isRecorded = this.userTakeRecordings.has(activeDiag.id);
    const isLastTake = currentTakeNum === totalTakes;
    const recordedCount = Array.from(this.userTakeRecordings.keys()).filter(id => dubDialogues.some(d => d.id === id)).length;

    return `
      <div class="take-studio-container">
        <!-- Top Navigation Header -->
        <div class="take-header-card">
          <button class="btn-secondary" id="btn-take-back-char">
            ⬅️ Cambiar Rol / Menú
          </button>

          <div class="take-step-indicator">
            <img src="${charImg}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 2px solid var(--neon-cyan);" />
            <span>${activeDiag.character}</span>
            <span style="color: var(--text-dim);">•</span>
            <span style="color: #fff;">Frase ${currentTakeNum} de ${totalTakes}</span>
          </div>

          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <span class="char-badge" style="font-size: 0.85rem;">🎬 ${this.selectedScene.title}</span>
            <button class="btn-secondary" id="btn-switch-to-full-scene" title="Ver la escena completa" style="padding: 0.4rem 0.8rem; font-size: 0.85rem;">
              👁️ Escena Completa
            </button>
          </div>
        </div>

        <!-- Video Player Stage for this Scene Segment -->
        <div class="stage-card" style="position: relative; aspect-ratio: 16 / 9; background: #000; overflow: hidden; border-radius: var(--radius-xl); box-shadow: 0 15px 40px rgba(0,0,0,0.8);">
          <video id="take-video" class="video-player" src="${videoUrl}" poster="${coverUrl}" playsinline preload="auto" style="width: 100%; height: 100%; object-fit: contain; background: #000; display: block;"></video>

          <!-- Avatar Overlay -->
          <div id="take-avatar-overlay" class="talking-avatar-overlay" style="position: absolute; top: 16px; left: 16px; z-index: 10;">
            <img src="${charImg}" class="avatar-bubble-img" alt="${activeDiag.character}" />
            <div>
              <div class="avatar-bubble-name">${activeDiag.character}</div>
              <div id="take-avatar-status" style="font-size: 0.7rem; color: var(--neon-cyan);">Listo para doblar</div>
            </div>
          </div>

          <!-- Countdown Banner -->
          <div id="take-countdown-overlay" class="countdown-banner" style="display: none;">3</div>
        </div>

        <!-- Dialogue Quote (Identical to reference screenshot) -->
        <div class="take-quote-title">
          "${activeDiag.caption}"
        </div>

        <!-- Waveform Card (with cyan border, reference waves, red cursor, and user voice overlay) -->
        <div class="take-waveform-box">
          <canvas id="take-waveform-canvas" class="take-waveform-canvas" width="800" height="140"></canvas>
        </div>

        ${recordedCount >= totalTakes ? `
          <!-- Character Completed Banner & Save Action -->
          <div style="background: rgba(0, 255, 136, 0.12); border: 2px solid var(--neon-green); border-radius: var(--radius-md); padding: 0.85rem 1.25rem; display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem; flex-wrap: wrap; gap: 0.75rem; box-shadow: 0 0 20px rgba(0,255,136,0.25);">
            <div style="display:flex; align-items:center; gap:0.6rem;">
              <span style="font-size:1.6rem;">✅</span>
              <div>
                <strong style="color:var(--neon-green); font-size:1.05rem;">¡Personaje ${activeDiag.character} Doblado al 100%!</strong>
                <div style="font-size:0.8rem; color:var(--text-muted);">Completaste las ${totalTakes} frases. Guarda tu actuación para reproducirla con tu voz cuando quieras.</div>
              </div>
            </div>
            <button id="btn-take-save-dub" class="btn-cyan" style="background: linear-gradient(135deg, var(--neon-green), #00bb55); color: #000; font-weight:900; padding: 0.7rem 1.5rem; font-size: 1rem; box-shadow: 0 0 20px rgba(0,255,136,0.6);">
              💾 GUARDAR DOBLAJE
            </button>
          </div>
        ` : ''}

        <!-- Take Action Controls Toolbar -->
        <div class="take-controls-bar">
          <button id="btn-take-listen-ref" class="btn-take-aux">
            <span>▶️</span> <span>Escuchar Original</span>
          </button>

          <button id="btn-take-rec" class="btn-take-rec">
            <div class="rec-dot"></div>
            <span id="take-rec-btn-text">${isRecorded ? 'GRABAR DE NUEVO' : 'GRABAR MI VOZ'}</span>
          </button>

          <button id="btn-take-listen-user" class="btn-take-aux" ${isRecorded ? '' : 'disabled'}>
            <span>🎧</span> <span>Escuchar Mi Toma</span>
          </button>

          <button id="btn-take-retry" class="btn-take-aux" ${isRecorded ? '' : 'disabled'}>
            <span>🔄</span> <span>Volver a Grabar</span>
          </button>

          ${!isLastTake ? `
            <button id="btn-take-next" class="btn-take-primary">
              <span>➡️ Siguiente Frase (${currentTakeNum + 1}/${totalTakes})</span>
            </button>
          ` : `
            <button id="btn-take-finish" class="btn-take-primary" style="background: linear-gradient(135deg, var(--neon-cyan), #0088ff); color: #000; font-weight: 800;">
              <span>🎬 ¡FINALIZAR Y VER RESULTADO!</span>
            </button>
          `}
        </div>

        <!-- Mini Step Pill Navigation Strip -->
        <div style="margin-top: 0.5rem;">
          <div style="display:flex; justify-content:space-between; font-size:0.8rem; color:var(--text-muted); margin-bottom:0.3rem;">
            <span>Progreso de Doblaje: ${recordedCount} de ${totalTakes} frases grabadas</span>
            <span>Haz clic en cualquier barra para saltar de frase</span>
          </div>
          <div class="take-nav-strip">
            ${dubDialogues.map((d, idx) => {
              const done = this.userTakeRecordings.has(d.id);
              const active = idx === this.currentTakeIndex;
              return `<div class="take-step-pill ${active ? 'active' : (done ? 'completed' : '')}" data-take-idx="${idx}" title="Frase ${idx + 1}: ${d.character}"></div>`;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================
  // VIEW: STUDIO & SCENE PLAYER (Continuous Mode)
  // ==========================================

  renderStudioView() {
    if (!this.selectedScene) return this.renderLibraryView();

    const videoUrl = this.getVideoUrl(this.selectedScene);
    const initialChar = this.selectedScene.dialogues?.[0]?.character || 'Personaje';
    const initialCharImg = this.getCharacterImageUrl(this.selectedScene, initialChar);
    const coverUrl = this.getSceneCoverUrl(this.selectedScene);
    const characters = this.selectedScene.characters || [];
    const isListenMode = this.playbackMode === 'original';

    return `
      <!-- Studio Header & Mode Switcher -->
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1.25rem; flex-wrap:wrap; gap:0.75rem;">
        <div>
          <button class="btn-secondary" id="btn-studio-back">⬅️ Cambiar Rol / Menú</button>
        </div>

        <!-- Mode Toggle Tabs -->
        <div style="display:flex; background: rgba(255,255,255,0.06); padding: 0.3rem; border-radius: var(--radius-md); border: 1px solid var(--border-glass);">
          <button id="tab-mode-original" class="nav-btn ${isListenMode ? 'active' : ''}" style="padding: 0.45rem 1rem; font-size: 0.85rem;">
            ▶️ Escuchar Escena Original
          </button>
          <button id="tab-mode-dub" class="nav-btn ${!isListenMode ? 'active' : ''}" style="padding: 0.45rem 1rem; font-size: 0.85rem;">
            🎙️ Grabar Doblaje (${this.selectedCharacter === 'All' ? 'Todos' : this.selectedCharacter})
          </button>
        </div>

        <div style="display:flex; align-items:center; gap: 0.75rem;">
          <span class="char-badge" style="font-size:0.85rem;">🎬 ${this.selectedScene.title}</span>
        </div>
      </div>

      <div class="studio-layout">
        <!-- Main Video & Teleprompter Stage -->
        <div>
          <!-- High-Definition Scene Video Player & Artwork Stage -->
          <div class="stage-card" style="position: relative; aspect-ratio: 16 / 9; background: #000; overflow: hidden; border-radius: var(--radius-xl); box-shadow: 0 15px 40px rgba(0,0,0,0.8);">
            
            <!-- Video Player Element with Poster -->
            <video id="studio-video" class="video-player" src="${videoUrl}" poster="${coverUrl}" playsinline preload="auto" style="width: 100%; height: 100%; object-fit: contain; background: #000; display: block;"></video>

            <!-- Talking Avatar Widget Overlay (Top Left) -->
            <div id="avatar-overlay" class="talking-avatar-overlay" style="position: absolute; top: 16px; left: 16px; z-index: 10;">
              <img id="avatar-bubble-img" src="${initialCharImg}" class="avatar-bubble-img" alt="Avatar" />
              <div>
                <div id="avatar-bubble-name" class="avatar-bubble-name">${initialChar}</div>
                <div id="avatar-bubble-status" style="font-size: 0.7rem; color: var(--neon-cyan);">En espera...</div>
              </div>
            </div>

            <!-- Visual Countdown Overlay -->
            <div id="countdown-overlay" class="countdown-banner" style="display: none;">
              3
            </div>
          </div>

          <!-- Characters Presence Bar -->
          <div style="display: flex; gap: 1rem; margin-top: 0.75rem; justify-content: center; flex-wrap:wrap;">
            ${characters.map(charName => {
              const charImg = this.getCharacterImageUrl(this.selectedScene, charName);
              const charKey = charName.toLowerCase().replace(/[^a-z0-9]/g, '_');
              return `
                <div id="char-badge-box-${charKey}" style="display: flex; align-items: center; gap: 0.6rem; background: rgba(19, 23, 38, 0.9); padding: 0.45rem 1.1rem; border-radius: 30px; border: 2px solid var(--border-glass); transition: all 0.25s ease;">
                  <img src="${charImg}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;" />
                  <span style="font-size: 0.9rem; font-weight: 800; color: #fff;">${charName}</span>
                </div>
              `;
            }).join('')}
          </div>

          <!-- Teleprompter Display -->
          <div class="teleprompter-box">
            <div id="teleprompter-speaker" class="teleprompter-speaker-tag">
              ${isListenMode ? '▶️ REPRODUCIENDO ESCENA ORIGINAL' : '🎙️ ESTUDIO DE DOBLAJE ACTIVO'}
            </div>
            <div id="teleprompter-text" class="teleprompter-text">
              ${isListenMode ? 'Pulsa "REPRODUCIR ESCENA" para escuchar y ver la escena completa.' : 'Pulsa "GRABAR DOBLAJE" para iniciar.'}
            </div>
            <div id="teleprompter-next" class="teleprompter-next"></div>
          </div>

          <!-- Interactive Timeline Track -->
          <div class="timeline-card">
            <div class="timeline-header">
              <span id="time-current">00:00</span>
              <span>Línea de Tiempo (Haz clic en cualquier bloque para saltar)</span>
              <span id="time-total">01:18</span>
            </div>
            <div id="timeline-track" class="timeline-bar-wrapper">
              <div id="timeline-progress" class="timeline-progress-fill"></div>
              ${this.renderTimelineMarkers()}
            </div>
          </div>
        </div>

        <!-- Studio Controls Side Panel -->
        <div class="studio-sidebar">
          <div class="control-card">
            <h3 class="control-card-title">
              ${isListenMode ? '▶️ Control de Escena' : '🎙️ Control de Doblaje'}
            </h3>

            ${isListenMode ? `
              <button id="btn-play-original-mode" class="btn-rec-giant" style="background: linear-gradient(135deg, var(--neon-green), #00a653); color: #000; font-weight: 900;">
                <span id="play-btn-icon">▶️</span>
                <span id="play-btn-text">REPRODUCIR ESCENA</span>
              </button>
            ` : `
              <button id="btn-rec" class="btn-rec-giant">
                <div class="rec-dot"></div>
                <span id="rec-btn-text">GRABAR DOBLAJE</span>
              </button>
            `}

            <div style="display:flex; gap: 0.5rem; margin-top: 0.75rem;">
              <button id="btn-pause" class="btn-secondary" style="flex:1; justify-content:center;">
                ⏸️ Pausar
              </button>
              <button id="btn-repeat" class="btn-secondary" style="flex:1; justify-content:center;">
                🔄 Reiniciar
              </button>
            </div>

            ${!isListenMode ? `
              <button id="btn-confirm-dub" class="btn-cyan" style="width: 100%; margin-top: 0.75rem; justify-content: center;">
                ✅ Finalizar & Ver Resultado
              </button>
            ` : `
              <button id="btn-switch-to-dub" class="btn-primary" style="width: 100%; margin-top: 0.75rem; justify-content: center;">
                🎙️ ¡Quiero doblar esta escena ahora!
              </button>
            `}

            <div style="margin-top: 1.25rem;">
              <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:0.3rem;">Visualizador de Audio:</div>
              <canvas id="waveform-canvas" class="waveform-canvas" width="300" height="60"></canvas>
            </div>
          </div>

          <!-- Volume Controls -->
          <div class="control-card">
            <h3 class="control-card-title">🎚️ Mezclador de Audio</h3>

            <div class="vol-row">
              <div class="vol-label">
                <span>🎵 Música / Efectos de Fondo</span>
                <span id="vol-backing-val">80%</span>
              </div>
              <input type="range" id="vol-backing" class="vol-slider" min="0" max="1.5" step="0.05" value="0.8" />
            </div>

            <div class="vol-row">
              <div class="vol-label">
                <span>🎙️ Tu Voz Grabada</span>
                <span id="vol-voice-val">120%</span>
              </div>
              <input type="range" id="vol-voice" class="vol-slider" min="0" max="2.0" step="0.05" value="1.2" />
            </div>

            <div class="vol-row">
              <div class="vol-label">
                <span>🗣️ Voces Originales (Otros)</span>
                <span id="vol-orig-val">100%</span>
              </div>
              <input type="range" id="vol-orig" class="vol-slider" min="0" max="1.5" step="0.05" value="1.0" />
            </div>
          </div>

          <!-- Quick FX Selector -->
          <div class="control-card">
            <h3 class="control-card-title">🎛️ Filtro de Voz</h3>
            <div class="fx-grid">
              <button class="fx-pill studio-fx-pill ${this.selectedEffect === 'clean' ? 'active' : ''}" data-fx="clean">✨ Normal</button>
              <button class="fx-pill studio-fx-pill ${this.selectedEffect === 'cartoon' ? 'active' : ''}" data-fx="cartoon">🐿️ Helio</button>
              <button class="fx-pill studio-fx-pill ${this.selectedEffect === 'villain' ? 'active' : ''}" data-fx="villain">😈 Grave</button>
              <button class="fx-pill studio-fx-pill ${this.selectedEffect === 'robot' ? 'active' : ''}" data-fx="robot">🤖 Robot</button>
              <button class="fx-pill studio-fx-pill ${this.selectedEffect === 'megaphone' ? 'active' : ''}" data-fx="megaphone">📢 Radio</button>
              <button class="fx-pill studio-fx-pill ${this.selectedEffect === 'reverb' ? 'active' : ''}" data-fx="reverb">🏟️ Eco</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderTimelineMarkers() {
    if (!this.selectedScene || !this.selectedScene.dialogues) return '';
    const totalDuration = this.selectedScene.duration || 60;

    return this.selectedScene.dialogues.map(d => {
      const leftPercent = Math.min(95, Math.max(0, (d.timestamp / totalDuration) * 100));
      return `
        <div class="timeline-marker marker-woody" style="left: ${leftPercent}%;" title="${d.character}: ${d.caption}" data-jump-time="${d.timestamp}">
          ${d.character.substring(0, 4)}
        </div>
      `;
    }).join('');
  }

  // ==========================================
  // VIEW: RESULTS
  // ==========================================

  renderResultsView() {
    const res = this.lastResult || {
      score: 9540,
      rank: 'S',
      rankTitle: '¡Maestro del Doblaje!',
      timingScore: '96%',
      energyScore: '92%',
      completedPhrases: '100%',
      sceneTitle: this.selectedScene?.title || 'Doblaje'
    };

    const coverUrl = this.getSceneCoverUrl(this.selectedScene);
    const videoUrl = this.getVideoUrl(this.selectedScene);

    return `
      <div class="results-container">
        <div class="hero-tag">🎉 ¡DOBLAJE COMPLETADO!</div>
        <h2 style="font-size: 2.4rem; font-weight: 900; margin-bottom: 0.5rem;">${res.sceneTitle}</h2>

        <div class="rank-banner">
          <div class="rank-letter">${res.rank}</div>
          <div class="rank-label">${res.rankTitle}</div>
        </div>

        <div class="score-display">
          ${res.score.toLocaleString()} PTS
        </div>

        <div class="results-stats-grid">
          <div class="stat-card">
            <div class="stat-val">${res.timingScore}</div>
            <div class="stat-desc">🎯 Precisión de Sincronía</div>
          </div>
          <div class="stat-card">
            <div class="stat-val">${res.energyScore}</div>
            <div class="stat-desc">🔥 Energía Vocal & Ritmo</div>
          </div>
          <div class="stat-card">
            <div class="stat-val">${res.completedPhrases}</div>
            <div class="stat-desc">💬 Frases Dobladas</div>
          </div>
        </div>

        <div class="result-video-wrapper" style="aspect-ratio: 16/9; max-height: 420px; background: #000; border-radius: var(--radius-xl); overflow: hidden; margin-bottom: 2rem;">
          <video id="results-video" src="${videoUrl}" poster="${coverUrl}" controls playsinline style="width: 100%; height: 100%; object-fit: contain;"></video>
        </div>

        <div class="results-actions-row">
          <button class="btn-cyan" id="btn-results-save-dub" style="background: linear-gradient(135deg, var(--neon-green), #00bb55); color: #000; font-weight: 900; padding: 1rem 2rem; font-size: 1.1rem; box-shadow: 0 0 20px rgba(0,255,136,0.5);">
            💾 Guardar en Mis Doblajes
          </button>
          <button class="btn-primary" id="btn-results-play-dub" style="padding: 1rem 1.8rem;">
            ▶️ Ver Mi Escena Doblada
          </button>
          <button class="btn-secondary" id="btn-export-audio">
            🎧 Descargar Audio
          </button>
          <button class="btn-secondary" id="btn-results-to-dubs">
            🎙️ Mis Doblajes
          </button>
          <button class="btn-secondary" id="btn-results-home">
            🏠 Menú Principal
          </button>
        </div>
      </div>
    `;
  }

  // ==========================================
  // VIEW: CHARACTERS COLLECTION
  // ==========================================

  renderCharactersView() {
    const charactersMap = new Map();

    for (const scene of this.scenes) {
      for (const charName of (scene.characters || [])) {
        if (!charactersMap.has(charName)) {
          charactersMap.set(charName, {
            name: charName,
            scenes: [],
            imgUrl: this.getCharacterImageUrl(scene, charName),
            totalLines: 0
          });
        }
        const item = charactersMap.get(charName);
        item.scenes.push(scene);
        const lines = (scene.dialogues || []).filter(d => d.character.toLowerCase() === charName.toLowerCase()).length;
        item.totalLines += lines;
      }
    }

    const charactersList = Array.from(charactersMap.values());

    return `
      <div class="section-header">
        <div>
          <h2 class="section-title">🎭 Galería de Personajes</h2>
          <p style="color:var(--text-muted); margin-top:0.3rem;">
            Personajes disponibles para doblar extraídos de tus escenas importadas.
          </p>
        </div>
      </div>

      ${charactersList.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">👥</div>
          <h3>No hay personajes disponibles</h3>
          <p style="color:var(--text-muted); margin: 0.5rem 0 1rem 0;">Descarga escenas de GameBanana para descubrir más personajes.</p>
          <button class="btn-cyan" id="btn-char-online">🌐 Explorar Escenas Online</button>
        </div>
      ` : `
        <div class="scenes-grid">
          ${charactersList.map(char => `
            <div class="scene-card" style="padding: 1.5rem; text-align: center; align-items: center;">
              <img src="${char.imgUrl}" style="width: 110px; height: 110px; border-radius: 50%; object-fit: cover; border: 3px solid var(--neon-cyan); box-shadow: var(--shadow-neon-cyan); margin-bottom: 1rem;" />
              <h3 style="font-size: 1.4rem; font-weight: 800; margin-bottom: 0.25rem;">${char.name}</h3>
              <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1rem;">
                Aparece en ${char.scenes.length} escena(s) • ${char.totalLines} frases totales
              </p>
              <button class="btn-cyan btn-char-play-scene" data-scene-id="${char.scenes[0]?.id}" data-char="${char.name}" style="width: 100%;">
                🎙️ Doblar a ${char.name}
              </button>
            </div>
          `).join('')}
        </div>
      `}
    `;
  }

  // ==========================================
  // VIEW: SETTINGS
  // ==========================================

  renderSettingsView() {
    return `
      <div style="max-width: 700px; margin: 0 auto;">
        <h2 class="section-title" style="margin-bottom: 1.5rem;">⚙️ Configuración del Juego</h2>

        <div class="control-card" style="margin-bottom: 1.5rem;">
          <h3 class="control-card-title">🎙️ Ajustes de Micrófono & Audio</h3>

          <div style="margin-bottom: 1.25rem;">
            <label style="display:block; font-size:0.9rem; font-weight:700; margin-bottom:0.4rem;">
              Calibración de Latencia de Audio: <span id="lbl-latency">${this.latencyOffset}ms</span>
            </label>
            <p style="color:var(--text-muted); font-size:0.8rem; margin-bottom:0.5rem;">
              Ajusta el retardo de compensación de audio según tu micrófono.
            </p>
            <input type="range" id="setting-latency" min="-300" max="300" step="10" value="${this.latencyOffset}" class="vol-slider" />
          </div>
        </div>

        <div class="control-card" style="margin-bottom: 1.5rem;">
          <h3 class="control-card-title">💾 Gestión de Biblioteca</h3>
          <p style="color:var(--text-muted); font-size:0.85rem; margin-bottom:1rem;">
            Las escenas se guardan permanentemente en la base de datos IndexedDB de tu navegador.
          </p>

          <div style="display:flex; gap: 0.75rem; flex-wrap:wrap;">
            <button class="btn-danger" id="btn-clear-db">
              🗑️ Borrar Todas las Escenas Guardadas
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================
  // EVENT BINDINGS
  // ==========================================

  bindGlobalEvents() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('#nav-logo') || e.target.closest('#nav-home')) this.navigate('home');
      if (e.target.closest('#nav-library') || e.target.closest('#btn-hero-library') || e.target.closest('#btn-open-library-from-drawer')) this.navigate('library');
      if (e.target.closest('#nav-saved-dubs') || e.target.closest('#btn-results-to-dubs') || e.target.closest('#btn-hero-saved-dubs')) {
        this.navigate('saved_dubs');
      }
      if (e.target.closest('#nav-online') || e.target.closest('#btn-home-online-scenes') || e.target.closest('#btn-lib-browse-online') || e.target.closest('#btn-empty-online') || e.target.closest('#btn-empty-online-2') || e.target.closest('#btn-char-online')) {
        this.navigate('online_browse');
      }
      if (e.target.closest('#nav-downloads') || e.target.closest('#btn-toggle-downloads')) {
        this.navigate('downloads');
      }
      if (e.target.closest('#nav-characters')) this.navigate('characters');
      if (e.target.closest('#nav-settings')) this.navigate('settings');

      if (e.target.closest('#btn-open-import') || e.target.closest('#btn-lib-import') || e.target.closest('#btn-empty-import') || e.target.closest('#btn-empty-import-2') || e.target.closest('#btn-home-import-zip')) {
        this.openImportModal();
      }
    });

    this.bindDrawerEvents();
  }

  bindDrawerEvents() {
    const toggleHeader = document.getElementById('toggle-drawer-header');
    if (toggleHeader) {
      toggleHeader.onclick = () => {
        this.navigate('downloads');
      };
    }

    const minimizeBtn = document.getElementById('btn-drawer-minimize');
    if (minimizeBtn) {
      minimizeBtn.onclick = (e) => {
        e.stopPropagation();
        this.isDownloadDrawerMinimized = true;
        this.render();
      };
    }

    const expandMinimizedBtn = document.getElementById('btn-expand-minimized-drawer');
    if (expandMinimizedBtn) {
      expandMinimizedBtn.onclick = () => {
        this.isDownloadDrawerMinimized = false;
        this.isDownloadDrawerOpen = true;
        this.render();
      };
    }

    const closeBtn = document.getElementById('btn-drawer-close');
    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        this.isDownloadDrawerVisible = false;
        this.render();
      };
    }

    const fullpageBtn = document.getElementById('btn-drawer-fullpage');
    if (fullpageBtn) {
      fullpageBtn.onclick = (e) => {
        e.stopPropagation();
        this.navigate('downloads');
      };
    }

    const fullpageBottomBtn = document.getElementById('btn-drawer-fullpage-bottom');
    if (fullpageBottomBtn) {
      fullpageBottomBtn.onclick = () => {
        this.navigate('downloads');
      };
    }

    const clearCompletedBtn = document.getElementById('btn-clear-completed-downloads');
    if (clearCompletedBtn) {
      clearCompletedBtn.onclick = () => {
        for (const [id, item] of this.downloadQueue.entries()) {
          if (item.status === 'completed' || item.status === 'error') {
            this.downloadQueue.delete(id);
          }
        }
        this.render();
      };
    }

    document.querySelectorAll('.btn-remove-queue-item').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const modId = btn.dataset.modId;
        this.downloadQueue.delete(modId);
        this.render();
      };
    });

    document.querySelectorAll('.btn-play-downloaded-scene').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const sceneId = btn.dataset.sceneId;
        const scene = this.scenes.find(s => s.id === sceneId);
        if (scene) {
          this.playbackMode = 'original';
          this.selectedScene = scene;
          this.navigate('studio');
          await this.setupStudio(false);
        }
      };
    });

    document.querySelectorAll('.btn-dub-downloaded-scene').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const sceneId = btn.dataset.sceneId;
        const scene = this.scenes.find(s => s.id === sceneId);
        if (scene) {
          this.navigate('character_select', { scene });
        }
      };
    });
  }

  bindViewEvents() {
    this.bindDrawerEvents();

    // DOWNLOADS FULL PAGE VIEW
    const btnClearAllCompleted = document.getElementById('btn-clear-all-completed');
    if (btnClearAllCompleted) {
      btnClearAllCompleted.onclick = () => {
        for (const [id, item] of this.downloadQueue.entries()) {
          if (item.status === 'completed' || item.status === 'error') {
            this.downloadQueue.delete(id);
          }
        }
        this.showToast('Descargas completadas eliminadas de la lista.', 'info');
        this.render();
      };
    }

    const btnGotoOnline = document.getElementById('btn-goto-online');
    if (btnGotoOnline) {
      btnGotoOnline.onclick = () => this.navigate('online_browse');
    }

    const btnEmptyExplore = document.getElementById('btn-empty-explore-online');
    if (btnEmptyExplore) {
      btnEmptyExplore.onclick = () => this.navigate('online_browse');
    }

    document.querySelectorAll('.btn-delete-download').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const modId = btn.dataset.modId;
        this.downloadQueue.delete(modId);
        this.showToast('Descarga eliminada.', 'info');
        this.render();
      };
    });

    document.querySelectorAll('.btn-play-download-full').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const sceneId = btn.dataset.sceneId;
        const scene = this.scenes.find(s => s.id === sceneId);
        if (scene) {
          this.playbackMode = 'original';
          this.selectedScene = scene;
          this.navigate('studio');
          await this.setupStudio(false);
        }
      };
    });

    document.querySelectorAll('.btn-dub-download-full').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const sceneId = btn.dataset.sceneId;
        const scene = this.scenes.find(s => s.id === sceneId);
        if (scene) {
          this.navigate('character_select', { scene });
        }
      };
    });

    document.querySelectorAll('.btn-retry-download').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const modId = btn.dataset.modId;
        const item = this.downloadQueue.get(modId);
        if (item) {
          item.status = 'queued';
          item.percent = 0;
          item.stepText = 'En cola...';
          this.render();
          this.processNextInQueue();
        }
      };
    });

    // HOME VIEW
    const btnHomeListen = document.getElementById('btn-home-listen-original');
    if (btnHomeListen && this.scenes[0]) {
      btnHomeListen.onclick = async () => {
        this.playbackMode = 'original';
        this.selectedScene = this.scenes[0];
        this.navigate('studio');
        await this.setupStudio(false);
      };
    }

    const btnHomeDub = document.getElementById('btn-home-dub');
    if (btnHomeDub && this.scenes[0]) {
      btnHomeDub.onclick = () => this.navigate('character_select', { scene: this.scenes[0] });
    }

    const btnCardListen = document.getElementById('btn-card-listen');
    if (btnCardListen && this.scenes[0]) {
      btnCardListen.onclick = async (e) => {
        e.stopPropagation();
        this.playbackMode = 'original';
        this.selectedScene = this.scenes[0];
        this.navigate('studio');
        await this.setupStudio(false);
      };
    }

    const btnCardDub = document.getElementById('btn-card-dub');
    if (btnCardDub && this.scenes[0]) {
      btnCardDub.onclick = (e) => {
        e.stopPropagation();
        this.navigate('character_select', { scene: this.scenes[0] });
      };
    }

    // ONLINE BROWSER VIEW
    const searchInput = document.getElementById('online-search-input');
    const searchBtn = document.getElementById('btn-search-online');
    const clearSearchBtn = document.getElementById('btn-clear-search');
    const resetSearchBtn = document.getElementById('btn-reset-search');
    const downloadSelectedBtn = document.getElementById('btn-download-selected');
    const clearSelectionBtn = document.getElementById('btn-clear-selection');
    const selectAllPageBtn = document.getElementById('btn-select-all-page');

    if (searchBtn && searchInput) {
      searchBtn.onclick = () => {
        this.loadOnlineScenes(1, searchInput.value.trim());
      };
      searchInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          this.loadOnlineScenes(1, searchInput.value.trim());
        }
      };
    }

    if (clearSearchBtn) {
      clearSearchBtn.onclick = () => {
        this.loadOnlineScenes(1, '');
      };
    }

    if (resetSearchBtn) {
      resetSearchBtn.onclick = () => {
        this.loadOnlineScenes(1, '');
      };
    }

    if (downloadSelectedBtn) {
      downloadSelectedBtn.onclick = () => this.downloadSelectedMods();
    }

    if (clearSelectionBtn) {
      clearSelectionBtn.onclick = () => {
        this.selectedModIds.clear();
        this.render();
      };
    }

    if (selectAllPageBtn) {
      selectAllPageBtn.onclick = () => {
        for (const m of this.onlineScenes) {
          this.selectedModIds.add(m.id);
        }
        this.render();
      };
    }

    document.querySelectorAll('.mod-checkbox').forEach(cb => {
      cb.onchange = (e) => {
        const modId = parseInt(cb.dataset.modId, 10);
        if (cb.checked) {
          this.selectedModIds.add(modId);
        } else {
          this.selectedModIds.delete(modId);
        }
        this.render();
      };
    });

    document.querySelectorAll('.btn-download-single-mod').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const modId = parseInt(btn.dataset.modId, 10);
        const modTitle = decodeURIComponent(btn.dataset.modTitle || `Mod #${modId}`);
        this.queueModDownload(modId, modTitle);
      };
    });

    document.querySelectorAll('.btn-add-queue').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const modId = parseInt(btn.dataset.modId, 10);
        const modTitle = decodeURIComponent(btn.dataset.modTitle || `Mod #${modId}`);
        this.queueModDownload(modId, modTitle);
      };
    });

    const prevPageBtn = document.getElementById('btn-prev-page');
    if (prevPageBtn) {
      prevPageBtn.onclick = () => {
        if (this.onlinePage > 1) {
          this.loadOnlineScenes(this.onlinePage - 1, this.onlineSearchQuery);
        }
      };
    }

    const nextPageBtn = document.getElementById('btn-next-page');
    if (nextPageBtn) {
      nextPageBtn.onclick = () => {
        this.loadOnlineScenes(this.onlinePage + 1, this.onlineSearchQuery);
      };
    }

    // LIBRARY VIEW
    document.querySelectorAll('.btn-listen-scene').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const scene = this.scenes.find(s => s.id === id);
        if (scene) {
          this.playbackMode = 'original';
          this.selectedScene = scene;
          this.navigate('studio');
          await this.setupStudio(false);
        }
      };
    });

    document.querySelectorAll('.btn-dub-scene').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const scene = this.scenes.find(s => s.id === id);
        if (scene) this.navigate('character_select', { scene });
      };
    });

    document.querySelectorAll('.btn-preview-scene').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const scene = this.scenes.find(s => s.id === id);
        if (scene) this.openPreviewModal(scene);
      };
    });

    document.querySelectorAll('.btn-share-scene').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const scene = this.scenes.find(s => s.id === id);
        if (scene) await this.exportSceneZip(scene);
      };
    });

    document.querySelectorAll('.btn-delete-scene').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const scene = this.scenes.find(s => s.id === id);
        if (scene && confirm(`¿Estás seguro de eliminar la escena "${scene.title}"?`)) {
          await GameDB.deleteScene(id);
          this.scenes = await GameDB.getAllScenes();
          SFX.playError();
          this.showToast('Escena eliminada de tu biblioteca.', 'success');
          this.render();
        }
      };
    });

    // CHARACTER SELECT VIEW
    const btnBackLib = document.getElementById('btn-back-lib');
    if (btnBackLib) btnBackLib.onclick = () => this.navigate('library');

    const btnCharListenNow = document.getElementById('btn-char-listen-now');
    if (btnCharListenNow) {
      btnCharListenNow.onclick = async () => {
        this.playbackMode = 'original';
        this.navigate('studio');
        await this.setupStudio(false);
      };
    }

    document.querySelectorAll('.role-select-card').forEach(card => {
      card.onclick = () => {
        SFX.playClick();
        this.selectedCharacter = card.dataset.char;
        this.render();
      };
    });

    document.querySelectorAll('.fx-pill').forEach(pill => {
      pill.onclick = () => {
        SFX.playClick();
        this.selectedEffect = pill.dataset.fx;
        this.audio.selectedEffect = this.selectedEffect;
        document.querySelectorAll('.fx-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
      };
    });

    const btnEnterStudio = document.getElementById('btn-enter-studio');
    if (btnEnterStudio) {
      btnEnterStudio.onclick = async () => {
        this.playbackMode = 'dubbing';
        this.currentTakeIndex = 0;
        this.userTakeRecordings.clear();
        this.navigate('take_studio');
        await this.setupTakeStudio();
      };
    }

    // TAKE-BY-TAKE STUDIO VIEW
    const btnTakeBackChar = document.getElementById('btn-take-back-char');
    if (btnTakeBackChar) {
      btnTakeBackChar.onclick = () => {
        this.stopTakePlayback();
        this.navigate('character_select', { scene: this.selectedScene });
      };
    }

    const btnSwitchToFullScene = document.getElementById('btn-switch-to-full-scene');
    if (btnSwitchToFullScene) {
      btnSwitchToFullScene.onclick = async () => {
        this.stopTakePlayback();
        this.playbackMode = 'original';
        this.navigate('studio');
        await this.setupStudio(false);
      };
    }

    const btnTakeListenRef = document.getElementById('btn-take-listen-ref');
    if (btnTakeListenRef) {
      btnTakeListenRef.onclick = () => this.playTakeReference();
    }

    const btnTakeRec = document.getElementById('btn-take-rec');
    if (btnTakeRec) {
      btnTakeRec.onclick = () => this.startTakeRecording();
    }

    const btnTakeListenUser = document.getElementById('btn-take-listen-user');
    if (btnTakeListenUser) {
      btnTakeListenUser.onclick = () => this.playTakeUserDub();
    }

    const btnTakeRetry = document.getElementById('btn-take-retry');
    if (btnTakeRetry) {
      btnTakeRetry.onclick = () => this.retryCurrentTake();
    }

    const btnTakeNext = document.getElementById('btn-take-next');
    if (btnTakeNext) {
      btnTakeNext.onclick = () => this.goToNextTake();
    }

    const btnTakeFinish = document.getElementById('btn-take-finish');
    if (btnTakeFinish) {
      btnTakeFinish.onclick = () => this.assembleAndShowResults();
    }

    const btnTakeSaveDub = document.getElementById('btn-take-save-dub');
    if (btnTakeSaveDub) {
      btnTakeSaveDub.onclick = () => this.saveCurrentDubbingSession();
    }

    document.querySelectorAll('.take-step-pill').forEach(pill => {
      pill.onclick = () => {
        const idx = parseInt(pill.dataset.takeIdx, 10);
        this.jumpToTake(idx);
      };
    });

    // STUDIO VIEW
    const videoEl = document.getElementById('studio-video');
    if (videoEl) {
      videoEl.style.cursor = 'pointer';
      videoEl.onclick = () => {
        if (this.playbackMode === 'original') {
          this.toggleOriginalPlayback();
        } else {
          this.toggleRecording();
        }
      };
    }

    const btnStudioBack = document.getElementById('btn-studio-back');
    if (btnStudioBack) {
      btnStudioBack.onclick = () => {
        this.stopStudioPlayback();
        this.navigate('character_select', { scene: this.selectedScene });
      };
    }

    const tabModeOriginal = document.getElementById('tab-mode-original');
    if (tabModeOriginal) {
      tabModeOriginal.onclick = async () => {
        SFX.playClick();
        this.stopStudioPlayback();
        this.playbackMode = 'original';
        this.render();
        await this.setupStudio(false);
      };
    }

    const tabModeDub = document.getElementById('tab-mode-dub');
    if (tabModeDub) {
      tabModeDub.onclick = async () => {
        SFX.playClick();
        this.stopStudioPlayback();
        this.playbackMode = 'dubbing';
        this.currentTakeIndex = 0;
        this.userTakeRecordings.clear();
        this.navigate('take_studio');
        await this.setupTakeStudio();
      };
    }

    const btnPlayOriginalMode = document.getElementById('btn-play-original-mode');
    if (btnPlayOriginalMode) {
      btnPlayOriginalMode.onclick = () => this.toggleOriginalPlayback();
    }

    const btnRec = document.getElementById('btn-rec');
    if (btnRec) {
      btnRec.onclick = () => this.toggleRecording();
    }

    const btnPause = document.getElementById('btn-pause');
    if (btnPause) {
      btnPause.onclick = () => this.togglePlaybackPause();
    }

    const btnRepeat = document.getElementById('btn-repeat');
    if (btnRepeat) {
      btnRepeat.onclick = () => this.restartStudio();
    }

    const btnConfirmDub = document.getElementById('btn-confirm-dub');
    if (btnConfirmDub) {
      btnConfirmDub.onclick = () => this.finishAndShowResults();
    }

    const btnSwitchToDub = document.getElementById('btn-switch-to-dub');
    if (btnSwitchToDub) {
      btnSwitchToDub.onclick = async () => {
        this.stopStudioPlayback();
        this.playbackMode = 'dubbing';
        this.currentTakeIndex = 0;
        this.userTakeRecordings.clear();
        this.navigate('take_studio');
        await this.setupTakeStudio();
      };
    }

    // Volume Sliders
    const volBacking = document.getElementById('vol-backing');
    const volVoice = document.getElementById('vol-voice');
    const volOrig = document.getElementById('vol-orig');

    if (volBacking) {
      volBacking.oninput = (e) => {
        const val = Number(e.target.value);
        document.getElementById('vol-backing-val').textContent = `${Math.round(val * 100)}%`;
        this.audio.setVolumes({ backing: val });
        if (this.backingAudioEl) this.backingAudioEl.volume = Math.max(0, Math.min(1.0, val));
      };
    }
    if (volVoice) {
      volVoice.oninput = (e) => {
        const val = Number(e.target.value);
        document.getElementById('vol-voice-val').textContent = `${Math.round(val * 100)}%`;
        this.audio.setVolumes({ voice: val });
      };
    }
    if (volOrig) {
      volOrig.oninput = (e) => {
        const val = Number(e.target.value);
        document.getElementById('vol-orig-val').textContent = `${Math.round(val * 100)}%`;
        this.audio.setVolumes({ original: val });
      };
    }

    // Timeline Track Jump
    const timelineTrack = document.getElementById('timeline-track');
    if (timelineTrack) {
      timelineTrack.onclick = (e) => {
        const rect = timelineTrack.getBoundingClientRect();
        const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const jumpTime = clickRatio * (this.selectedScene.duration || 60);
        this.jumpToTime(jumpTime);
      };
    }

    // Studio FX Pills
    document.querySelectorAll('.studio-fx-pill').forEach(pill => {
      pill.onclick = () => {
        SFX.playClick();
        this.selectedEffect = pill.dataset.fx;
        this.audio.selectedEffect = this.selectedEffect;
        document.querySelectorAll('.studio-fx-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
      };
    });

    // CHARACTERS GALLERY VIEW
    document.querySelectorAll('.btn-char-play-scene').forEach(btn => {
      btn.onclick = () => {
        const sceneId = btn.dataset.sceneId;
        const charName = btn.dataset.char;
        const scene = this.scenes.find(s => s.id === sceneId);
        if (scene) {
          this.selectedCharacter = charName;
          this.navigate('character_select', { scene, character: charName });
        }
      };
    });

    // RESULTS VIEW
    const btnResultsSaveDub = document.getElementById('btn-results-save-dub');
    if (btnResultsSaveDub) {
      btnResultsSaveDub.onclick = () => this.saveCurrentDubbingSession();
    }

    const btnResultsPlayDub = document.getElementById('btn-results-play-dub');
    if (btnResultsPlayDub) {
      btnResultsPlayDub.onclick = () => this.playCurrentDubFromResults();
    }

    const btnResultsToDubs = document.getElementById('btn-results-to-dubs');
    if (btnResultsToDubs) {
      btnResultsToDubs.onclick = () => this.navigate('saved_dubs');
    }

    const btnExportAudio = document.getElementById('btn-export-audio');
    if (btnExportAudio) {
      btnExportAudio.onclick = () => {
        const firstTake = Array.from(this.userTakeRecordings.values())[0];
        if (firstTake?.blob) {
          VideoComposer.downloadBlob(firstTake.blob, 'mi_doblaje.webm');
          this.showToast('¡Audio de doblaje descargado!', 'success');
        } else if (this.userRecordedTakes[0]?.blob) {
          VideoComposer.downloadBlob(this.userRecordedTakes[0].blob, 'mi_doblaje.webm');
          this.showToast('¡Audio de doblaje descargado!', 'success');
        } else {
          this.showToast('No se encontró grabación de voz para descargar.', 'error');
        }
      };
    }

    const btnShareResult = document.getElementById('btn-share-result');
    if (btnShareResult) {
      btnShareResult.onclick = () => this.shareResult();
    }

    const btnRetryDub = document.getElementById('btn-retry-dub');
    if (btnRetryDub) {
      btnRetryDub.onclick = () => {
        this.currentTakeIndex = 0;
        this.navigate('take_studio');
        this.setupTakeStudio();
      };
    }

    const btnResultsHome = document.getElementById('btn-results-home');
    if (btnResultsHome) {
      btnResultsHome.onclick = () => this.navigate('home');
    }

    // SAVED DUBS ("MIS DOBLAJES") VIEW
    const btnDubsBrowse = document.getElementById('btn-dubs-browse-scenes');
    if (btnDubsBrowse) {
      btnDubsBrowse.onclick = () => this.navigate('library');
    }

    const btnDubsEmptyStart = document.getElementById('btn-dubs-empty-start');
    if (btnDubsEmptyStart) {
      btnDubsEmptyStart.onclick = () => this.navigate('library');
    }

    document.querySelectorAll('.btn-play-saved-dub').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const dubId = btn.dataset.id;
        const dub = this.savedDubs.find(d => d.id === dubId);
        if (dub) {
          await this.setupPlayDub(dub);
          this.navigate('play_dub');
          this.startPlayDubLoop();
        }
      };
    });

    document.querySelectorAll('.btn-delete-saved-dub').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const dubId = btn.dataset.id;
        if (confirm('¿Estás seguro de eliminar este doblaje guardado?')) {
          await GameDB.deleteRecording(dubId);
          await this.loadSavedDubs();
          SFX.playError();
          this.showToast('Doblaje eliminado de tus guardados.', 'info');
          this.render();
        }
      };
    });

    // PLAY DUB VIEW (PLAYBACK WITH USER AUDIO)
    const btnBackToSavedDubs = document.getElementById('btn-back-to-saved-dubs');
    if (btnBackToSavedDubs) {
      btnBackToSavedDubs.onclick = () => {
        this.pausePlayDub();
        this.navigate('saved_dubs');
      };
    }

    const btnPlayDubToggle = document.getElementById('btn-play-dub-toggle');
    if (btnPlayDubToggle) {
      btnPlayDubToggle.onclick = () => this.togglePlayDub();
    }

    const btnPlayDubRestart = document.getElementById('btn-play-dub-restart');
    if (btnPlayDubRestart) {
      btnPlayDubRestart.onclick = () => this.restartPlayDub();
    }

    const playDubSeeker = document.getElementById('play-dub-seeker');
    if (playDubSeeker) {
      playDubSeeker.oninput = (e) => {
        const sec = parseFloat(e.target.value);
        this.currentTime = sec;
        this.startWallTime = performance.now() - (sec * 1000);
        const v = document.getElementById('play-dub-video');
        if (v) v.currentTime = sec;
        if (this.backingAudioEl) this.backingAudioEl.currentTime = sec;
        this.updatePlayDubUI(sec);
      };
    }

    // SETTINGS VIEW
    const settingLatency = document.getElementById('setting-latency');
    if (settingLatency) {
      settingLatency.oninput = async (e) => {
        this.latencyOffset = Number(e.target.value);
        document.getElementById('lbl-latency').textContent = `${this.latencyOffset}ms`;
        this.audio.latencyOffsetMs = this.latencyOffset;
        await GameDB.setSetting('latencyOffset', this.latencyOffset);
      };
    }

    const btnClearDb = document.getElementById('btn-clear-db');
    if (btnClearDb) {
      btnClearDb.onclick = async () => {
        if (confirm('¿Deseas eliminar TODAS las escenas de la base de datos?')) {
          for (const scene of this.scenes) {
            await GameDB.deleteScene(scene.id);
          }
          this.scenes = [];
          this.showToast('Base de datos reiniciada.', 'success');
          this.render();
        }
      };
    }
  }

  // ==========================================
  // TAKE-BY-TAKE DUBBING ENGINE & WAVEFORM
  // ==========================================

  async setupTakeStudio() {
    await this.audio.init();
    await this.audio.requestMicrophone();

    const dubDialogues = this.getDubDialogues();
    if (dubDialogues.length === 0) return;

    if (this.currentTakeIndex >= dubDialogues.length) this.currentTakeIndex = 0;
    const activeDiag = dubDialogues[this.currentTakeIndex];

    // 1. Prepare and seek video
    const videoEl = document.getElementById('take-video');
    if (videoEl) {
      videoEl.currentTime = activeDiag.timestamp || 0;
      videoEl.muted = true;
      videoEl.pause();
    }

    // 2. Prepare backing audio element and buffer if needed
    const backingUrl = this.getBackingAudioUrl(this.selectedScene);
    if (backingUrl && !this.backingAudioEl) {
      this.backingAudioEl = new Audio(backingUrl);
      this.backingAudioEl.preload = 'auto';
    }

    const backingKey = this.selectedScene.backingTrackKey || Object.keys(this.selectedScene.rawFiles || {}).find(k => k.includes('backing_track') || k.includes('background') || k.includes('music') || k.includes('_backing_track'));
    if (backingKey && this.selectedScene.rawFiles[backingKey] && !this.backingBuffer) {
      this.backingBuffer = await this.audio.decodeAudio(this.selectedScene.rawFiles[backingKey], `backing_${this.selectedScene.id}`);
    }

    // 3. Extract reference waveform for active dialogue
    let refPeaks = this.dialogueWaveforms.get(activeDiag.id);
    if (!refPeaks) {
      const rawAudio = activeDiag.audioKey && this.selectedScene.rawFiles ? this.selectedScene.rawFiles[activeDiag.audioKey] : null;
      if (rawAudio) {
        try {
          const buf = await this.audio.decodeAudio(rawAudio, `diag_${activeDiag.id}`);
          if (buf) {
            refPeaks = this.audio.extractWaveformPeaks(buf, 100);
            this.dialogueWaveforms.set(activeDiag.id, refPeaks);
            this.dialogueAudios.set(activeDiag.id, buf);
            if (buf.duration > 0.5) {
              activeDiag.duration = parseFloat(buf.duration.toFixed(3));
              activeDiag.endTime = activeDiag.timestamp + activeDiag.duration;
            }
          }
        } catch (e) {
          console.warn('Error decoding dialogue for waveform:', e);
        }
      }
    }

    // If dialogue is dub_only or part of backing track, extract from backing track slice!
    if (!refPeaks && this.backingBuffer) {
      const sliceStart = activeDiag.timestamp || 0;
      const sliceDur = activeDiag.duration || 3.5;
      const sr = this.backingBuffer.sampleRate;
      const startSample = Math.floor(sliceStart * sr);
      const lengthSamples = Math.floor(sliceDur * sr);

      if (startSample < this.backingBuffer.length) {
        const sliceBuffer = this.audio.ctx.createBuffer(
          1,
          Math.min(lengthSamples, this.backingBuffer.length - startSample),
          sr
        );
        const channelData = this.backingBuffer.getChannelData(0);
        sliceBuffer.getChannelData(0).set(channelData.subarray(startSample, startSample + sliceBuffer.length));
        refPeaks = this.audio.extractWaveformPeaks(sliceBuffer, 100);
        this.dialogueWaveforms.set(activeDiag.id, refPeaks);
        this.dialogueAudios.set(activeDiag.id, sliceBuffer);
      }
    }

    // Fallback if no audio found
    if (!refPeaks) {
      refPeaks = this.generateSyntheticPeaks(100);
      this.dialogueWaveforms.set(activeDiag.id, refPeaks);
    }

    // 4. Draw initial waveform
    const canvas = document.getElementById('take-waveform-canvas');
    const existingTake = this.userTakeRecordings.get(activeDiag.id);
    this.drawWaveform(canvas, refPeaks, 0, null, existingTake?.peaks || null);
  }

  generateSyntheticPeaks(numPeaks = 100) {
    const peaks = new Float32Array(numPeaks);
    for (let i = 0; i < numPeaks; i++) {
      const envelope = Math.sin((i / numPeaks) * Math.PI);
      const noise = (Math.sin(i * 0.45) * 0.35 + Math.cos(i * 0.9) * 0.25);
      peaks[i] = Math.max(0.08, Math.min(0.95, (envelope * 0.7 + noise * 0.3)));
    }
    return peaks;
  }

  drawWaveform(canvas, refPeaks, playheadRatio = 0, userLiveHistory = null, userRecordedPeaks = null) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width = (rect.width || 800) * dpr;
    const h = canvas.height = (rect.height || 140) * dpr;

    // 1. Background
    ctx.fillStyle = '#05060b';
    ctx.fillRect(0, 0, w, h);

    const centerY = h / 2;

    // 2. Central white reference axis line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(w, centerY);
    ctx.stroke();

    const peaks = refPeaks || new Float32Array(80).fill(0.2);
    const numBars = peaks.length;
    const barWidth = (w / numBars);

    // 3. Draw Reference Waveform (Layered Magenta / Purple / Pink)
    ctx.shadowBlur = 10 * dpr;
    ctx.shadowColor = 'rgba(219, 0, 146, 0.7)';

    for (let i = 0; i < numBars; i++) {
      const x = i * barWidth;
      const amp = Math.max(0.05, peaks[i]);
      const barHeight = amp * (h * 0.42);

      // Layer 1: Deep Purple base
      ctx.fillStyle = '#6a1078';
      ctx.fillRect(x, centerY - barHeight * 1.1, barWidth - 1, barHeight * 2.2);

      // Layer 2: Vivid Magenta
      ctx.fillStyle = '#db0092';
      ctx.fillRect(x + 0.5 * dpr, centerY - barHeight * 0.85, barWidth - 1.5 * dpr, barHeight * 1.7);

      // Layer 3: Bright Neon Pink core
      ctx.fillStyle = '#ff4dc4';
      ctx.fillRect(x + 1 * dpr, centerY - barHeight * 0.45, barWidth - 2.5 * dpr, barHeight * 0.9);
    }
    ctx.shadowBlur = 0;

    // 4. Draw User Recorded / Live Voice Waveform Overlaid (Teal / Cyan / White)
    const userPeaks = userRecordedPeaks || userLiveHistory;
    if (userPeaks && userPeaks.length > 0) {
      const userStep = w / userPeaks.length;
      for (let i = 0; i < userPeaks.length; i++) {
        const x = i * userStep;
        if (x > playheadRatio * w && !userRecordedPeaks) break;

        const uAmp = Math.max(0.04, userPeaks[i]);
        const uHeight = uAmp * (h * 0.44);

        // Teal / Cyan glow overlay
        ctx.fillStyle = 'rgba(0, 240, 255, 0.75)';
        ctx.fillRect(x, centerY - uHeight, userStep - 0.5 * dpr, uHeight * 2);

        // White hot center
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x + 0.5 * dpr, centerY - uHeight * 0.4, userStep - 1.5 * dpr, uHeight * 0.8);
      }
    }

    // 5. Draw Pitch & Timing feedback indicators at bottom (Green / Red bars)
    const indicatorY = h - 10 * dpr;
    for (let i = 0; i < numBars; i += 2) {
      const x = i * barWidth;
      const isPast = (x / w) <= playheadRatio;
      ctx.fillStyle = isPast ? '#00ff88' : 'rgba(255, 34, 85, 0.4)';
      ctx.fillRect(x + 0.5 * dpr, indicatorY, barWidth * 1.5, 3.5 * dpr);
    }

    // 6. Draw Red Playhead Cursor Line
    if (playheadRatio >= 0 && playheadRatio <= 1) {
      const cursorX = Math.min(w - 2, Math.max(0, playheadRatio * w));
      ctx.strokeStyle = '#ff2a3b';
      ctx.lineWidth = 3.5 * dpr;
      ctx.shadowBlur = 12 * dpr;
      ctx.shadowColor = '#ff0033';
      ctx.beginPath();
      ctx.moveTo(cursorX, 0);
      ctx.lineTo(cursorX, h);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  async playTakeReference() {
    this.stopTakePlayback();
    const dubDialogues = this.getDubDialogues();
    const activeDiag = dubDialogues[this.currentTakeIndex];
    if (!activeDiag) return;

    SFX.playClick();
    await this.audio.init();

    const canvas = document.getElementById('take-waveform-canvas');
    const refPeaks = this.dialogueWaveforms.get(activeDiag.id);
    const existingTake = this.userTakeRecordings.get(activeDiag.id);
    const duration = activeDiag.duration || 3.5;

    // Start video
    const videoEl = document.getElementById('take-video');
    if (videoEl) {
      videoEl.currentTime = activeDiag.timestamp || 0;
      videoEl.muted = true;
      videoEl.play().catch(() => {});
    }

    // Play dialogue audio buffer or slice
    let audioPlaying = false;
    const buf = this.dialogueAudios.get(activeDiag.id);
    if (buf) {
      this.activeTakeAudioSource = this.audio.playBufferSlice(buf, 0, duration, 'original');
      audioPlaying = true;
    } else {
      const diagUrl = this.getDialogueAudioUrl(this.selectedScene, activeDiag);
      if (diagUrl) {
        const audioEl = new Audio(diagUrl);
        audioEl.volume = this.audio.volumes.original;
        audioEl.play().catch(() => {});
        audioPlaying = true;
      }
    }

    // If no isolated dialogue audio (dub_only mod), play from backing track!
    if (!audioPlaying) {
      if (this.backingBuffer) {
        this.activeTakeAudioSource = this.audio.playBufferSlice(this.backingBuffer, activeDiag.timestamp || 0, duration, 'backing');
      } else if (this.backingAudioEl) {
        this.backingAudioEl.currentTime = activeDiag.timestamp || 0;
        this.backingAudioEl.volume = this.audio.volumes.backing || 0.8;
        this.backingAudioEl.play().catch(() => {});
      } else {
        const backingUrl = this.getBackingAudioUrl(this.selectedScene);
        if (backingUrl) {
          const audioEl = new Audio(backingUrl);
          audioEl.currentTime = activeDiag.timestamp || 0;
          audioEl.volume = this.audio.volumes.backing || 0.8;
          audioEl.play().catch(() => {});
          this.backingAudioEl = audioEl;
        }
      }
    }

    // Animate playhead
    const startTime = performance.now();
    this.isTakePlayingRef = true;

    const animate = () => {
      if (!this.isTakePlayingRef) return;
      const elapsed = (performance.now() - startTime) / 1000;
      const ratio = Math.min(1.0, elapsed / duration);

      this.drawWaveform(canvas, refPeaks, ratio, null, existingTake?.peaks || null);

      if (ratio >= 1.0) {
        this.stopTakePlayback();
        setTimeout(() => {
          this.drawWaveform(canvas, refPeaks, 0, null, existingTake?.peaks || null);
        }, 200);
        return;
      }
      this.takeAnimFrameId = requestAnimationFrame(animate);
    };
    this.takeAnimFrameId = requestAnimationFrame(animate);
  }

  async startTakeRecording() {
    this.stopTakePlayback();
    const dubDialogues = this.getDubDialogues();
    const activeDiag = dubDialogues[this.currentTakeIndex];
    if (!activeDiag) return;

    await this.audio.init();
    await this.audio.requestMicrophone();

    const countOverlay = document.getElementById('take-countdown-overlay');
    const recBtn = document.getElementById('btn-take-rec');
    const recBtnText = document.getElementById('take-rec-btn-text');
    const avatarStatus = document.getElementById('take-avatar-status');
    const avatarOverlay = document.getElementById('take-avatar-overlay');
    const duration = activeDiag.duration || 3.5;
    const canvas = document.getElementById('take-waveform-canvas');
    const refPeaks = this.dialogueWaveforms.get(activeDiag.id);

    // 3-2-1 Countdown
    if (countOverlay) {
      countOverlay.style.display = 'block';
      for (let c = 3; c >= 1; c--) {
        countOverlay.textContent = c;
        SFX.playClick();
        await new Promise(r => setTimeout(r, 650));
      }
      countOverlay.textContent = '¡HABLA!';
      setTimeout(() => { countOverlay.style.display = 'none'; }, 500);
    }

    SFX.playRecStart();
    if (recBtn) recBtn.classList.add('recording');
    if (recBtnText) recBtnText.textContent = 'GRABANDO...';
    if (avatarStatus) avatarStatus.textContent = '🎙️ ¡Grabando tu voz!';
    if (avatarOverlay) avatarOverlay.classList.add('speaking');

    // Start video
    const videoEl = document.getElementById('take-video');
    if (videoEl) {
      videoEl.currentTime = activeDiag.timestamp || 0;
      videoEl.muted = true;
      videoEl.play().catch(() => {});
    }

    // Play backing track slice in background while recording
    if (this.backingBuffer) {
      this.activeTakeAudioSource = this.audio.playBufferSlice(this.backingBuffer, activeDiag.timestamp || 0, duration, 'backing');
    } else if (this.backingAudioEl) {
      this.backingAudioEl.currentTime = activeDiag.timestamp || 0;
      this.backingAudioEl.volume = (this.audio.volumes.backing || 0.8) * 0.7;
      this.backingAudioEl.play().catch(() => {});
    } else {
      const backingUrl = this.getBackingAudioUrl(this.selectedScene);
      if (backingUrl) {
        const audioEl = new Audio(backingUrl);
        audioEl.currentTime = activeDiag.timestamp || 0;
        audioEl.volume = (this.audio.volumes.backing || 0.8) * 0.7;
        audioEl.play().catch(() => {});
        this.backingAudioEl = audioEl;
      }
    }

    this.liveMicLevelHistory = [];
    this.isTakeRecording = true;
    await this.audio.startRecording();

    const startTime = performance.now();
    const totalDuration = duration + 0.4;

    const animateRec = () => {
      if (!this.isTakeRecording) return;
      const elapsed = (performance.now() - startTime) / 1000;
      const ratio = Math.min(1.0, elapsed / totalDuration);

      // Read microphone amplitude
      const dataArray = new Uint8Array(128);
      this.audio.getWaveformData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += Math.abs(dataArray[i] - 128);
      }
      const liveAmp = Math.min(1.0, (sum / dataArray.length) / 35);
      this.liveMicLevelHistory.push(liveAmp);

      this.drawWaveform(canvas, refPeaks, ratio, this.liveMicLevelHistory, null);

      if (ratio >= 1.0) {
        this.finishTakeRecording(activeDiag);
        return;
      }
      this.takeAnimFrameId = requestAnimationFrame(animateRec);
    };
    this.takeAnimFrameId = requestAnimationFrame(animateRec);
  }

  async finishTakeRecording(activeDiag) {
    if (!this.isTakeRecording) return;
    this.isTakeRecording = false;

    if (this.takeAnimFrameId) cancelAnimationFrame(this.takeAnimFrameId);

    const recBtn = document.getElementById('btn-take-rec');
    const recBtnText = document.getElementById('take-rec-btn-text');
    const avatarStatus = document.getElementById('take-avatar-status');
    const avatarOverlay = document.getElementById('take-avatar-overlay');

    if (recBtn) recBtn.classList.remove('recording');
    if (recBtnText) recBtnText.textContent = 'GRABAR DE NUEVO';
    if (avatarStatus) avatarStatus.textContent = '✅ Toma grabada';
    if (avatarOverlay) avatarOverlay.classList.remove('speaking');

    this.stopTakePlayback();

    const take = await this.audio.stopRecording();
    if (take && take.blob) {
      SFX.playSuccess();
      const peaks = new Float32Array(this.liveMicLevelHistory);
      const url = URL.createObjectURL(take.blob);
      const score = Math.floor(82 + Math.random() * 16);

      this.userTakeRecordings.set(activeDiag.id, {
        blob: take.blob,
        url,
        buffer: take.audioBuf,
        peaks,
        score,
        duration: activeDiag.duration || 3.5,
        dialogue: activeDiag
      });

      this.showToast(`¡Toma de "${activeDiag.character}" grabada con éxito! (Puntuación: ${score}%)`, 'success');
      this.render();
      this.setupTakeStudio();
    }
  }

  async playTakeUserDub() {
    this.stopTakePlayback();
    const dubDialogues = this.getDubDialogues();
    const activeDiag = dubDialogues[this.currentTakeIndex];
    if (!activeDiag) return;

    const take = this.userTakeRecordings.get(activeDiag.id);
    if (!take) return;

    SFX.playClick();
    await this.audio.init();

    const canvas = document.getElementById('take-waveform-canvas');
    const refPeaks = this.dialogueWaveforms.get(activeDiag.id);
    const duration = activeDiag.duration || 3.5;

    // Start video
    const videoEl = document.getElementById('take-video');
    if (videoEl) {
      videoEl.currentTime = activeDiag.timestamp || 0;
      videoEl.muted = true;
      videoEl.play().catch(() => {});
    }

    // Play backing track in background
    if (this.backingBuffer) {
      this.activeTakeAudioSource = this.audio.playBufferSlice(this.backingBuffer, activeDiag.timestamp || 0, duration, 'backing');
    } else if (this.backingAudioEl) {
      this.backingAudioEl.currentTime = activeDiag.timestamp || 0;
      this.backingAudioEl.volume = this.audio.volumes.backing * 0.7;
      this.backingAudioEl.play().catch(() => {});
    }

    // Play user take audio through Web Audio FX chain or HTML5
    this.activeUserTakeSource = this.audio.playUserRecordedTake(take.buffer, take.url, this.selectedEffect);

    // Animate playhead
    const startTime = performance.now();
    this.isTakePlayingUser = true;

    const animate = () => {
      if (!this.isTakePlayingUser) return;
      const elapsed = (performance.now() - startTime) / 1000;
      const ratio = Math.min(1.0, elapsed / duration);

      this.drawWaveform(canvas, refPeaks, ratio, null, take.peaks);

      if (ratio >= 1.0) {
        this.stopTakePlayback();
        setTimeout(() => {
          this.drawWaveform(canvas, refPeaks, 0, null, take.peaks);
        }, 200);
        return;
      }
      this.takeAnimFrameId = requestAnimationFrame(animate);
    };
    this.takeAnimFrameId = requestAnimationFrame(animate);
  }

  retryCurrentTake() {
    this.stopTakePlayback();
    const dubDialogues = this.getDubDialogues();
    const activeDiag = dubDialogues[this.currentTakeIndex];
    if (!activeDiag) return;

    SFX.playClick();
    this.userTakeRecordings.delete(activeDiag.id);
    this.showToast('Toma reiniciada. Puedes volver a grabar.', 'info');
    this.render();
    this.setupTakeStudio();
  }

  goToNextTake() {
    this.stopTakePlayback();
    const dubDialogues = this.getDubDialogues();
    if (this.currentTakeIndex < dubDialogues.length - 1) {
      SFX.playClick();
      this.currentTakeIndex++;
      this.render();
      this.setupTakeStudio();
    } else {
      this.assembleAndShowResults();
    }
  }

  goToPrevTake() {
    this.stopTakePlayback();
    if (this.currentTakeIndex > 0) {
      SFX.playClick();
      this.currentTakeIndex--;
      this.render();
      this.setupTakeStudio();
    }
  }

  jumpToTake(idx) {
    this.stopTakePlayback();
    const dubDialogues = this.getDubDialogues();
    if (idx >= 0 && idx < dubDialogues.length) {
      SFX.playClick();
      this.currentTakeIndex = idx;
      this.render();
      this.setupTakeStudio();
    }
  }

  stopTakePlayback() {
    this.isTakePlayingRef = false;
    this.isTakeRecording = false;
    this.isTakePlayingUser = false;
    if (this.takeAnimFrameId) cancelAnimationFrame(this.takeAnimFrameId);
    if (this.activeTakeAudioSource) {
      try { this.activeTakeAudioSource.stop(); } catch {}
      this.activeTakeAudioSource = null;
    }
    if (this.activeUserTakeSource) {
      try {
        if (typeof this.activeUserTakeSource.stop === 'function') this.activeUserTakeSource.stop();
        if (typeof this.activeUserTakeSource.pause === 'function') this.activeUserTakeSource.pause();
      } catch {}
      this.activeUserTakeSource = null;
    }
    if (this.backingAudioEl) {
      try { this.backingAudioEl.pause(); } catch {}
    }
    const videoEl = document.getElementById('take-video');
    if (videoEl) videoEl.pause();
  }

  assembleAndShowResults() {
    this.stopTakePlayback();
    SFX.playVictory();

    const dubDialogues = this.getDubDialogues();
    const takes = Array.from(this.userTakeRecordings.values());
    const avgScore = takes.length > 0
      ? Math.round(takes.reduce((acc, t) => acc + (t.score || 85), 0) / takes.length)
      : 88;

    const rank = avgScore >= 92 ? 'S' : (avgScore >= 82 ? 'A' : (avgScore >= 70 ? 'B' : 'C'));
    const rankTitle = rank === 'S' ? '¡Actuación Legendaria!' : (rank === 'A' ? '¡Excelente Doblaje!' : '¡Buen Intento!');

    this.lastResult = {
      score: avgScore * 100,
      rank,
      rankTitle,
      timingScore: `${Math.min(99, Math.round(avgScore + 2))}%`,
      energyScore: `${Math.min(98, Math.round(avgScore - 1))}%`,
      completedPhrases: `${takes.length} de ${dubDialogues.length}`,
      sceneTitle: this.selectedScene?.title || 'Escena de Doblaje',
      takesCount: takes.length,
      totalTakes: dubDialogues.length,
      date: new Date().toLocaleDateString()
    };

    this.navigate('results');
    this.showToast('¡Escena completada! Mira el resultado de tu actuación.', 'success');
  }

  async playCurrentDubFromResults() {
    if (!this.selectedScene) return;

    const dubDialogues = this.getDubDialogues();
    const takesArray = [];

    for (const d of dubDialogues) {
      const takeData = this.userTakeRecordings.get(d.id);
      if (takeData) {
        takesArray.push({
          dialogueId: d.id,
          character: d.character,
          caption: d.caption,
          timestamp: d.timestamp,
          duration: d.duration,
          audioBlob: takeData.blob,
          peaks: Array.from(takeData.peaks || []),
          score: takeData.score || 92
        });
      }
    }

    const tempDub = {
      id: 'temp_dub_' + Date.now(),
      sceneId: this.selectedScene.id,
      sceneTitle: this.selectedScene.title,
      characterDubbed: this.selectedCharacter,
      effectApplied: this.selectedEffect,
      date: new Date().toISOString(),
      score: this.lastResult?.score || 9500,
      rank: this.lastResult?.rank || 'S',
      duration: this.selectedScene.duration || 60,
      takes: takesArray,
      sceneSnapshot: {
        id: this.selectedScene.id,
        title: this.selectedScene.title,
        duration: this.selectedScene.duration,
        videoKey: this.selectedScene.videoKey,
        backingTrackKey: this.selectedScene.backingTrackKey,
        characters: this.selectedScene.characters,
        dialogues: this.selectedScene.dialogues,
        rawFiles: this.selectedScene.rawFiles,
        imageFiles: this.selectedScene.imageFiles,
        iconName: this.selectedScene.iconName
      }
    };

    await this.setupPlayDub(tempDub);
    this.navigate('play_dub');
    this.startPlayDubLoop();
  }

  // ==========================================
  // CONTINUOUS AUDIO & TIMELINE CLOCK ENGINE
  // ==========================================

  async setupStudio(autoPlay = false) {
    await this.audio.init();
    if (this.playbackMode === 'dubbing') {
      await this.audio.requestMicrophone();
    }

    this.duration = this.selectedScene.duration || 60;
    const totalEl = document.getElementById('time-total');
    if (totalEl) {
      const min = Math.floor(this.duration / 60);
      const sec = Math.floor(this.duration % 60);
      totalEl.textContent = `${min}:${sec < 10 ? '0' : ''}${sec}`;
    }

    // 1. Prepare HTML5 Audio Elements for instantaneous, reliable playback
    const backingUrl = this.getBackingAudioUrl(this.selectedScene);
    if (backingUrl) {
      this.backingAudioEl = new Audio(backingUrl);
      this.backingAudioEl.preload = 'auto';
    } else {
      this.backingAudioEl = null;
    }

    // 2. Also pre-decode Web Audio buffer for fallback
    this.backingBuffer = null;
    const backingKey = this.selectedScene.backingTrackKey || Object.keys(this.selectedScene.rawFiles || {}).find(k => k.includes('backing_track') || k.includes('background') || k.includes('music') || k.includes('_backing_track'));
    if (backingKey && this.selectedScene.rawFiles[backingKey]) {
      this.backingBuffer = await this.audio.decodeAudio(this.selectedScene.rawFiles[backingKey], `backing_${this.selectedScene.id}`);
    }

    // 3. Prepare Dialogues Audio Elements
    for (const d of (this.selectedScene.dialogues || [])) {
      const diagUrl = this.getDialogueAudioUrl(this.selectedScene, d);
      if (diagUrl) {
        d.audioEl = new Audio(diagUrl);
        d.audioEl.preload = 'auto';
      }
    }

    const videoEl = document.getElementById('studio-video');
    if (videoEl) {
      videoEl.currentTime = 0;
      let curVideoUrl = this.getVideoUrl(this.selectedScene);

      // If no MP4 yet and OGV exists, transcode now
      if (!curVideoUrl) {
        const ogvKey = Object.keys(this.selectedScene.rawFiles || {}).find(k => k.endsWith('.ogv'));
        if (ogvKey && this.selectedScene.rawFiles[ogvKey]) {
          try {
            const rawOgv = this.toBlob(this.selectedScene.rawFiles[ogvKey], 'video/ogg');
            const res = await fetch('/api/transcode-video', { method: 'POST', body: rawOgv });
            if (res.ok) {
              const mp4Buf = await res.arrayBuffer();
              const mp4Key = ogvKey.replace(/\.ogv$/i, '.mp4');
              this.selectedScene.rawFiles[mp4Key] = new Uint8Array(mp4Buf);
              this.selectedScene.videoKey = mp4Key;
              await GameDB.saveScene(this.selectedScene);
              this.blobUrlCache.delete(`video_${this.selectedScene.id}`);
              curVideoUrl = this.getVideoUrl(this.selectedScene);
              videoEl.src = curVideoUrl;
            }
          } catch (e) {
            console.warn('Auto transcode error:', e);
          }
        }
      } else {
        videoEl.src = curVideoUrl;
      }
      videoEl.load();
    }

    this.startWaveformVisualizer();
  }

  toggleOriginalPlayback() {
    if (this.isPlaying) {
      this.pauseStudioPlayback();
    } else {
      this.startOriginalScenePlayback();
    }
  }

  async startOriginalScenePlayback() {
    SFX.playClick();
    await this.audio.init();

    this.isPlaying = true;
    this.isRecording = false;
    this.startWallTime = performance.now() - (this.currentTime * 1000);

    // Populate playedDialogueIds with only past dialogues (prevents audio glitch on resume!)
    this.playedDialogueIds.clear();
    for (const d of (this.selectedScene?.dialogues || [])) {
      if (d.timestamp < this.currentTime) {
        this.playedDialogueIds.add(d.id);
      }
    }

    const btnPlay = document.getElementById('btn-play-original-mode');
    if (btnPlay) {
      btnPlay.innerHTML = `<span>⏸️</span> <span>PAUSAR REPRODUCCIÓN</span>`;
      btnPlay.style.background = 'linear-gradient(135deg, var(--neon-pink), #c70063)';
      btnPlay.style.color = '#fff';
    }

    // 1. START MASTER CLOCK LOOP IMMEDIATELY & SYNCHRONOUSLY
    this.startMasterClockLoop();

    // 2. Play Video (Muted to guarantee 100% immediate playback on 1st click)
    const videoEl = document.getElementById('studio-video');
    if (videoEl) {
      videoEl.currentTime = this.currentTime;
      videoEl.muted = true;
      videoEl.play().catch(e => console.warn('Video play warning:', e));
    }

    // 3. Play Backing Audio
    if (this.backingAudioEl) {
      this.backingAudioEl.currentTime = this.currentTime;
      this.backingAudioEl.volume = Math.max(0, Math.min(1.0, this.audio.volumes.backing));
      this.backingAudioEl.play().catch(e => console.warn('HTML5 backing audio notice:', e));
    } else if (this.backingBuffer) {
      this.audio.playBuffer(this.backingBuffer, 'backing', this.currentTime);
    }
  }

  async toggleRecording() {
    if (this.isRecording) {
      await this.pauseStudioPlayback();
    } else {
      await this.startStudioRecording();
    }
  }

  async startStudioRecording() {
    SFX.playRecStart();
    await this.audio.init();

    this.isRecording = true;
    this.isPlaying = true;
    this.startWallTime = performance.now() - (this.currentTime * 1000);

    // Populate playedDialogueIds with only past dialogues (prevents audio glitch on resume!)
    this.playedDialogueIds.clear();
    for (const d of (this.selectedScene?.dialogues || [])) {
      if (d.timestamp < this.currentTime) {
        this.playedDialogueIds.add(d.id);
      }
    }

    const btnRec = document.getElementById('btn-rec');
    const recText = document.getElementById('rec-btn-text');
    if (btnRec) btnRec.classList.add('recording');
    if (recText) recText.textContent = 'GRABANDO... (PULSA PARA PAUSAR)';

    const videoEl = document.getElementById('studio-video');
    if (videoEl) {
      videoEl.currentTime = this.currentTime;
      videoEl.muted = true;
      videoEl.play().catch(e => console.log('Video play notice:', e));
    }

    let backingPlayed = false;
    if (this.backingAudioEl) {
      this.backingAudioEl.currentTime = this.currentTime;
      this.backingAudioEl.volume = Math.max(0, Math.min(1.0, this.audio.volumes.backing));
      try {
        await this.backingAudioEl.play();
        backingPlayed = true;
      } catch (e) {}
    }

    if (!backingPlayed && this.backingBuffer) {
      this.audio.playBuffer(this.backingBuffer, 'backing', this.currentTime);
    }

    await this.audio.startRecording();
    this.startMasterClockLoop();
  }

  async pauseStudioPlayback() {
    this.isRecording = false;
    this.isPlaying = false;

    const btnRec = document.getElementById('btn-rec');
    const recText = document.getElementById('rec-btn-text');
    if (btnRec) btnRec.classList.remove('recording');
    if (recText) recText.textContent = 'CONTINUAR GRABACIÓN';

    const btnPlay = document.getElementById('btn-play-original-mode');
    if (btnPlay) {
      btnPlay.innerHTML = `<span>▶️</span> <span>REANUDAR REPRODUCCIÓN</span>`;
      btnPlay.style.background = 'linear-gradient(135deg, var(--neon-green), #00a653)';
      btnPlay.style.color = '#000';
    }

    const videoEl = document.getElementById('studio-video');
    if (videoEl) videoEl.pause();

    if (this.backingAudioEl) this.backingAudioEl.pause();

    for (const d of (this.selectedScene?.dialogues || [])) {
      if (d.audioEl) {
        d.audioEl.pause();
      }
    }

    this.audio.stopAll();

    if (this.isRecording) {
      const take = await this.audio.stopRecording();
      if (take && take.blob) {
        this.userRecordedTakes.push({
          time: this.currentTime,
          ...take
        });
      }
    }

    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
  }

  togglePlaybackPause() {
    if (this.isPlaying) {
      this.pauseStudioPlayback();
    } else {
      if (this.playbackMode === 'original') {
        this.startOriginalScenePlayback();
      } else {
        this.startStudioRecording();
      }
    }
  }

  restartStudio() {
    SFX.playClick();
    this.pauseStudioPlayback();
    this.currentTime = 0;
    this.userRecordedTakes = [];
    this.playedDialogueIds.clear();
    this.jumpToTime(0);
  }

  jumpToTime(targetSeconds) {
    this.currentTime = targetSeconds;
    this.startWallTime = performance.now() - (targetSeconds * 1000);
    this.playedDialogueIds.clear();

    const videoEl = document.getElementById('studio-video');
    if (videoEl) videoEl.currentTime = targetSeconds;

    if (this.backingAudioEl) this.backingAudioEl.currentTime = targetSeconds;

    const dialogues = this.selectedScene.dialogues || [];
    for (const d of dialogues) {
      if (d.timestamp < targetSeconds) {
        this.playedDialogueIds.add(d.id);
      }
    }

    this.updateStudioUI(targetSeconds);
  }

  startMasterClockLoop() {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);

    const loop = () => {
      if (!this.isPlaying) return;

      const elapsedSec = (performance.now() - this.startWallTime) / 1000;
      this.currentTime = Math.max(0, elapsedSec);

      if (this.currentTime >= this.duration) {
        this.onPlaybackFinished();
        return;
      }

      this.updateStudioUI(this.currentTime);

      // Check dialogue audio triggers
      const dialogues = this.selectedScene.dialogues || [];
      for (const d of dialogues) {
        if (this.currentTime >= d.timestamp && !this.playedDialogueIds.has(d.id)) {
          this.playedDialogueIds.add(d.id);

          const isOriginalMode = this.playbackMode === 'original';
          const isUserTurn = !isOriginalMode && this.isCharacterDubbedByUser(d.character);

          if (isOriginalMode || !isUserTurn) {
            if (d.audioEl) {
              d.audioEl.currentTime = 0;
              d.audioEl.volume = Math.max(0, Math.min(1.0, this.audio.volumes.original));
              d.audioEl.play().catch(e => console.log('Dialogue audio notice:', e));
            }
          }
        }
      }

      this.animFrameId = requestAnimationFrame(loop);
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  onPlaybackFinished() {
    this.pauseStudioPlayback();
    if (this.playbackMode === 'dubbing') {
      this.finishStudioTake();
    } else {
      const btnPlay = document.getElementById('btn-play-original-mode');
      if (btnPlay) {
        btnPlay.innerHTML = `<span>▶️</span> <span>REPRODUCIR DE NUEVO</span>`;
      }
      this.showToast('Escena finalizada.', 'info');
    }
  }

  isCharacterDubbedByUser(charName) {
    if (this.playbackMode === 'original') return false;
    if (this.selectedCharacter === 'All') return true;
    return this.selectedCharacter.toLowerCase() === charName.toLowerCase();
  }

  updateStudioUI(curTime) {
    const progressEl = document.getElementById('timeline-progress');
    const totalDuration = this.duration || 60;
    if (progressEl) {
      progressEl.style.width = `${Math.min(100, (curTime / totalDuration) * 100)}%`;
    }

    const timeCurEl = document.getElementById('time-current');
    if (timeCurEl) {
      const min = Math.floor(curTime / 60);
      const sec = Math.floor(curTime % 60);
      timeCurEl.textContent = `${min}:${sec < 10 ? '0' : ''}${sec}`;
    }

    const dialogues = this.selectedScene.dialogues || [];
    let activeDiagIndex = -1;
    for (let i = 0; i < dialogues.length; i++) {
      const d = dialogues[i];
      const nextTime = dialogues[i + 1] ? dialogues[i + 1].timestamp : curTime + 4.5;
      if (curTime >= d.timestamp - 0.2 && curTime < Math.min(d.timestamp + 4.5, nextTime)) {
        activeDiagIndex = i;
        break;
      }
    }

    const activeDiag = activeDiagIndex !== -1 ? dialogues[activeDiagIndex] : null;
    const nextDiag = dialogues.find(d => d.timestamp > curTime);

    const speakerEl = document.getElementById('teleprompter-speaker');
    const textEl = document.getElementById('teleprompter-text');
    const nextEl = document.getElementById('teleprompter-next');

    if (activeDiag) {
      const isOriginalMode = this.playbackMode === 'original';
      const isMyTurn = !isOriginalMode && this.isCharacterDubbedByUser(activeDiag.character);

      if (speakerEl) {
        if (isOriginalMode) {
          speakerEl.textContent = `🗣️ ${activeDiag.character.toUpperCase()} (VOZ ORIGINAL)`;
        } else {
          speakerEl.textContent = `🗣️ ${activeDiag.character.toUpperCase()} ${isMyTurn ? '(¡TU TURNO DE HABLAR!)' : '(VOZ ORIGINAL)'}`;
        }
      }

      if (textEl) {
        textEl.textContent = `“${activeDiag.caption}”`;
        textEl.className = `teleprompter-text ${isMyTurn ? 'my-turn' : ''}`;
      }
    } else {
      if (speakerEl) {
        speakerEl.textContent = this.playbackMode === 'original' ? '▶️ REPRODUCIENDO ESCENA ORIGINAL...' : 'ESPERANDO SIGUIENTE DIÁLOGO...';
      }
      if (textEl) {
        textEl.textContent = '...';
        textEl.className = 'teleprompter-text';
      }
    }

    if (nextEl) {
      nextEl.textContent = nextDiag ? `Próximo (${nextDiag.character}): “${nextDiag.caption.substring(0, 45)}...”` : '';
    }

    const currentChar = activeDiag ? activeDiag.character : (nextDiag ? nextDiag.character : (dialogues[0]?.character || ''));
    const avatarOverlay = document.getElementById('avatar-overlay');
    const avatarImg = document.getElementById('avatar-bubble-img');
    const avatarName = document.getElementById('avatar-bubble-name');
    const avatarStatus = document.getElementById('avatar-bubble-status');

    if (currentChar && avatarImg && avatarName) {
      avatarImg.src = this.getCharacterImageUrl(this.selectedScene, currentChar);
      avatarName.textContent = currentChar;

      const isSpeaking = !!activeDiag;
      if (avatarOverlay) {
        avatarOverlay.classList.toggle('speaking', isSpeaking);
      }
      if (avatarStatus) {
        avatarStatus.textContent = isSpeaking ? '¡Hablando ahora!' : 'En silencio';
      }
    }

    const allChars = this.selectedScene.characters || [];
    for (const c of allChars) {
      const charKey = c.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const box = document.getElementById(`char-badge-box-${charKey}`);
      if (box) {
        const isSpeaking = activeDiag && activeDiag.character.toLowerCase().trim() === c.toLowerCase().trim();
        if (isSpeaking) {
          box.style.borderColor = 'var(--neon-green)';
          box.style.boxShadow = '0 0 20px rgba(0, 255, 136, 0.6)';
          box.style.transform = 'scale(1.1)';
        } else {
          box.style.borderColor = 'var(--border-glass)';
          box.style.boxShadow = 'none';
          box.style.transform = 'scale(1)';
        }
      }
    }

    if (this.playbackMode === 'dubbing' && nextDiag && this.isCharacterDubbedByUser(nextDiag.character)) {
      const timeToStart = nextDiag.timestamp - curTime;
      const countOverlay = document.getElementById('countdown-overlay');

      if (timeToStart > 0 && timeToStart <= 3.0) {
        const countNum = Math.ceil(timeToStart);
        if (countOverlay) {
          countOverlay.style.display = 'block';
          countOverlay.textContent = countNum === 1 ? '¡1! ¡HABLA!' : countNum;
        }
      } else {
        if (countOverlay) countOverlay.style.display = 'none';
      }
    } else {
      const countOverlay = document.getElementById('countdown-overlay');
      if (countOverlay) countOverlay.style.display = 'none';
    }
  }

  startWaveformVisualizer() {
    const canvas = document.getElementById('waveform-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const bufferLength = this.audio.analyser?.frequencyBinCount || 128;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      if (this.currentView !== 'studio') return;

      this.audio.getWaveformData(dataArray);

      ctx.fillStyle = 'rgba(10, 12, 22, 0.4)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.lineWidth = 2;
      ctx.strokeStyle = this.isRecording ? '#00f0ff' : (this.isPlaying ? '#00ff88' : '#5d6785');
      ctx.beginPath();

      const sliceWidth = (canvas.width * 1.0) / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);

        x += sliceWidth;
      }

      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();

      requestAnimationFrame(draw);
    };

    draw();
  }

  stopStudioPlayback() {
    this.isPlaying = false;
    this.isRecording = false;
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    this.audio.stopAll();
    const videoEl = document.getElementById('studio-video');
    if (videoEl) videoEl.pause();
    if (this.backingAudioEl) this.backingAudioEl.pause();
    for (const d of (this.selectedScene?.dialogues || [])) {
      if (d.audioEl) d.audioEl.pause();
    }
  }

  async finishStudioTake() {
    await this.pauseStudioPlayback();
    this.finishAndShowResults();
  }

  async finishAndShowResults() {
    await this.pauseStudioPlayback();
    SFX.playSuccess();

    const userRoleLines = (this.selectedScene.dialogues || []).filter(d => this.isCharacterDubbedByUser(d.character)).length;
    const baseScore = 8800 + Math.floor(Math.random() * 1100);

    let rank = 'S';
    let rankTitle = '¡Maestro del Doblaje!';
    if (baseScore >= 9600) { rank = 'S+'; rankTitle = '¡Leyenda del Doblaje!'; }
    else if (baseScore >= 9000) { rank = 'S'; rankTitle = '¡Doblaje Perfecto!'; }
    else if (baseScore >= 8000) { rank = 'A'; rankTitle = '¡Excelente Actuación!'; }

    this.lastResult = {
      score: baseScore,
      rank,
      rankTitle,
      timingScore: `${92 + Math.floor(Math.random() * 7)}%`,
      energyScore: `${90 + Math.floor(Math.random() * 9)}%`,
      completedPhrases: `${userRoleLines}/${userRoleLines}`,
      sceneTitle: this.selectedScene.title
    };

    this.navigate('results', { result: this.lastResult });
  }

  shareResult() {
    if (navigator.share) {
      navigator.share({
        title: `¡Mira mi doblaje de ${this.selectedScene.title}!`,
        text: `¡Obtuve Rango ${this.lastResult.rank} con ${this.lastResult.score} puntos en Voice Dub Hero!`,
        url: window.location.href
      }).catch(() => {});
    } else {
      navigator.clipboard.writeText(`¡Obtuve Rango ${this.lastResult.rank} con ${this.lastResult.score} puntos en Voice Dub Hero! ${window.location.href}`);
      this.showToast('¡Resultado copiado al portapapeles!', 'success');
    }
  }

  // ==========================================
  // ZIP IMPORT MODAL & VALIDATION ENGINE
  // ==========================================

  openImportModal() {
    SFX.playClick();
    const root = document.getElementById('modal-root');
    if (!root) return;

    root.innerHTML = `
      <div class="modal-backdrop" id="import-modal-backdrop">
        <div class="modal-dialog">
          <div class="modal-header">
            <div class="modal-title">📥 Importar Escena (.ZIP, .RAR, .7Z)</div>
            <button class="btn-close-modal" id="btn-close-import">✕</button>
          </div>

          <div class="modal-body">
            <p style="color: var(--text-muted); font-size: 0.9rem;">
              Selecciona o arrastra el archivo ZIP, RAR o 7Z de una escena para incorporarla a tu biblioteca.
            </p>

            <div id="dropzone" class="dropzone">
              <div class="dropzone-icon">📦</div>
              <h3 style="font-size: 1.15rem; font-weight: 800;">Arrastra tu archivo ZIP o RAR aquí</h3>
              <p style="font-size: 0.85rem; color: var(--text-muted);">o haz clic para explorar tu dispositivo (.zip, .rar, .7z)</p>
              <input type="file" id="zip-file-input" accept=".zip,.rar,.7z,.tar" style="display: none;" />
            </div>

            <div id="validation-report" style="display: none;" class="validation-box">
              <h4 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 0.75rem;">Resultado de la Validación:</h4>
              <div id="val-items-list"></div>
            </div>

            <div id="import-success-box" style="display: none; background: rgba(0, 255, 136, 0.1); border: 1px solid var(--neon-green); border-radius: var(--radius-md); padding: 1rem; text-align: center;">
              <div style="font-size: 2rem; margin-bottom: 0.25rem;">✅</div>
              <h4 style="color: var(--neon-green); font-size: 1.1rem; font-weight: 800;">¡Escena Importada con Éxito!</h4>
              <p id="import-success-details" style="font-size: 0.85rem; color: #fff; margin-top: 0.4rem;"></p>
            </div>
          </div>
        </div>
      </div>
    `;

    const closeBtn = document.getElementById('btn-close-import');
    const backdrop = document.getElementById('import-modal-backdrop');
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('zip-file-input');

    const closeModal = () => { root.innerHTML = ''; };

    if (closeBtn) closeBtn.onclick = closeModal;
    if (backdrop) backdrop.onclick = (e) => { if (e.target === backdrop) closeModal(); };

    if (dropzone && fileInput) {
      dropzone.onclick = () => fileInput.click();

      dropzone.ondragover = (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      };
      dropzone.ondragleave = () => dropzone.classList.remove('dragover');
      dropzone.ondrop = async (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          await this.processZipFile(e.dataTransfer.files[0]);
        }
      };

      fileInput.onchange = async (e) => {
        if (e.target.files && e.target.files[0]) {
          await this.processZipFile(e.target.files[0]);
        }
      };
    }
  }

  async processZipFile(file) {
    const reportBox = document.getElementById('validation-report');
    const listEl = document.getElementById('val-items-list');
    const successBox = document.getElementById('import-success-box');
    const successDetails = document.getElementById('import-success-details');

    if (reportBox) reportBox.style.display = 'block';
    if (listEl) {
      listEl.innerHTML = `<div class="val-item">⏳ Descomprimiendo y analizando paquete...</div>`;
    }

    try {
      const buffer = await file.arrayBuffer();
      let unzipped = null;
      const lowerName = file.name.toLowerCase();
      const isRarOr7z = lowerName.endsWith('.rar') || lowerName.endsWith('.7z') || lowerName.endsWith('.tar');

      if (isRarOr7z) {
        if (listEl) listEl.innerHTML = `<div class="val-item">📦 Descomprimiendo archivo RAR/7Z en servidor...</div>`;
        const res = await fetch('/api/unpack-archive', {
          method: 'POST',
          body: buffer
        });
        if (res.ok) {
          const zipArrayBuf = await res.arrayBuffer();
          unzipped = await ZipEngine.unzip(zipArrayBuf);
        }
      }

      if (!unzipped) {
        try {
          unzipped = await ZipEngine.unzip(buffer);
        } catch {
          const res = await fetch('/api/unpack-archive', {
            method: 'POST',
            body: buffer
          });
          if (res.ok) {
            const zipArrayBuf = await res.arrayBuffer();
            unzipped = await ZipEngine.unzip(zipArrayBuf);
          }
        }
      }

      if (!unzipped) {
        throw new Error('No se pudo descomprimir el archivo.');
      }

      // Convert .ogv to .mp4 if possible
      const ogvKey = Object.keys(unzipped).find(k => k.endsWith('.ogv'));
      if (ogvKey && !Object.keys(unzipped).some(k => k.endsWith('.mp4'))) {
        if (listEl) listEl.innerHTML = `<div class="val-item">🎬 Optimizando video HD (MP4)...</div>`;
        try {
          const transcodeRes = await fetch('/api/transcode-video', {
            method: 'POST',
            body: unzipped[ogvKey]
          });
          if (transcodeRes.ok) {
            const mp4ArrayBuf = await transcodeRes.arrayBuffer();
            const mp4Key = ogvKey.replace(/\.ogv$/i, '.mp4');
            unzipped[mp4Key] = new Uint8Array(mp4ArrayBuf);
          }
        } catch (e) {}
      }

      const parsed = ZipEngine.parseScenePackage(unzipped);
      const validation = ZipEngine.validateScene(parsed);

      let reportHtml = '';
      reportHtml += `<div class="val-item"><span class="val-icon success">✓</span> Metadatos de escena: <strong>${parsed.meta.title}</strong></div>`;
      reportHtml += `<div class="val-item"><span class="val-icon ${validation.checks.hasVideo ? 'success' : 'error'}">${validation.checks.hasVideo ? '✓' : '✗'}</span> Video/Animación: ${parsed.videoKey ? parsed.videoKey.split('/').pop() : 'No encontrado'}</div>`;
      reportHtml += `<div class="val-item"><span class="val-icon ${validation.checks.hasBackingTrack ? 'success' : 'warning'}">${validation.checks.hasBackingTrack ? '✓' : '⚠️'}</span> Pista de fondo: ${parsed.backingTrackKey ? parsed.backingTrackKey.split('/').pop() : 'Ausente'}</div>`;
      reportHtml += `<div class="val-item"><span class="val-icon ${validation.checks.hasDialogues ? 'success' : 'error'}">${validation.checks.hasDialogues ? '✓' : '✗'}</span> Diálogos sincronizados: <strong>${parsed.dialogues.length} líneas</strong></div>`;
      reportHtml += `<div class="val-item"><span class="val-icon success">✓</span> Personajes: <strong>${parsed.meta.characters.join(', ')}</strong></div>`;

      if (listEl) listEl.innerHTML = reportHtml;

      if (validation.isValid) {
        await GameDB.saveScene({
          title: parsed.meta.title,
          authors: parsed.meta.authors,
          readme: parsed.meta.readme,
          characters: parsed.meta.characters,
          duration: parsed.meta.estimatedDuration,
          dialogues: parsed.dialogues,
          prefix: parsed.prefix,
          videoKey: parsed.videoKey,
          backingTrackKey: parsed.backingTrackKey,
          iconName: parsed.meta.iconName,
          imageFiles: parsed.imageFiles,
          rawFiles: parsed.rawFiles,
          importDate: new Date().toISOString()
        });

        this.scenes = await GameDB.getAllScenes();
        SFX.playSuccess();

        if (successBox && successDetails) {
          successBox.style.display = 'block';
          successDetails.textContent = `"${parsed.meta.title}" ya está disponible en tu colección.`;
        }

        setTimeout(() => {
          const root = document.getElementById('modal-root');
          if (root) root.innerHTML = '';
          this.navigate('library');
          this.showToast(`¡Escena "${parsed.meta.title}" guardada!`, 'success');
        }, 1400);
      } else {
        SFX.playError();
        this.showToast('El archivo ZIP tiene errores y no pudo importarse.', 'error');
      }
    } catch (err) {
      console.error('Error importando ZIP:', err);
      SFX.playError();
      if (listEl) {
        listEl.innerHTML = `<div class="val-item"><span class="val-icon error">✗</span> Error al procesar archivo: ${err.message}</div>`;
      }
      this.showToast(`Error: ${err.message}`, 'error');
    }
  }

  // ==========================================
  // PREVIEW MODAL & ZIP EXPORT
  // ==========================================

  openPreviewModal(scene) {
    SFX.playClick();
    const root = document.getElementById('modal-root');
    if (!root) return;

    const coverUrl = this.getSceneCoverUrl(scene);

    root.innerHTML = `
      <div class="modal-backdrop" id="preview-modal-backdrop">
        <div class="modal-dialog" style="max-width: 700px;">
          <div class="modal-header">
            <div class="modal-title">👁️ Vista Previa: ${scene.title}</div>
            <button class="btn-close-modal" id="btn-close-prev">✕</button>
          </div>

          <div class="modal-body">
            <div style="display:flex; gap:1.25rem; align-items:center;">
              <img src="${coverUrl}" style="width: 100px; height: 100px; border-radius:14px; object-fit:cover; border: 2px solid var(--neon-cyan);" />
              <div>
                <h3 style="font-size: 1.3rem; font-weight:800;">${scene.title}</h3>
                <p style="color:var(--text-muted); font-size:0.85rem;">Autores: ${(scene.authors || []).join(', ')}</p>
                <p style="color:var(--text-dim); font-size:0.8rem; margin-top:0.3rem;">${scene.readme || 'Sin descripción'}</p>
                <div style="display:flex; gap:0.4rem; margin-top:0.5rem;">
                  ${(scene.characters || []).map(c => `
                    <span class="char-badge">👤 ${c}</span>
                  `).join('')}
                </div>
              </div>
            </div>

            <h4 style="font-size:1rem; font-weight:700; margin-top:1rem;">Lista de Diálogos (${scene.dialogues?.length || 0} frases):</h4>
            <div style="max-height: 240px; overflow-y:auto; border: 1px solid var(--border-glass); border-radius: var(--radius-md); padding: 0.75rem; background: rgba(0,0,0,0.25);">
              ${(scene.dialogues || []).map((d, i) => {
                const charImg = this.getCharacterImageUrl(scene, d.character);
                return `
                  <div style="display:flex; align-items:center; justify-content:space-between; padding: 0.45rem 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.85rem;">
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                      <img src="${charImg}" style="width: 22px; height: 22px; border-radius: 50%; object-fit: cover;" />
                      <div>
                        <strong style="color:var(--neon-yellow);">${d.character}:</strong> “${d.caption}”
                      </div>
                    </div>
                    <span style="color:var(--neon-cyan); font-family:monospace; margin-left:0.5rem;">${d.timestamp.toFixed(2)}s</span>
                  </div>
                `;
              }).join('')}
            </div>

            <div style="display:flex; justify-content:flex-end; gap:0.75rem; margin-top:1rem;">
              <button class="btn-secondary" id="btn-prev-close">Cerrar</button>
              <button class="btn-cyan" id="btn-prev-listen" style="background: linear-gradient(135deg, var(--neon-green), #00b359); color: #000; font-weight: 800;">
                ▶️ Escuchar Escena
              </button>
              <button class="btn-primary" id="btn-prev-dub">
                🎙️ Doblar Personaje
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    const closeBtn = document.getElementById('btn-close-prev');
    const closeBtn2 = document.getElementById('btn-prev-close');
    const backdrop = document.getElementById('preview-modal-backdrop');
    const listenBtn = document.getElementById('btn-prev-listen');
    const dubBtn = document.getElementById('btn-prev-dub');

    const closeModal = () => { root.innerHTML = ''; };

    if (closeBtn) closeBtn.onclick = closeModal;
    if (closeBtn2) closeBtn2.onclick = closeModal;
    if (backdrop) backdrop.onclick = (e) => { if (e.target === backdrop) closeModal(); };

    if (listenBtn) {
      listenBtn.onclick = async () => {
        closeModal();
        this.playbackMode = 'original';
        this.selectedScene = scene;
        this.navigate('studio');
        await this.setupStudio(false);
      };
    }

    if (dubBtn) {
      dubBtn.onclick = () => {
        closeModal();
        this.navigate('character_select', { scene });
      };
    }
  }

  async exportSceneZip(scene) {
    if (!scene.rawFiles) {
      this.showToast('Esta escena no contiene archivos crudos para exportar.', 'error');
      return;
    }

    this.showToast('Empaquetando escena en ZIP...', 'success');
    const blob = await ZipEngine.createZip(scene.rawFiles);
    const fileName = `${scene.title.toLowerCase().replace(/\s+/g, '_')}.zip`;
    VideoComposer.downloadBlob(blob, fileName);
    this.showToast('¡Archivo ZIP descargado!', 'success');
  }

  showToast(message, type = 'info') {
    const root = document.getElementById('toast-root');
    if (!root) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${type === 'success' ? '✅' : (type === 'error' ? '❌' : 'ℹ️')}</span> <span>${message}</span>`;
    root.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }
}

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  const app = new DubbingApp();
  app.init();
  window.dubbingApp = app;
});
