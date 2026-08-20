/**
 * Database Module (IndexedDB)
 * Persistently stores imported ZIP scenes, character assets, user dubbing takes, and game settings.
 */

const DB_NAME = 'JuegoDoblajeDB';
const DB_VERSION = 1;

export class GameDB {
  static _db = null;

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

      const req = store.put(sceneData);
      req.onsuccess = () => resolve(sceneData.id);
      req.onerror = () => reject(req.error);
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
        resolve(scenes);
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

      req.onsuccess = () => resolve(req.result || null);
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

      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
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

      const req = store.put(recordingData);
      req.onsuccess = () => resolve(recordingData.id);
      req.onerror = () => reject(req.error);
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
        resolve(records);
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

      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
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

      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }
}
