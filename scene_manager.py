"""
SceneManager - Python ZIP Scene Importer, Validator, and Parser
Handles parsing of _pack_info.ini, dialogue text files with timestamps, character images, and audio tracks.
"""

import os
import io
import json
import shutil
import zipfile
import configparser
from datetime import datetime

SAVED_SCENES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "saved_scenes")

class SceneManager:
    def __init__(self, scenes_dir=SAVED_SCENES_DIR):
        self.scenes_dir = scenes_dir
        os.makedirs(self.scenes_dir, exist_ok=True)

    def get_all_scenes(self):
        """Returns a list of all saved scene packages with metadata."""
        scenes = []
        for item in sorted(os.listdir(self.scenes_dir)):
            item_path = os.path.join(self.scenes_dir, item)
            if os.path.isdir(item_path):
                meta_path = os.path.join(item_path, "scene_meta.json")
                if os.path.exists(meta_path):
                    try:
                        with open(meta_path, "r", encoding="utf-8") as f:
                            meta = json.load(f)
                            meta["folder_path"] = item_path
                            scenes.append(meta)
                    except Exception as e:
                        print(f"Error loading {meta_path}: {e}")
        return scenes

    def get_scene(self, scene_id):
        """Get scene details by scene_id."""
        for s in self.get_all_scenes():
            if s.get("id") == scene_id:
                return s
        return None

    def import_zip_file(self, zip_path):
        """
        Extracts, validates and imports a scene ZIP file into the saved_scenes directory.
        Returns: (success: bool, message: str, scene_data: dict)
        """
        if not os.path.exists(zip_path):
            return False, "El archivo ZIP no existe.", None

        try:
            with zipfile.ZipFile(zip_path, "r") as z:
                names = z.namelist()
                if not names:
                    return False, "El archivo ZIP está vacío.", None

                # Find root prefix
                prefix = ""
                ini_name = None
                for n in names:
                    if n.endswith("_pack_info.ini") or n.endswith("pack_info.ini") or n.endswith("info.ini"):
                        ini_name = n
                        if "/" in n:
                            prefix = n[:n.rfind("/") + 1]
                        break

                # 1. Parse pack info
                pack_info = {
                    "title": os.path.splitext(os.path.basename(zip_path))[0],
                    "icon": "",
                    "authors": ["Desconocido"],
                    "readme": "",
                    "preselected_dub_characters": []
                }

                if ini_name:
                    raw_ini = z.read(ini_name).decode("utf-8", errors="replace")
                    parsed_ini = self._parse_ini_content(raw_ini)
                    pack_info.update(parsed_ini)

                # 2. Locate video and backing track
                video_file = None
                for n in names:
                    if n.lower().endswith((".ogv", ".mp4", ".webm", ".mov")):
                        video_file = n
                        break

                backing_track = None
                for n in names:
                    if "backing_track" in n.lower() or "background" in n.lower() or "music" in n.lower():
                        backing_track = n
                        break

                # 3. Locate dialogues
                dialogue_files = [n for n in names if n.startswith(prefix) and n.endswith(".txt") and "readme" not in n.lower()]
                dialogue_files.sort()

                dialogues = []
                characters_set = set(pack_info.get("preselected_dub_characters", []))

                for df in dialogue_files:
                    raw_txt = z.read(df).decode("utf-8", errors="replace")
                    parsed_d = self._parse_ini_content(raw_txt)
                    base = os.path.splitext(os.path.basename(df))[0]

                    # Match audio file
                    matching_audio = None
                    for ext in [".mp3", ".ogg", ".wav"]:
                        possible_audio = f"{prefix}{base}{ext}"
                        if possible_audio in names:
                            matching_audio = os.path.basename(possible_audio)
                            break

                    char_name = "Personaje"
                    if parsed_d.get("dub_characters") and len(parsed_d["dub_characters"]) > 0:
                        char_name = parsed_d["dub_characters"][0]
                    elif parsed_d.get("character"):
                        char_name = parsed_d["character"]
                    characters_set.add(char_name)

                    timestamp = 0.0
                    if parsed_d.get("dub_timestamps") and len(parsed_d["dub_timestamps"]) > 0:
                        try:
                            timestamp = float(parsed_d["dub_timestamps"][0])
                        except:
                            timestamp = 0.0

                    dialogues.append({
                        "id": base,
                        "caption": parsed_d.get("caption", "").strip('"“’\''),
                        "image": parsed_d.get("image", ""),
                        "character": char_name,
                        "timestamp": timestamp,
                        "audio_file": matching_audio
                    })

                dialogues.sort(key=lambda x: x["timestamp"])

                duration = 0.0
                if dialogues:
                    duration = round(dialogues[-1]["timestamp"] + 5.0, 1)

                # Validation checks
                errors = []
                if not video_file and not dialogue_files:
                    errors.append("No se encontró video ni archivos de diálogo en el paquete.")

                if errors:
                    return False, " | ".join(errors), None

                # Generate clean Scene ID
                clean_title = "".join(c for c in pack_info["title"] if c.isalnum() or c in (" ", "_", "-")).strip()
                scene_id = f"scene_{clean_title.lower().replace(' ', '_')}_{int(datetime.now().timestamp())}"
                dest_dir = os.path.join(self.scenes_dir, scene_id)
                os.makedirs(dest_dir, exist_ok=True)

                # Extract all files into dest_dir
                for item_name in names:
                    if item_name.endswith("/"):
                        continue
                    # Remove prefix for flat / clean access
                    rel_name = item_name[len(prefix):] if item_name.startswith(prefix) else os.path.basename(item_name)
                    target_file = os.path.join(dest_dir, rel_name)
                    os.makedirs(os.path.dirname(target_file), exist_ok=True)
                    with open(target_file, "wb") as f_out:
                        f_out.write(z.read(item_name))

                # Save scene metadata
                scene_meta = {
                    "id": scene_id,
                    "title": pack_info.get("title", "Escena Sin Título"),
                    "icon": pack_info.get("icon", "ts.png"),
                    "authors": pack_info.get("authors", ["Desconocido"]),
                    "readme": pack_info.get("readme", ""),
                    "characters": list(characters_set),
                    "duration": duration,
                    "dialogues": dialogues,
                    "video_file": os.path.basename(video_file) if video_file else None,
                    "backing_track": os.path.basename(backing_track) if backing_track else None,
                    "import_date": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                }

                with open(os.path.join(dest_dir, "scene_meta.json"), "w", encoding="utf-8") as f:
                    json.dump(scene_meta, f, indent=2, ensure_ascii=False)

                scene_meta["folder_path"] = dest_dir
                return True, f"¡Escena '{scene_meta['title']}' importada con éxito!", scene_meta

        except Exception as e:
            return False, f"Error al procesar el archivo ZIP: {str(e)}", None

    def delete_scene(self, scene_id):
        """Deletes a scene folder by scene_id."""
        for s in self.get_all_scenes():
            if s.get("id") == scene_id:
                folder = s.get("folder_path")
                if folder and os.path.exists(folder):
                    shutil.rmtree(folder)
                    return True
        return False

    def export_scene_zip(self, scene_id, output_zip_path):
        """Re-exports a saved scene folder as a ZIP file."""
        scene = self.get_scene(scene_id)
        if not scene or not os.path.exists(scene.get("folder_path", "")):
            return False, "La escena no existe."

        folder = scene["folder_path"]
        try:
            with zipfile.ZipFile(output_zip_path, "w", zipfile.ZIP_DEFLATED) as z:
                for root, dirs, files in os.walk(folder):
                    for file in files:
                        full_p = os.path.join(root, file)
                        rel_p = os.path.relpath(full_p, folder)
                        z.write(full_p, rel_p)
            return True, f"Escena exportada en {output_zip_path}"
        except Exception as e:
            return False, str(e)

    def _parse_ini_content(self, text):
        """Custom helper to parse Godot/INI-like scene formats."""
        result = {}
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith(";") or line.startswith("#") or line.startswith("["):
                continue
            if "=" in line:
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip()

                if val.startswith("[") and val.endswith("]"):
                    inner = val[1:-1].strip()
                    if not inner:
                        result[key] = []
                    else:
                        try:
                            result[key] = json.loads(val)
                        except:
                            items = [x.strip().strip('"\'') for x in inner.split(",") if x.strip()]
                            result[key] = items
                else:
                    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                        result[key] = val[1:-1]
                    else:
                        try:
                            result[key] = float(val) if "." in val else int(val)
                        except:
                            result[key] = val
        return result
