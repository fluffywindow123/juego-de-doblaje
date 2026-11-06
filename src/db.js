/**
 * Database Module (IndexedDB)
 * Persistently stores imported ZIP scenes, character assets, user dubbing takes, and game settings.
 */

const DB_NAME = 'JuegoDoblajeDB';
const DB_VERSION = 1;

export class GameDB {
  static _db = null;

  /**
   * Resolve when the write transaction is committed (not just when the request
   * succeeds): a QuotaExceededError aborts the transaction AFTER req.onsuccess.
   */
  static _commit(tx, req, value) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error || req.error || new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error || req.error);
    });
  }

  /**
   * Prepare a scene for IndexedDB:
   *  - drop runtime-only fields (HTMLAudioElement players can't be stored);
   *  - store each file as a Blob. Browsers refuse records bigger than ~133 MB, but Blobs
   *    are kept outside the record, so scenes of any size (video + audio) can be saved.
   */
  static _toStorable(scene) {
    if (!scene) return scene;
    const out = { ...scene };
    if (Array.isArray(scene.dialogues)) {
      out.dialogues = scene.dialogues.map(d => {
        if (!d || !('audioEl' in d)) return d;
        const { audioEl, ...rest } = d;
        return rest;
      });
    }
    if (scene.rawFiles && typeof scene.rawFiles === 'object') {
      out.rawFiles = {};
      for (const [key, value] of Object.entries(scene.rawFiles)) {
        if (value instanceof Blob) out.rawFiles[key] = value;
        else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) out.rawFiles[key] = new Blob([value]);
        else out.rawFiles[key] = value;
      }
    }
    return out;
  }

  /** Inverse of _toStorable: the game works with Uint8Array files in memory */
  static async _fromStored(scene) {
    if (!scene || !scene.rawFiles) return scene;
    const entries = await Promise.all(Object.entries(scene.rawFiles).map(async ([key, value]) => {
      if (value instanceof Blob) return [key, new Uint8Array(await value.arrayBuffer())];
      return [key, value];
    }));
    scene.rawFiles = Object.fromEntries(entries);
    return scene;
  }

  static async getDB() {
    if (this._db) return this._db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Store for scenes
        if (!db.objectStoreNames.contains('scenes')) {
          const sceneStore = db.createObjectStore('scenes', { keyPath: 'id' });
          sceneStore.createIndex('title', 'title', { unique: false });
          sceneStore.createIndex('importDate', 'importDate', { unique: false });
        }

        // Store for completed dubbings / recordings
        if (!db.objectStoreNames.contains('recordings')) {
          const recStore = db.createObjectStore('recordings', { keyPath: 'id' });
          recStore.createIndex('sceneId', 'sceneId', { unique: false });
          recStore.createIndex('date', 'date', { unique: false });
        }

        // Store for user settings
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this._db = event.target.result;
        resolve(this._db);
      };

      request.onerror = (event) => {
        console.error('Error abriendo IndexedDB:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Save a newly imported scene into IndexedDB
   */
  static async saveScene(sceneData) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('scenes', 'readwrite');
      const store = tx.objectStore('scenes');

      // Generate a unique ID if not present
      if (!sceneData.id) {
        sceneData.id = 'scene_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      }
      if (!sceneData.importDate) {
        sceneData.importDate = new Date().toISOString();
      }

      const req = store.put(this._toStorable(sceneData));
      this._commit(tx, req, sceneData.id).then(resolve, reject);
    });
  }

  /**
   * Get all saved scenes from the library
   */
  static async getAllScenes() {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('scenes', 'readonly');
      const store = tx.objectStore('scenes');
      const req = store.getAll();

      req.onsuccess = () => {
        // Sort newest first
        const scenes = req.result || [];
        scenes.sort((a, b) => new Date(b.importDate || 0) - new Date(a.importDate || 0));
        Promise.all(scenes.map(s => this._fromStored(s))).then(resolve, reject);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get a specific scene by ID
   */
  static async getScene(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('scenes', 'readonly');
      const store = tx.objectStore('scenes');
      const req = store.get(id);

      req.onsuccess = () => this._fromStored(req.result || null).then(resolve, reject);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Delete a scene by ID
   */
  static async deleteScene(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('scenes', 'readwrite');
      const store = tx.objectStore('scenes');
      const req = store.delete(id);
      this._commit(tx, req, true).then(resolve, reject);
    });
  }

  /**
   * Save a completed recording / dubbing session
   */
  static async saveRecording(recordingData) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('recordings', 'readwrite');
      const store = tx.objectStore('recordings');

      if (!recordingData.id) {
        recordingData.id = 'rec_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      }
      if (!recordingData.date) {
        recordingData.date = new Date().toISOString();
      }

      const toStore = recordingData.sceneSnapshot
        ? { ...recordingData, sceneSnapshot: this._toStorable(recordingData.sceneSnapshot) }
        : recordingData;
      const req = store.put(toStore);
      this._commit(tx, req, recordingData.id).then(resolve, reject);
    });
  }

  /**
   * Get all recordings
   */
  static async getAllRecordings() {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('recordings', 'readonly');
      const store = tx.objectStore('recordings');
      const req = store.getAll();

      req.onsuccess = () => {
        const records = req.result || [];
        records.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        Promise.all(records.map(async r => {
          if (r.sceneSnapshot) await this._fromStored(r.sceneSnapshot);
          return r;
        })).then(resolve, reject);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get a single recording by ID
   */
  static async getRecording(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('recordings', 'readonly');
      const store = tx.objectStore('recordings');
      const req = store.get(id);

      req.onsuccess = async () => {
        const r = req.result || null;
        if (r?.sceneSnapshot) await this._fromStored(r.sceneSnapshot);
        resolve(r);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Delete a recording
   */
  static async deleteRecording(id) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('recordings', 'readwrite');
      const store = tx.objectStore('recordings');
      const req = store.delete(id);
      this._commit(tx, req, true).then(resolve, reject);
    });
  }

  /**
   * Get application setting
   */
  static async getSetting(key, defaultValue = null) {
    const db = await this.getDB();
    return new Promise((resolve) => {
      const tx = db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const req = store.get(key);

      req.onsuccess = () => {
        resolve(req.result ? req.result.value : defaultValue);
      };
      req.onerror = () => resolve(defaultValue);
    });
  }

  /**
   * Save application setting
   */
  static async setSetting(key, value) {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const req = store.put({ key, value });
      this._commit(tx, req, true).then(resolve, reject);
    });
  }
}
