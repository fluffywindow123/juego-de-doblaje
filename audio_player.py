"""
AudioPlayer - Multi-track audio engine, live mic recorder & mixer for Python
Supports synchronized backing tracks, original character line triggers, and custom voice recording.
"""

import os
import time
import threading
import subprocess

try:
    import pygame
    PYGAME_AVAILABLE = True
except ImportError:
    PYGAME_AVAILABLE = False

try:
    import sounddevice as sd
    import soundfile as sf
    import numpy as np
    SOUNDDEVICE_AVAILABLE = True
except ImportError:
    SOUNDDEVICE_AVAILABLE = False

class AudioPlayer:
    def __init__(self):
        self.is_playing = False
        self.is_paused = False
        self.is_recording = False
        self.current_time = 0.0
        self.start_wall_time = 0.0
        self.pause_start_time = 0.0
        self.total_paused_duration = 0.0

        self.scene_folder = None
        self.backing_track_path = None
        self.dialogues = []
        self.active_role = "All" # 'Woody' | 'Buzz' | 'All' | 'Original_Only'

        self.custom_recordings = {} # dialogue_id -> recorded_audio_path
        self.user_recorded_file = None
        self.record_frames = []
        self.record_stream = None

        self.backing_channel = None
        self.dialogue_channels = []
        self.played_dialogue_ids = set()

        self.stop_event = threading.Event()
        self.playback_thread = None

        self.volumes = {
            "backing": 0.75,
            "voice": 1.2,
            "original": 1.0
        }

        self._init_mixer()

    def _init_mixer(self):
        if PYGAME_AVAILABLE:
            try:
                if not pygame.mixer.get_init():
                    pygame.mixer.init(frequency=44100, size=-16, channels=8, buffer=1024)
                pygame.mixer.set_num_channels(16)
            except Exception as e:
                print(f"Mixer init error: {e}")

    def load_scene(self, scene_data):
        """Loads a scene for playback or dubbing."""
        self.stop()
        self.scene_folder = scene_data.get("folder_path")
        self.dialogues = scene_data.get("dialogues", [])

        backing_name = scene_data.get("backing_track")
        if backing_name and self.scene_folder:
            self.backing_track_path = os.path.join(self.scene_folder, backing_name)
        else:
            self.backing_track_path = None

        self.played_dialogue_ids.clear()
        self.current_time = 0.0

    def play_scene(self, mode="original", dubbed_character="None", on_update_callback=None, on_finish_callback=None):
        """
        Starts synchronized playback of the scene.
        mode: "original" (plays backing + all original voices)
              "dubbing" (plays backing + only other characters, allows mic recording)
              "dubbed_preview" (plays backing + other characters + player recorded voice)
        """
        self.stop()
        self.stop_event.clear()
        self.played_dialogue_ids.clear()
        self.is_playing = True
        self.is_paused = False
        self.total_paused_duration = 0.0

        self.playback_thread = threading.Thread(
            target=self._playback_loop,
            args=(mode, dubbed_character, on_update_callback, on_finish_callback),
            daemon=True
        )
        self.playback_thread.start()

    def _playback_loop(self, mode, dubbed_character, on_update, on_finish):
        # 1. Start backing track
        if self.backing_track_path and os.path.exists(self.backing_track_path) and PYGAME_AVAILABLE:
            try:
                pygame.mixer.music.load(self.backing_track_path)
                pygame.mixer.music.set_volume(self.volumes["backing"])
                pygame.mixer.music.play()
            except Exception as e:
                print(f"Error playing music: {e}")

        # Start recording if in dubbing mode
        if mode == "dubbing":
            self.start_mic_recording()

        self.start_wall_time = time.time()
        max_duration = max([d["timestamp"] for d in self.dialogues], default=60.0) + 6.0

        while not self.stop_event.is_set():
            if self.is_paused:
                time.sleep(0.05)
                continue

            elapsed = time.time() - self.start_wall_time - self.total_paused_duration
            self.current_time = elapsed

            if elapsed > max_duration:
                break

            # Check dialogue triggers
            for d in self.dialogues:
                d_id = d["id"]
                t = d["timestamp"]
                char_name = d["character"]

                # If within trigger window (+- 0.15s) and not yet played
                if elapsed >= t and d_id not in self.played_dialogue_ids:
                    self.played_dialogue_ids.add(d_id)
                    is_dubbed_role = (dubbed_character.lower() == char_name.lower()) or (dubbed_character.lower() == "all")

                    if mode == "original":
                        # Always play original line
                        self._play_line_audio(d.get("audio_file"), volume=self.volumes["original"])
                    elif mode == "dubbing":
                        # In dubbing mode, only play OTHER characters
                        if not is_dubbed_role:
                            self._play_line_audio(d.get("audio_file"), volume=self.volumes["original"])
                    elif mode == "dubbed_preview":
                        # In preview mode, play custom user take if exists, else original if not dubbed
                        if is_dubbed_role and d_id in self.custom_recordings:
                            self._play_line_audio(self.custom_recordings[d_id], volume=self.volumes["voice"])
                        elif not is_dubbed_role:
                            self._play_line_audio(d.get("audio_file"), volume=self.volumes["original"])

            if on_update:
                try:
                    on_update(self.current_time)
                except:
                    pass

            time.sleep(0.02)

        if mode == "dubbing":
            self.stop_mic_recording()

        self.is_playing = False
        if PYGAME_AVAILABLE:
            try:
                pygame.mixer.music.stop()
            except:
                pass

        if on_finish and not self.stop_event.is_set():
            try:
                on_finish()
            except:
                pass

    def _play_line_audio(self, filename, volume=1.0):
        if not filename or not self.scene_folder or not PYGAME_AVAILABLE:
            return
        audio_path = os.path.join(self.scene_folder, filename)
        if not os.path.exists(audio_path):
            return

        try:
            sound = pygame.mixer.Sound(audio_path)
            sound.set_volume(volume)
            sound.play()
        except Exception as e:
            # Fallback on macOS afplay
            try:
                threading.Thread(target=lambda: subprocess.run(["afplay", "-v", str(volume), audio_path]), daemon=True).start()
            except:
                pass

    def pause(self):
        if self.is_playing and not self.is_paused:
            self.is_paused = True
            self.pause_start_time = time.time()
            if PYGAME_AVAILABLE:
                try:
                    pygame.mixer.music.pause()
                except:
                    pass

    def resume(self):
        if self.is_playing and self.is_paused:
            self.is_paused = False
            self.total_paused_duration += (time.time() - self.pause_start_time)
            if PYGAME_AVAILABLE:
                try:
                    pygame.mixer.music.unpause()
                except:
                    pass

    def stop(self):
        self.stop_event.set()
        self.is_playing = False
        self.is_paused = False
        if PYGAME_AVAILABLE:
            try:
                pygame.mixer.music.stop()
                pygame.mixer.stop()
            except:
                pass
        if self.is_recording:
            self.stop_mic_recording()

    def set_volume(self, track, val):
        self.volumes[track] = max(0.0, min(2.0, float(val)))
        if track == "backing" and PYGAME_AVAILABLE:
            try:
                pygame.mixer.music.set_volume(self.volumes["backing"])
            except:
                pass

    # Microphone Recording
    def start_mic_recording(self):
        if not SOUNDDEVICE_AVAILABLE:
            print("sounddevice not available, recording disabled.")
            return

        self.record_frames = []
        self.is_recording = True

        def callback(indata, frames, time_info, status):
            if self.is_recording:
                self.record_frames.append(indata.copy())

        try:
            self.record_stream = sd.InputStream(samplerate=44100, channels=1, callback=callback)
            self.record_stream.start()
        except Exception as e:
            print(f"Error starting mic: {e}")

    def stop_mic_recording(self):
        if not self.is_recording:
            return None

        self.is_recording = False
        if self.record_stream:
            try:
                self.record_stream.stop()
                self.record_stream.close()
            except:
                pass
            self.record_stream = None

        if self.record_frames and SOUNDDEVICE_AVAILABLE:
            try:
                audio_data = np.concatenate(self.record_frames, axis=0)
                out_path = os.path.join(os.path.dirname(__file__), "last_dub_take.wav")
                sf.write(out_path, audio_data, 44100)
                self.user_recorded_file = out_path
                return out_path
            except Exception as e:
                print(f"Error saving recording: {e}")
        return None
