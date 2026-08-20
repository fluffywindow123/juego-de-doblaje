/**
 * AudioEngine - High-performance Web Audio API mixer with HTML5 Audio fallbacks,
 * live microphone recording, volume controls, and real-time DSP effects.
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.micStream = null;
    this.micSource = null;
    this.analyser = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordingStartTime = 0;
    this.isRecording = false;

    // Volume gain nodes
    this.backingGain = null;
    this.voiceGain = null;
    this.originalVoiceGain = null;
    this.masterGain = null;

    // Active playing nodes
    this.activeAudioSources = [];
    this.backingSource = null;

    // Loaded AudioBuffers cache
    this.audioBufferCache = new Map();

    // Volume levels
    this.volumes = {
      backing: 0.8,
      voice: 1.2,
      original: 1.0,
      master: 1.0
    };

    // Effect mode: 'clean' | 'cartoon' | 'villain' | 'robot' | 'megaphone' | 'reverb'
    this.selectedEffect = 'clean';
    this.latencyOffsetMs = 0;
  }

  /**
   * Initialize or resume AudioContext
   */
  async init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (e) {
        console.warn('AudioContext resume failed (requires user gesture):', e);
      }
    }

    if (this.ctx && !this.masterGain) {
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volumes.master;

      this.backingGain = this.ctx.createGain();
      this.backingGain.gain.value = this.volumes.backing;

      this.voiceGain = this.ctx.createGain();
      this.voiceGain.gain.value = this.volumes.voice;

      this.originalVoiceGain = this.ctx.createGain();
      this.originalVoiceGain.gain.value = this.volumes.original;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;

      this.backingGain.connect(this.masterGain);
      this.voiceGain.connect(this.masterGain);
      this.originalVoiceGain.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);
    }
  }

  /**
   * Request Microphone Stream
   */
  async requestMicrophone() {
    await this.init();
    if (!this.micStream) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });

        if (this.ctx) {
          this.micSource = this.ctx.createMediaStreamSource(this.micStream);
          this.micSource.connect(this.analyser);
        }
      } catch (err) {
        console.warn('Microphone access not granted or unavailable:', err);
      }
    }
    return this.micStream;
  }

  toUint8(raw) {
    if (!raw) return null;
    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (typeof raw === 'object' && raw.buffer) {
      return new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength || raw.length);
    }
    if (typeof raw === 'object') {
      return new Uint8Array(Object.values(raw));
    }
    return new Uint8Array(raw);
  }

  /**
   * Decode raw audio Uint8Array / ArrayBuffer into an AudioBuffer
   */
  async decodeAudio(rawAudioData, cacheKey = null) {
    await this.init();
    if (cacheKey && this.audioBufferCache.has(cacheKey)) {
      return this.audioBufferCache.get(cacheKey);
    }

    if (!rawAudioData || !this.ctx) return null;

    const u8 = this.toUint8(rawAudioData);
    if (!u8 || u8.byteLength === 0) return null;

    const arrayBuffer = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

    return new Promise((resolve) => {
      // Decode with both Promise and Callback fallbacks for all browsers
      try {
        this.ctx.decodeAudioData(
          arrayBuffer,
          (decodedBuffer) => {
            if (cacheKey) {
              this.audioBufferCache.set(cacheKey, decodedBuffer);
            }
            resolve(decodedBuffer);
          },
          (err) => {
            console.warn('Web Audio decode failed, attempting HTML5 Audio fallback:', err);
            resolve(null);
          }
        );
      } catch (err) {
        console.warn('Exception during audio decode:', err);
        resolve(null);
      }
    });
  }

  /**
   * Play an AudioBuffer with specified track type ('backing', 'voice', 'original')
   */
  playBuffer(audioBuffer, trackType = 'backing', offset = 0, onEnded = null) {
    if (!audioBuffer) return null;

    // If Web Audio is active
    if (this.ctx && this.ctx.state !== 'closed') {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }

      try {
        const source = this.ctx.createBufferSource();
        source.buffer = audioBuffer;

        let targetGain = this.masterGain;
        if (trackType === 'backing') targetGain = this.backingGain;
        else if (trackType === 'voice') targetGain = this.voiceGain;
        else if (trackType === 'original') targetGain = this.originalVoiceGain;

        if (trackType === 'voice' && this.selectedEffect !== 'clean') {
          const fxChain = this.createEffectChain(this.selectedEffect);
          source.connect(fxChain.input);
          fxChain.output.connect(targetGain);
        } else {
          source.connect(targetGain);
        }

        source.onended = () => {
          const idx = this.activeAudioSources.indexOf(source);
          if (idx !== -1) this.activeAudioSources.splice(idx, 1);
          if (onEnded) onEnded();
        };

        const safeOffset = Math.max(0, Math.min(offset, audioBuffer.duration - 0.05));
        source.start(0, safeOffset);
        this.activeAudioSources.push(source);

        if (trackType === 'backing') {
          this.backingSource = source;
        }

        return source;
      } catch (err) {
        console.warn('Error starting Web Audio buffer source:', err);
      }
    }

    return null;
  }

  /**
   * Play raw audio directly via HTML5 Audio element fallback
   */
  playRawAudioFallback(rawBytes, volume = 1.0) {
    try {
      const u8 = this.toUint8(rawBytes);
      if (!u8 || u8.byteLength === 0) return null;
      const blob = new Blob([u8], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = Math.max(0, Math.min(1.0, volume));
      audio.play().catch(e => console.warn('HTML5 audio play blocked:', e));
      audio.onended = () => URL.revokeObjectURL(url);
      return audio;
    } catch (e) {
      console.warn('HTML5 Audio fallback failed:', e);
      return null;
    }
  }

  /**
   * Start recording user voice
   */
  async startRecording() {
    await this.requestMicrophone();
    if (!this.micStream) {
      console.warn('Cannot record: mic stream is not available');
      return;
    }

    // Ensure audio tracks are live
    const tracks = this.micStream.getAudioTracks();
    if (tracks.length === 0 || tracks[0].readyState === 'ended') {
      this.micStream = null;
      await this.requestMicrophone();
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch {}
    }

    this.recordedChunks = [];
    this.recordingStartTime = performance.now();

    const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg', ''];
    let selectedMime = '';
    for (const mime of mimeTypes) {
      if (mime === '' || (window.MediaRecorder && MediaRecorder.isTypeSupported(mime))) {
        selectedMime = mime;
        break;
      }
    }

    try {
      const options = selectedMime ? { mimeType: selectedMime } : {};
      this.mediaRecorder = new MediaRecorder(this.micStream, options);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.start(40);
      this.isRecording = true;
    } catch (err) {
      console.warn('MediaRecorder start error:', err);
    }
  }

  /**
   * Stop recording and return recorded blob and AudioBuffer
   */
  async stopRecording() {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
      if (this.recordedChunks && this.recordedChunks.length > 0) {
        const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        return { blob, audioBuf: null, duration: (performance.now() - this.recordingStartTime) / 1000 };
      }
      return null;
    }

    return new Promise((resolve) => {
      this.mediaRecorder.onstop = async () => {
        this.isRecording = false;
        const mimeType = this.mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(this.recordedChunks, { type: mimeType });
        const arrayBuf = await blob.arrayBuffer();
        let audioBuf = null;
        try {
          audioBuf = await this.decodeAudio(arrayBuf);
        } catch (e) {
          console.warn('Could not decode recorded audio buffer:', e);
        }
        resolve({ blob, audioBuf, duration: (performance.now() - this.recordingStartTime) / 1000 });
      };
      try {
        this.mediaRecorder.stop();
      } catch (e) {
        resolve(null);
      }
    });
  }

  /**
   * Play user recorded voice take through FX chain or HTML5 Audio
   */
  playUserRecordedTake(audioBuffer, blobUrl = null, effectName = 'clean') {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      try { this.ctx.resume(); } catch {}
    }

    // 1. Web Audio playback through effect chain if buffer is decoded
    if (audioBuffer && this.ctx && this.ctx.state !== 'closed') {
      try {
        const source = this.ctx.createBufferSource();
        source.buffer = audioBuffer;

        const { input, output } = this.createEffectChain(effectName || this.selectedEffect || 'clean');
        source.connect(input);
        output.connect(this.voiceGain || this.masterGain || this.ctx.destination);

        source.start(0);
        this.activeAudioSources.push(source);
        source.onended = () => {
          const idx = this.activeAudioSources.indexOf(source);
          if (idx !== -1) this.activeAudioSources.splice(idx, 1);
        };
        return source;
      } catch (e) {
        console.warn('Web Audio take play failed, falling back to HTML5:', e);
      }
    }

    // 2. HTML5 Audio Element fallback with direct blob URL
    if (blobUrl) {
      try {
        const audio = new Audio(blobUrl);
        audio.volume = Math.max(0.6, Math.min(1.0, this.volumes.voice || 1.0));
        audio.play().catch(e => console.warn('HTML5 user take play error:', e));
        return audio;
      } catch (e) {
        console.warn('HTML5 Audio fallback error:', e);
      }
    }

    return null;
  }

  /**
   * Stop all playing tracks
   */
  stopAll() {
    for (const src of this.activeAudioSources) {
      try {
        src.stop();
      } catch {}
    }
    this.activeAudioSources = [];
    this.backingSource = null;
  }

  /**
   * Set track volumes
   */
  setVolumes({ backing, voice, original, master }) {
    if (backing !== undefined) this.volumes.backing = backing;
    if (voice !== undefined) this.volumes.voice = voice;
    if (original !== undefined) this.volumes.original = original;
    if (master !== undefined) this.volumes.master = master;

    if (this.ctx) {
      const now = this.ctx.currentTime;
      if (this.backingGain && backing !== undefined) this.backingGain.gain.setValueAtTime(backing, now);
      if (this.voiceGain && voice !== undefined) this.voiceGain.gain.setValueAtTime(voice, now);
      if (this.originalVoiceGain && original !== undefined) this.originalVoiceGain.gain.setValueAtTime(original, now);
      if (this.masterGain && master !== undefined) this.masterGain.gain.setValueAtTime(master, now);
    }
  }

  /**
   * Extract normalized waveform amplitude peaks from an AudioBuffer
   */
  extractWaveformPeaks(audioBuffer, numPeaks = 120) {
    if (!audioBuffer) return new Float32Array(numPeaks).fill(0.05);

    const channelData = audioBuffer.getChannelData(0);
    const step = Math.floor(channelData.length / numPeaks);
    const peaks = new Float32Array(numPeaks);

    for (let i = 0; i < numPeaks; i++) {
      const start = i * step;
      const end = Math.min(start + step, channelData.length);
      let max = 0;
      for (let j = start; j < end; j++) {
        const val = Math.abs(channelData[j]);
        if (val > max) max = val;
      }
      peaks[i] = Math.min(1.0, max * 1.5);
    }
    return peaks;
  }

  /**
   * Play a specific buffer time slice with dedicated gain
   */
  playBufferSlice(buffer, offset = 0, duration = null, gainType = 'original') {
    if (!this.ctx || !buffer) return null;
    this.init();

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    let targetGain = this.originalVoiceGain;
    if (gainType === 'voice') targetGain = this.voiceGain;
    if (gainType === 'backing') targetGain = this.backingGain;

    source.connect(targetGain || this.ctx.destination);

    if (duration !== null && duration > 0) {
      source.start(0, Math.max(0, offset), duration);
    } else {
      source.start(0, Math.max(0, offset));
    }

    this.activeAudioSources.push(source);
    source.onended = () => {
      const idx = this.activeAudioSources.indexOf(source);
      if (idx !== -1) this.activeAudioSources.splice(idx, 1);
    };

    return source;
  }

  getWaveformData(dataArray) {
    if (!this.analyser) return;
    this.analyser.getByteTimeDomainData(dataArray);
  }

  createEffectChain(effectName) {
    const input = this.ctx.createGain();
    const output = this.ctx.createGain();

    if (effectName === 'cartoon') {
      const highpass = this.ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 700;

      const peak = this.ctx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = 2600;
      peak.gain.value = 12;

      input.connect(highpass);
      highpass.connect(peak);
      peak.connect(output);
    } else if (effectName === 'villain') {
      const lowpass = this.ctx.createBiquadFilter();
      lowpass.type = 'lowshelf';
      lowpass.frequency.value = 220;
      lowpass.gain.value = 14;

      input.connect(lowpass);
      lowpass.connect(output);
    } else if (effectName === 'robot') {
      const osc = this.ctx.createOscillator();
      const oscGain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = 60;
      osc.connect(oscGain.gain);
      input.connect(oscGain);
      oscGain.connect(output);
      osc.start();
    } else if (effectName === 'megaphone') {
      const bandpass = this.ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 1400;
      bandpass.Q.value = 3.0;

      input.connect(bandpass);
      bandpass.connect(output);
    } else if (effectName === 'reverb') {
      const delay = this.ctx.createDelay();
      delay.delayTime.value = 0.15;

      const feedback = this.ctx.createGain();
      feedback.gain.value = 0.4;

      input.connect(output);
      input.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(output);
    } else {
      input.connect(output);
    }

    return { input, output };
  }
}
