/**
 * ZipEngine - Fast, standalone ZIP parser and creator using native Web Streams API
 * Supports deflate, deflate-raw, stored methods, multi-format scene parsing (.txt, .ini, .ogv, .mp4),
 * and dynamic dialogue timestamp & character extraction for all GameBanana mods.
 */

export class ZipEngine {
  /**
   * Parse a ZIP ArrayBuffer or Uint8Array into a dictionary of files
   * @param {ArrayBuffer | Uint8Array} inputBuffer 
   * @returns {Promise<Record<string, Uint8Array>>}
   */
  static async unzip(inputBuffer) {
    const buffer = inputBuffer instanceof Uint8Array ? inputBuffer : new Uint8Array(inputBuffer);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const files = {};

    // 1. Locate End of Central Directory Record (EOCD)
    let eocdOffset = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset === -1) {
      throw new Error("El archivo seleccionado no es un archivo ZIP válido.");
    }

    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const totalEntries = view.getUint16(eocdOffset + 10, true);

    let p = cdOffset;
    const decoder = new TextDecoder('utf-8');

    for (let i = 0; i < totalEntries; i++) {
      if (p + 46 > buffer.byteLength) break;
      if (view.getUint32(p, true) !== 0x02014b50) break; // Central directory file header signature

      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const uncompSize = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localHeaderOffset = view.getUint32(p + 42, true);

      const nameBuf = buffer.subarray(p + 46, p + 46 + nameLen);
      const fileName = decoder.decode(nameBuf);

      // Skip the hidden metadata macOS adds when compressing with Finder
      // (__MACOSX/ folder, AppleDouble "._x" files, .DS_Store): they are not scene files
      const baseName = fileName.substring(fileName.lastIndexOf('/') + 1);
      const isMacJunk = /(^|\/)__MACOSX\//.test(fileName) || baseName.startsWith('._') || baseName === '.DS_Store';

      // Read local header to calculate exact data offset
      if (!isMacJunk && localHeaderOffset + 30 <= buffer.byteLength) {
        const localNameLen = view.getUint16(localHeaderOffset + 26, true);
        const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
        const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;
        const rawData = buffer.subarray(dataOffset, dataOffset + compSize);

        let decompressed;
        if (fileName.endsWith('/')) {
          decompressed = new Uint8Array(0);
        } else if (method === 0) { // Stored (no compression)
          decompressed = new Uint8Array(rawData);
        } else if (method === 8) { // Deflate
          try {
            // Piping through a Response surfaces every stream error as a rejection here
            // (unawaited writer.write()/close() promises used to crash Node on bad data)
            const stream = new Blob([rawData]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
          } catch (err) {
            // Corrupt entry: skip it rather than storing the compressed bytes as content
            console.error(`Error descomprimiendo ${fileName}:`, err);
            decompressed = null;
          }
        } else {
          console.warn(`Método de compresión desconocido (${method}) para ${fileName}`);
          decompressed = null;
        }

        if (decompressed) files[fileName] = decompressed;
      }

      p += 46 + nameLen + extraLen + commentLen;
    }

    return files;
  }

  /**
   * Automatically detect if a ZIP contains multiple scenes (e.g. "Película 1/", "Película 2/" subfolders)
   * or a single scene, and parse each scene independently.
   * @param {Record<string, Uint8Array>} files
   * @returns {Array<any>} Array of parsed scene objects
   */
  static parseAllScenes(files) {
    const fileKeys = Object.keys(files);
    if (fileKeys.length === 0) {
      throw new Error("El archivo ZIP está vacío.");
    }

    // Check if there are multiple subfolders containing dialogue files or pack_info
    const topFolders = new Set();
    for (const key of fileKeys) {
      const parts = key.split('/');
      if (parts.length > 1 && parts[0].trim().length > 0) {
        topFolders.add(parts[0]);
      }
    }

    // Check how many subfolders look like complete standalone scenes
    const sceneFolders = [];
    for (const folder of topFolders) {
      const folderPrefix = folder + '/';
      const folderFiles = fileKeys.filter(k => k.startsWith(folderPrefix));
      const hasDialogues = folderFiles.some(k => {
        const lower = k.toLowerCase();
        return (lower.endsWith('.txt') || lower.endsWith('.ini')) && !lower.endsWith('pack_info.ini') && !lower.endsWith('info.ini') && !lower.endsWith('readme.txt');
      });
      const hasAudioOrVideo = folderFiles.some(k => {
        const lower = k.toLowerCase();
        return lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.ogv') || lower.endsWith('.mp3') || lower.endsWith('.ogg') || lower.endsWith('.wav');
      });

      if (hasDialogues && hasAudioOrVideo) {
        sceneFolders.push(folder);
      }
    }

    // If multiple distinct scenes are found in subfolders, parse each one separately!
    if (sceneFolders.length > 1) {
      const parsedScenes = [];
      for (const folder of sceneFolders) {
        const folderPrefix = folder + '/';
        const subsetFiles = {};
        for (const key of fileKeys) {
          if (key.startsWith(folderPrefix)) {
            subsetFiles[key] = files[key];
          }
        }
        try {
          const parsed = this.parseScenePackage(subsetFiles);
          if (!parsed.meta.title || parsed.meta.title === 'Escena de Doblaje') {
            parsed.meta.title = folder;
          }
          parsedScenes.push(parsed);
        } catch (err) {
          console.warn(`Could not parse sub-scene in folder "${folder}":`, err);
        }
      }
      if (parsedScenes.length > 0) {
        return parsedScenes;
      }
    }

    // Default: Single scene package
    return [this.parseScenePackage(files)];
  }

  /**
   * Parse scene metadata and files from unzipped files map (Supports all GameBanana mod formats)
   * @param {Record<string, Uint8Array>} files 
   */
  static parseScenePackage(files) {
    const fileKeys = Object.keys(files);
    if (fileKeys.length === 0) {
      throw new Error("El archivo ZIP está vacío.");
    }

    // Determine root directory prefix if files are inside a subfolder
    let prefix = '';
    const iniKey = fileKeys.find(k => k.endsWith('_pack_info.ini') || k.endsWith('pack_info.ini') || k.endsWith('info.ini'));
    if (iniKey) {
      const slashIdx = iniKey.lastIndexOf('/');
      if (slashIdx !== -1) {
        prefix = iniKey.substring(0, slashIdx + 1);
      }
    } else {
      // Look for common subfolder
      const firstSlash = fileKeys.find(k => k.includes('/'));
      if (firstSlash) {
        prefix = firstSlash.substring(0, firstSlash.indexOf('/') + 1);
      }
    }

    // 1. Read pack info
    let packInfo = {
      title: '',
      icon: '',
      authors: [],
      readme: '',
      preselected_dub_characters: []
    };

    if (iniKey && files[iniKey]) {
      const text = new TextDecoder('utf-8').decode(files[iniKey]);
      packInfo = { ...packInfo, ...this.parseIni(text) };
    }

    // Fallback title from prefix or first parent folder
    if (!packInfo.title) {
      if (prefix) {
        packInfo.title = prefix.replace(/\/$/, '').trim();
      } else {
        packInfo.title = 'Escena de Doblaje';
      }
    }

    // 2. Locate video file (prioritizing mp4 / webm for universal browser support)
    let videoKey = fileKeys.find(k => k.startsWith(prefix) && (k.endsWith('.mp4') || k.endsWith('.webm')));
    if (!videoKey) {
      videoKey = fileKeys.find(k => k.startsWith(prefix) && (k.endsWith('.ogv') || k.endsWith('.mkv') || k.endsWith('.avi')));
    }
    if (!videoKey) {
      videoKey = fileKeys.find(k => k.endsWith('.mp4') || k.endsWith('.webm') || k.endsWith('.ogv'));
    }

    // 3. Locate backing track
    // Only audio files qualify (a "background.png" used to be picked as the music)
    const isAudioFile = (k) => /\.(mp3|ogg|wav|m4a)$/i.test(k);
    const looksLikeBacking = (k) => {
      const name = k.substring(k.lastIndexOf('/') + 1).toLowerCase();
      return name.includes('backing_track') || name.includes('background') || name.includes('music') || name.includes('bgm') || name.includes('instrumental');
    };
    let backingTrackKey = fileKeys.find(k => k.startsWith(prefix) && isAudioFile(k) && looksLikeBacking(k));
    if (!backingTrackKey) {
      backingTrackKey = fileKeys.find(k => isAudioFile(k) && looksLikeBacking(k));
    }

    // 4. Locate dialogue files (.txt or .ini files excluding pack_info)
    const isPackInfo = (k) => {
      const lower = k.toLowerCase();
      return lower.endsWith('_pack_info.ini') || lower.endsWith('pack_info.ini') || lower.endsWith('info.ini') || lower.endsWith('readme.txt') || lower.endsWith('readme.md');
    };

    const dialogueKeys = fileKeys.filter(k => {
      if (isPackInfo(k)) return false;
      const lower = k.toLowerCase();
      return lower.endsWith('.txt') || lower.endsWith('.ini');
    });

    // Sort dialogue keys numerically/alphabetically (01_..., 02_..., 101_..., 201_...)
    dialogueKeys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const dialogues = [];
    const charactersSet = new Set(packInfo.preselected_dub_characters || []);

    for (const dKey of dialogueKeys) {
      const rawText = new TextDecoder('utf-8').decode(files[dKey]);
      const parsedData = this.parseIni(rawText);
      const baseName = dKey.substring(dKey.lastIndexOf('/') + 1).replace(/\.(txt|ini)$/i, '');

      // Extract timestamp from parsed INI / TXT data
      let timestamp = 0;
      if (parsedData.dub_timestamps && parsedData.dub_timestamps[0] !== undefined) {
        timestamp = Number(parsedData.dub_timestamps[0]);
      } else if (parsedData.dub_timestamp !== undefined) {
        timestamp = Number(parsedData.dub_timestamp);
      } else if (parsedData.timestamp !== undefined) {
        timestamp = Number(parsedData.timestamp);
      } else {
        // Try to parse timestamp from filename: e.g. "01_NewsReporter04,265" -> 4.265, "25,314" -> 25.314
        const timeMatch = baseName.match(/(\d+)[,\.](\d+)/);
        if (timeMatch) {
          timestamp = parseFloat(`${timeMatch[1]}.${timeMatch[2]}`);
        }
      }
      if (isNaN(timestamp)) timestamp = 0;

      // Extract character name
      let charName = '';
      if (parsedData.dub_characters && parsedData.dub_characters.length > 0) {
        charName = parsedData.dub_characters[0];
      } else if (parsedData.dub_character) {
        charName = parsedData.dub_character;
      } else if (parsedData.character) {
        charName = parsedData.character;
      } else if (parsedData.speaker) {
        charName = parsedData.speaker;
      } else {
        // Infer from baseName: e.g. "01_Buzz" -> "Buzz", "201_Woody" -> "Woody"
        const cleanBase = baseName.replace(/^\d+[_]/, '').replace(/[_]?\d+[,\.]\d+.*$/, '');
        charName = cleanBase.trim() || 'Personaje';
      }

      if (charName) charactersSet.add(charName);

      // Locate matching audio (.mp3, .ogg, .wav)
      const baseLower = baseName.toLowerCase();
      let matchingAudioKey = fileKeys.find(k => {
        const lower = k.toLowerCase();
        const fileLower = lower.substring(lower.lastIndexOf('/') + 1);
        return fileLower === `${baseLower}.mp3` || fileLower === `${baseLower}.ogg` || fileLower === `${baseLower}.wav`;
      });

      // Fuzzy matching if filename had timestamp suffix
      if (!matchingAudioKey) {
        const numberPrefix = baseName.match(/^(\d+)/)?.[1];
        if (numberPrefix) {
          matchingAudioKey = fileKeys.find(k => {
            const fileName = k.substring(k.lastIndexOf('/') + 1);
            // Same number, not just same leading digits ("1_buzz" must not match "10_woody.mp3")
            return fileName.match(/^(\d+)/)?.[1] === numberPrefix && /\.(mp3|ogg|wav)$/i.test(fileName);
          });
        }
      }

      // Locate matching image if specified in parsedData.image
      let imageFile = parsedData.image || '';

      dialogues.push({
        id: baseName,
        caption: (parsedData.caption || '').replace(/^["“”']|["“”']$/g, '').trim(),
        imageName: imageFile,
        character: charName,
        timestamp: timestamp,
        audioKey: matchingAudioKey || null,
        fileKey: dKey,
        dubOnly: parsedData.dub_only === true
      });
    }

    // Sort dialogues by timestamp
    dialogues.sort((a, b) => a.timestamp - b.timestamp);

    // Calculate exact start, end, and duration for each dialogue line based on zip interval
    for (let i = 0; i < dialogues.length; i++) {
      const cur = dialogues[i];
      const next = dialogues[i + 1];
      if (next) {
        cur.duration = Math.max(1.2, parseFloat((next.timestamp - cur.timestamp).toFixed(3)));
        cur.endTime = next.timestamp;
      } else {
        cur.duration = 5.0;
        cur.endTime = cur.timestamp + 5.0;
      }
    }

    // Calculate total scene estimated duration
    let estimatedDuration = 0;
    if (dialogues.length > 0) {
      const lastDialogue = dialogues[dialogues.length - 1];
      estimatedDuration = Math.ceil(lastDialogue.timestamp + (lastDialogue.duration || 5));
    }
    if (estimatedDuration <= 0) estimatedDuration = 60;

    // 5. Gather character images
    const imageFiles = {};
    for (const key of fileKeys) {
      if (key.match(/\.(png|jpg|jpeg|webp|svg)$/i)) {
        const simpleName = key.substring(key.lastIndexOf('/') + 1);
        imageFiles[simpleName] = key;
      }
    }

    return {
      rawFiles: files,
      prefix,
      meta: {
        title: packInfo.title || 'Escena Sin Título',
        iconName: packInfo.icon || (imageFiles['icon.png'] ? 'icon.png' : (imageFiles['ts.png'] ? 'ts.png' : '')),
        authors: Array.isArray(packInfo.authors) ? packInfo.authors : (packInfo.authors ? [packInfo.authors] : ['Comunidad GameBanana']),
        readme: packInfo.readme || '',
        characters: Array.from(charactersSet).filter(Boolean),
        dialogueCount: dialogues.length,
        estimatedDuration
      },
      videoKey,
      backingTrackKey,
      dialogues,
      imageFiles
    };
  }

  /**
   * Helper to parse INI/Godot-like config format
   * Supports keys like title="foo", authors=["A","B"], dub_timestamps=[06.203], dub_only=true
   */
  static parseIni(text) {
    const result = {};
    const lines = text.split(/\r?\n/);

    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) {
        continue;
      }

      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;

      const key = line.substring(0, eqIdx).trim();
      let value = line.substring(eqIdx + 1).trim();

      // Check if array format: ["a", "b"] or [12.34] or [04,265]
      if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.substring(1, value.length - 1).trim();
        if (inner.length === 0) {
          result[key] = [];
        } else {
          try {
            result[key] = JSON.parse(value);
          } catch {
            const items = inner.split(',').map(item => {
              item = item.trim();
              if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))) {
                return item.substring(1, item.length - 1);
              }
              const num = Number(item.replace(',', '.'));
              return isNaN(num) ? item : num;
            });
            result[key] = items;
          }
        }
      } else {
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          result[key] = value.substring(1, value.length - 1);
        } else if (value === 'true') {
          result[key] = true;
        } else if (value === 'false') {
          result[key] = false;
        } else if (!isNaN(Number(value))) {
          result[key] = Number(value);
        } else {
          result[key] = value;
        }
      }
    }

    return result;
  }

  /**
   * Validate if a parsed package meets scene requirements
   */
  static validateScene(parsedPackage) {
    const checks = {
      hasMeta: false,
      hasVideo: false,
      hasBackingTrack: false,
      hasDialogues: false,
      hasImages: false,
      errors: [],
      warnings: []
    };

    if (parsedPackage.meta && parsedPackage.meta.title) {
      checks.hasMeta = true;
    } else {
      checks.warnings.push("No se encontró `_pack_info.ini` o título de la escena.");
    }

    if (parsedPackage.videoKey) {
      checks.hasVideo = true;
    } else {
      checks.errors.push("Falta el archivo de video principal (`dub_video.ogv`, `.mp4` o `.webm`).");
    }

    if (parsedPackage.backingTrackKey) {
      checks.hasBackingTrack = true;
    } else {
      checks.warnings.push("No se encontró pista de fondo (`_backing_track.mp3`), se reproducirá sin audio de ambiente.");
    }

    if (parsedPackage.dialogues && parsedPackage.dialogues.length > 0) {
      checks.hasDialogues = true;
    } else {
      checks.errors.push("No se encontraron archivos de subtítulos o diálogos (`*.txt`, `*.ini`).");
    }

    if (Object.keys(parsedPackage.imageFiles || {}).length > 0) {
      checks.hasImages = true;
    }

    return {
      isValid: checks.hasVideo && checks.hasDialogues,
      checks
    };
  }

  /**
   * Create a ZIP file from a dictionary of files
   * @param {Record<string, Uint8Array>} files
   * @returns {Promise<Blob>}
   */
  static async createZip(files) {
    const fileEntries = Object.entries(files);
    const localHeaders = [];
    const centralHeaders = [];
    let currentOffset = 0;

    const encoder = new TextEncoder();

    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const [name, data] of fileEntries) {
      const nameBytes = encoder.encode(name);
      const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);

      const crc = this.crc32(dataBytes);
      const size = dataBytes.length;

      // Local Header (30 bytes + nameLen + data)
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lhView = new DataView(localHeader.buffer);
      lhView.setUint32(0, 0x04034b50, true); // Local file header signature
      lhView.setUint16(4, 20, true); // Version needed
      lhView.setUint16(6, 0x0800, true); // General purpose bit flag: names are UTF-8
      lhView.setUint16(8, 0, true); // Compression method (0 = stored)
      lhView.setUint16(10, dosTime, true); // Last mod time
      lhView.setUint16(12, dosDate, true); // Last mod date
      lhView.setUint32(14, crc, true); // CRC-32
      lhView.setUint32(18, size, true); // Compressed size
      lhView.setUint32(22, size, true); // Uncompressed size
      lhView.setUint16(26, nameBytes.length, true); // File name length
      lhView.setUint16(28, 0, true); // Extra field length
      localHeader.set(nameBytes, 30);

      localHeaders.push(localHeader);
      localHeaders.push(dataBytes);

      // Central Directory Header (46 bytes + nameLen)
      const cdHeader = new Uint8Array(46 + nameBytes.length);
      const cdView = new DataView(cdHeader.buffer);
      cdView.setUint32(0, 0x02014b50, true); // Central directory file header signature
      cdView.setUint16(4, 20, true); // Version made by
      cdView.setUint16(6, 20, true); // Version needed
      cdView.setUint16(8, 0x0800, true); // General purpose bit flag: names are UTF-8
      cdView.setUint16(10, 0, true); // Compression method
      cdView.setUint16(12, dosTime, true); // Last mod time
      cdView.setUint16(14, dosDate, true); // Last mod date
      cdView.setUint32(16, crc, true); // CRC-32
      cdView.setUint32(20, size, true); // Compressed size
      cdView.setUint32(24, size, true); // Uncompressed size
      cdView.setUint16(28, nameBytes.length, true); // File name length
      cdView.setUint16(30, 0, true); // Extra field length
      cdView.setUint16(32, 0, true); // File comment length
      cdView.setUint16(34, 0, true); // Disk number start
      cdView.setUint16(36, 0, true); // Internal file attributes
      cdView.setUint32(38, 0, true); // External file attributes
      cdView.setUint32(42, currentOffset, true); // Relative offset of local header
      cdHeader.set(nameBytes, 46);

      centralHeaders.push(cdHeader);
      currentOffset += localHeader.length + dataBytes.length;
    }

    const cdStartOffset = currentOffset;
    const cdSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);

    // End of Central Directory Record (22 bytes)
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
    eocdView.setUint16(4, 0, true); // Number of this disk
    eocdView.setUint16(6, 0, true); // Disk where central directory starts
    eocdView.setUint16(8, fileEntries.length, true); // Total entries on this disk
    eocdView.setUint16(10, fileEntries.length, true); // Total entries in central directory
    eocdView.setUint32(12, cdSize, true); // Size of central directory
    eocdView.setUint32(16, cdStartOffset, true); // Offset of start of central directory
    eocdView.setUint16(20, 0, true); // Comment length

    const allParts = [...localHeaders, ...centralHeaders, eocd];
    return new Blob(allParts, { type: 'application/zip' });
  }

  /**
   * Standard CRC32 table calculation
   */
  static crc32(buffer) {
    // Table-driven: ~8x faster than bit by bit (scenes are tens of MB when shared in a room)
    if (!ZipEngine._crcTable) {
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
      ZipEngine._crcTable = table;
    }
    const table = ZipEngine._crcTable;
    let crc = -1;
    for (let i = 0; i < buffer.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
  }
}
