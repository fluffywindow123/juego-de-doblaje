/**
 * VideoComposer - Render and export synchronized video with user voice, backing track and subtitles
 */

export class VideoComposer {
  /**
   * Export final composite video
   * @param {Object} params
   * @param {HTMLVideoElement} params.videoElement
   * @param {AudioContext} params.audioCtx
   * @param {AudioBuffer} params.backingBuffer
   * @param {Array<{ timestamp: number, buffer: AudioBuffer, character: string }>} params.voiceTakes
   * @param {Array<{ timestamp: number, buffer: AudioBuffer, character: string }>} params.originalTakes
   * @param {Array<any>} params.dialogues
   * @param {string} params.sceneTitle
   * @param {Function} params.onProgress
   * @returns {Promise<Blob>}
   */
  static async exportVideo({
    videoElement,
    audioCtx,
    backingBuffer,
    voiceTakes = [],
    originalTakes = [],
    dialogues = [],
    sceneTitle = 'Doblaje',
    onProgress = () => {}
  }) {
    // 1. Prepare off-screen canvas
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth || 1280;
    canvas.height = videoElement.videoHeight || 720;
    const ctx = canvas.getContext('2d');

    // 2. Prepare audio routing to MediaStreamDestination
    const dest = audioCtx.createMediaStreamDestination();
    const duration = videoElement.duration || 60;

    // 3. Combine canvas video stream + audio stream
    const canvasStream = canvas.captureStream(30); // 30 FPS
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ]);

    const mimeTypes = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4'
    ];
    let selectedMime = 'video/webm';
    for (const mime of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mime)) {
        selectedMime = mime;
        break;
      }
    }

    const recorder = new MediaRecorder(combinedStream, {
      mimeType: selectedMime,
      videoBitsPerSecond: 2500000 // 2.5 Mbps
    });

    const recordedChunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    return new Promise(async (resolve, reject) => {
      recorder.onstop = () => {
        const finalBlob = new Blob(recordedChunks, { type: selectedMime });
        onProgress(100);
        resolve(finalBlob);
      };

      recorder.onerror = (err) => reject(err);

      // Reset and play video
      videoElement.currentTime = 0;
      videoElement.muted = true; // Audio is routed through Web Audio

      // Audio nodes for export
      const exportSources = [];

      // Backing track
      if (backingBuffer) {
        const backingSrc = audioCtx.createBufferSource();
        backingSrc.buffer = backingBuffer;
        const bGain = audioCtx.createGain();
        bGain.gain.value = 0.75;
        backingSrc.connect(bGain);
        bGain.connect(dest);
        exportSources.push({ source: backingSrc, time: 0 });
      }

      // Original takes (for untouched characters)
      for (const take of originalTakes) {
        if (take.buffer) {
          const origSrc = audioCtx.createBufferSource();
          origSrc.buffer = take.buffer;
          const oGain = audioCtx.createGain();
          oGain.gain.value = 1.0;
          origSrc.connect(oGain);
          oGain.connect(dest);
          exportSources.push({ source: origSrc, time: take.timestamp });
        }
      }

      // User voice takes
      for (const take of voiceTakes) {
        if (take.buffer) {
          const voiceSrc = audioCtx.createBufferSource();
          voiceSrc.buffer = take.buffer;
          const vGain = audioCtx.createGain();
          vGain.gain.value = 1.2;
          voiceSrc.connect(vGain);
          vGain.connect(dest);
          exportSources.push({ source: voiceSrc, time: take.timestamp });
        }
      }

      // Start recording
      recorder.start(100);

      // Start audio sources at designated times
      const startTime = audioCtx.currentTime + 0.1;
      for (const item of exportSources) {
        item.source.start(startTime + item.time);
      }

      // Play video
      await videoElement.play();

      let animationFrameId;
      const renderFrame = () => {
        if (videoElement.paused || videoElement.ended) {
          return;
        }

        // Draw video frame
        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

        // Draw subtle branded watermark / overlay
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.fillRect(20, 20, 260, 42);
        ctx.fillStyle = '#00F0FF';
        ctx.font = 'bold 18px "Space Grotesk", sans-serif';
        ctx.fillText('🎙️ DOBLADO EN VIVO', 35, 47);

        // Subtitle overlay
        const curTime = videoElement.currentTime;
        const activeDiag = dialogues.find((d, idx) => {
          const nextTime = dialogues[idx + 1] ? dialogues[idx + 1].timestamp : curTime + 4;
          return curTime >= d.timestamp - 0.2 && curTime < Math.min(d.timestamp + 4.5, nextTime);
        });

        if (activeDiag) {
          ctx.fillStyle = 'rgba(10, 10, 20, 0.75)';
          ctx.beginPath();
          ctx.roundRect(canvas.width / 2 - 400, canvas.height - 110, 800, 70, 16);
          ctx.fill();

          ctx.fillStyle = '#FFE600';
          ctx.font = 'bold 22px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`[${activeDiag.character}] ${activeDiag.caption}`, canvas.width / 2, canvas.height - 68);
        }

        ctx.restore();

        const progressPercent = Math.min(99, Math.round((videoElement.currentTime / duration) * 100));
        onProgress(progressPercent);

        animationFrameId = requestAnimationFrame(renderFrame);
      };

      renderFrame();

      videoElement.onended = () => {
        cancelAnimationFrame(animationFrameId);
        setTimeout(() => {
          if (recorder.state !== 'inactive') {
            recorder.stop();
          }
        }, 500);
      };
    });
  }

  /**
   * Helper to trigger download of Blob
   */
  static downloadBlob(blob, filename = 'doblaje_final.webm') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 2000);
  }
}
