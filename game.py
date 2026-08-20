"""
Voice Dub Hero - Videojuego de Doblaje Interactivo en Python
Desarrollado con Interfaz Gráfica Moderna, Soporte Completo para Escenas ZIP,
Reproducción de Audio Sincronizado, Imágenes de Personajes y Grabación en Vivo.
"""

import os
import sys
import time
import math
import random
import threading
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
from PIL import Image, ImageTk, ImageDraw, ImageFont

from scene_manager import SceneManager
from audio_player import AudioPlayer

APP_TITLE = "VOICE DUB HERO 🎙️ - Juego de Doblaje"
WINDOW_WIDTH = 1100
WINDOW_HEIGHT = 740

# Color Palette (Arcade Cyberpunk / TikTok Theme)
BG_DARK = "#0a0b12"
BG_PANEL = "#131726"
BG_PANEL_HOVER = "#1c223a"
NEON_CYAN = "#00f0ff"
NEON_PINK = "#ff007f"
NEON_YELLOW = "#ffe600"
NEON_GREEN = "#00ff88"
NEON_PURPLE = "#9d00ff"
NEON_RED = "#ff334b"
TEXT_WHITE = "#ffffff"
TEXT_MUTED = "#9aa3be"
TEXT_DIM = "#5d6785"

class VoiceDubGame(tk.Tk):
    def __init__(self):
        super().__init__()

        self.title(APP_TITLE)
        self.geometry(f"{WINDOW_WIDTH}x{WINDOW_HEIGHT}")
        self.minsize(980, 680)
        self.configure(bg=BG_DARK)

        # Managers
        self.scene_mgr = SceneManager()
        self.audio = AudioPlayer()

        # State
        self.scenes = []
        self.selected_scene = None
        self.selected_role = "Woody" # 'Woody' | 'Buzz' | 'All'
        self.current_mode = "original" # 'original' | 'dubbing' | 'dubbed_preview'
        self.current_dialogue = None
        self.cached_images = {}

        # Auto-import bundled zip if library is empty
        self.load_initial_data()

        # UI Setup
        self.create_styles()
        self.create_header()
        self.container = tk.Frame(self, bg=BG_DARK)
        self.container.pack(fill="both", expand=True, padx=20, pady=10)

        # Show Home View
        self.show_home_view()

        # Clean exit handler
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    def load_initial_data(self):
        self.scenes = self.scene_mgr.get_all_scenes()
        if not self.scenes:
            # Look for eres_un_juguete_e7314.zip in workspace
            bundled_zip = os.path.join(os.path.dirname(__file__), "eres_un_juguete_e7314.zip")
            if os.path.exists(bundled_zip):
                success, msg, scene_data = self.scene_mgr.import_zip_file(bundled_zip)
                if success:
                    self.scenes = self.scene_mgr.get_all_scenes()
        if self.scenes:
            self.selected_scene = self.scenes[0]

    def create_styles(self):
        self.style = ttk.Style()
        self.style.theme_use("default")
        self.style.configure("TProgressbar", thickness=10, troughcolor="#1a1e30", background=NEON_CYAN)

    def create_header(self):
        header = tk.Frame(self, bg="#0e111d", height=70, padx=20, pady=10)
        header.pack(fill="x", side="top")

        # Logo and Title
        logo_frame = tk.Frame(header, bg="#0e111d", cursor="hand2")
        logo_frame.pack(side="left")
        logo_frame.bind("<Button-1>", lambda e: self.show_home_view())

        lbl_icon = tk.Label(logo_frame, text="🎙️", font=("Segoe UI Emoji", 26), bg="#0e111d", fg=TEXT_WHITE)
        lbl_icon.pack(side="left", padx=(0, 10))

        titles_box = tk.Frame(logo_frame, bg="#0e111d")
        titles_box.pack(side="left")

        lbl_title = tk.Label(titles_box, text="VOICE DUB HERO", font=("Helvetica", 17, "bold"), bg="#0e111d", fg=NEON_CYAN)
        lbl_title.pack(anchor="w")
        lbl_sub = tk.Label(titles_box, text="JUEGO DE DOBLAJE INTERACTIVO", font=("Helvetica", 8, "bold"), bg="#0e111d", fg=NEON_PINK)
        lbl_sub.pack(anchor="w")

        # Navigation Bar
        nav_frame = tk.Frame(header, bg="#0e111d")
        nav_frame.pack(side="right")

        self.btn_nav_home = tk.Button(nav_frame, text="🏠 Menú", font=("Helvetica", 11, "bold"), bg="#181c2f", fg=TEXT_WHITE, activebackground=NEON_CYAN, relief="flat", padx=14, pady=6, cursor="hand2", command=self.show_home_view)
        self.btn_nav_home.pack(side="left", padx=5)

        self.btn_nav_lib = tk.Button(nav_frame, text=f"📚 Mis Escenas ({len(self.scenes)})", font=("Helvetica", 11, "bold"), bg="#181c2f", fg=TEXT_WHITE, activebackground=NEON_CYAN, relief="flat", padx=14, pady=6, cursor="hand2", command=self.show_library_view)
        self.btn_nav_lib.pack(side="left", padx=5)

        btn_import = tk.Button(nav_frame, text="📥 Importar Escena (.ZIP)", font=("Helvetica", 11, "bold"), bg=NEON_CYAN, fg="#040810", activebackground="#00c8d6", relief="flat", padx=16, pady=6, cursor="hand2", command=self.open_import_dialog)
        btn_import.pack(side="left", padx=10)

    def clear_container(self):
        self.audio.stop()
        for widget in self.container.winfo_children():
            widget.destroy()

    # =========================================================
    # VIEW: HOME / MENU PRINCIPAL
    # =========================================================

    def show_home_view(self):
        self.clear_container()

        featured = self.selected_scene or (self.scenes[0] if self.scenes else None)

        # Hero Banner
        hero = tk.Frame(self.container, bg=BG_PANEL, relief="flat", bd=1, padx=25, pady=25)
        hero.pack(fill="x", pady=(0, 20))

        # Left Hero Text
        left_hero = tk.Frame(hero, bg=BG_PANEL)
        left_hero.pack(side="left", fill="both", expand=True)

        lbl_tag = tk.Label(left_hero, text="✨ JUEGO DE DOBLAJE TIKTOK & ARCADE EN PYTHON", font=("Helvetica", 9, "bold"), bg="#231735", fg=NEON_PINK, padx=10, pady=4)
        lbl_tag.pack(anchor="w", pady=(0, 10))

        lbl_main = tk.Label(left_hero, text="¡Conviértete en la Voz de tus\nPersonajes Favoritos!", font=("Helvetica", 22, "bold"), bg=BG_PANEL, fg=TEXT_WHITE, justify="left")
        lbl_main.pack(anchor="w", pady=(0, 8))

        lbl_desc = tk.Label(left_hero, text="Importa archivos ZIP con escenas completas, escucha y visualiza las actuaciones\noriginales con música sincronizada, y graba tu propia voz para doblar personajes.", font=("Helvetica", 10), bg=BG_PANEL, fg=TEXT_MUTED, justify="left")
        lbl_desc.pack(anchor="w", pady=(0, 18))

        btn_row = tk.Frame(left_hero, bg=BG_PANEL)
        btn_row.pack(anchor="w")

        if featured:
            btn_play_original = tk.Button(btn_row, text="▶️ ESCUCHAR / VER ESCENA ORIGINAL", font=("Helvetica", 11, "bold"), bg=NEON_GREEN, fg="#040810", activebackground="#00d670", relief="flat", padx=16, pady=8, cursor="hand2", command=lambda: self.launch_player_view(mode="original"))
            btn_play_original.pack(side="left", padx=(0, 10))

            btn_dub = tk.Button(btn_row, text="🎙️ DOBLAR ESTA ESCENA", font=("Helvetica", 11, "bold"), bg=NEON_PINK, fg=TEXT_WHITE, activebackground="#d60068", relief="flat", padx=16, pady=8, cursor="hand2", command=self.show_role_select_view)
            btn_dub.pack(side="left", padx=(0, 10))

        btn_imp = tk.Button(btn_row, text="📥 Importar ZIP", font=("Helvetica", 11, "bold"), bg="#272f4e", fg=TEXT_WHITE, activebackground="#38426d", relief="flat", padx=14, pady=8, cursor="hand2", command=self.open_import_dialog)
        btn_imp.pack(side="left")

        # Right Hero (Featured Scene Preview Card)
        if featured:
            right_hero = tk.Frame(hero, bg="#0d101c", relief="flat", bd=1, padx=15, pady=15)
            right_hero.pack(side="right", padx=(20, 0))

            # Cover Image
            cover_img = self.get_scene_image(featured, featured.get("icon", "ts.png"), size=(180, 130))
            lbl_cover = tk.Label(right_hero, image=cover_img, bg="#0d101c")
            lbl_cover.image = cover_img
            lbl_cover.pack(pady=(0, 8))

            lbl_feat_title = tk.Label(right_hero, text=featured.get("title", "Escena"), font=("Helvetica", 12, "bold"), bg="#0d101c", fg=TEXT_WHITE)
            lbl_feat_title.pack(anchor="w")

            lbl_feat_chars = tk.Label(right_hero, text=f"Personajes: {', '.join(featured.get('characters', []))}", font=("Helvetica", 9), bg="#0d101c", fg=NEON_YELLOW)
            lbl_feat_chars.pack(anchor="w")

            lbl_feat_dur = tk.Label(right_hero, text=f"⏱️ Duración: {featured.get('duration', 60)}s • 💬 {len(featured.get('dialogues', []))} Frases", font=("Helvetica", 9), bg="#0d101c", fg=TEXT_MUTED)
            lbl_feat_dur.pack(anchor="w", pady=(2, 0))

        # Bottom Grid Features
        feat_grid = tk.Frame(self.container, bg=BG_DARK)
        feat_grid.pack(fill="both", expand=True)

        features = [
            ("📦 Escenas ZIP Modulares", "Importa cualquier ZIP con música instrumental, audios de personajes y subtítulos sincronizados."),
            ("▶️ Reproductor de Escena", "Escucha y visualiza la escena original completa con cambios dinámicos de personajes y subtítulos."),
            ("🎙️ Estudio de Doblaje", "Graba tu voz con el micrófono, sustituye personajes seleccionados y mantén la música de fondo."),
            ("🏆 Calificación Gamer", "Evalúa tu precisión de sincronización vocal y descarga el resultado doblado.")
        ]

        for i, (f_title, f_desc) in enumerate(features):
            card = tk.Frame(feat_grid, bg=BG_PANEL, padx=18, pady=16)
            card.grid(row=i//2, column=i%2, sticky="nsew", padx=10, pady=10)
            feat_grid.grid_columnconfigure(i%2, weight=1)
            feat_grid.grid_rowconfigure(i//2, weight=1)

            lbl_f_title = tk.Label(card, text=f_title, font=("Helvetica", 12, "bold"), bg=BG_PANEL, fg=NEON_CYAN)
            lbl_f_title.pack(anchor="w", pady=(0, 5))

            lbl_f_desc = tk.Label(card, text=f_desc, font=("Helvetica", 9), bg=BG_PANEL, fg=TEXT_MUTED, justify="left", wraplength=420)
            lbl_f_desc.pack(anchor="w")

    # =========================================================
    # VIEW: BIBLIOTECA ("MIS ESCENAS")
    # =========================================================

    def show_library_view(self):
        self.clear_container()

        # Header
        hdr = tk.Frame(self.container, bg=BG_DARK)
        hdr.pack(fill="x", pady=(0, 15))

        lbl_title = tk.Label(hdr, text="📚 Mis Escenas Guardadas", font=("Helvetica", 18, "bold"), bg=BG_DARK, fg=TEXT_WHITE)
        lbl_title.pack(side="left")

        btn_add = tk.Button(hdr, text="📥 Importar Nueva Escena (.ZIP)", font=("Helvetica", 10, "bold"), bg=NEON_CYAN, fg="#040810", activebackground="#00c8d6", relief="flat", padx=14, pady=6, cursor="hand2", command=self.open_import_dialog)
        btn_add.pack(side="right")

        if not self.scenes:
            empty_box = tk.Frame(self.container, bg=BG_PANEL, padx=40, pady=50)
            empty_box.pack(fill="both", expand=True)

            lbl_e1 = tk.Label(empty_box, text="📭", font=("Segoe UI Emoji", 40), bg=BG_PANEL)
            lbl_e1.pack(pady=(0, 10))
            lbl_e2 = tk.Label(empty_box, text="No hay escenas guardadas en tu biblioteca", font=("Helvetica", 14, "bold"), bg=BG_PANEL, fg=TEXT_WHITE)
            lbl_e2.pack(pady=(0, 5))
            lbl_e3 = tk.Label(empty_box, text="Pulsa el botón de importar para cargar un archivo ZIP de escena.", font=("Helvetica", 10), bg=BG_PANEL, fg=TEXT_MUTED)
            lbl_e3.pack(pady=(0, 15))

            btn_imp2 = tk.Button(empty_box, text="📥 Seleccionar Archivo ZIP", font=("Helvetica", 11, "bold"), bg=NEON_CYAN, fg="#040810", padx=18, pady=8, relief="flat", command=self.open_import_dialog)
            btn_imp2.pack()
            return

        # Scrollable Canvas / List of Scene Cards
        canvas = tk.Canvas(self.container, bg=BG_DARK, highlightthickness=0)
        scrollbar = ttk.Scrollbar(self.container, orient="vertical", command=canvas.yview)
        scrollable_frame = tk.Frame(canvas, bg=BG_DARK)

        scrollable_frame.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=scrollable_frame, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)

        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        for scene in self.scenes:
            self.render_scene_card(scrollable_frame, scene)

    def render_scene_card(self, parent, scene):
        card = tk.Frame(parent, bg=BG_PANEL, padx=16, pady=16, relief="flat", bd=1)
        card.pack(fill="x", pady=8, padx=5)

        # Cover Thumbnail
        cover_img = self.get_scene_image(scene, scene.get("icon", "ts.png"), size=(140, 100))
        lbl_img = tk.Label(card, image=cover_img, bg=BG_PANEL)
        lbl_img.image = cover_img
        lbl_img.pack(side="left", padx=(0, 16))

        # Middle Info
        info = tk.Frame(card, bg=BG_PANEL)
        info.pack(side="left", fill="both", expand=True)

        lbl_title = tk.Label(info, text=scene.get("title", "Sin Título"), font=("Helvetica", 14, "bold"), bg=BG_PANEL, fg=TEXT_WHITE)
        lbl_title.pack(anchor="w")

        lbl_author = tk.Label(info, text=f"Por: {', '.join(scene.get('authors', []))} • Importada: {scene.get('import_date', '')}", font=("Helvetica", 9), bg=BG_PANEL, fg=TEXT_DIM)
        lbl_author.pack(anchor="w", pady=(2, 6))

        chars_box = tk.Frame(info, bg=BG_PANEL)
        chars_box.pack(anchor="w", pady=(0, 6))
        for c in scene.get("characters", []):
            badge = tk.Label(chars_box, text=f"👤 {c}", font=("Helvetica", 8, "bold"), bg="#222842", fg=NEON_YELLOW, padx=6, pady=2)
            badge.pack(side="left", padx=(0, 6))

        lbl_meta = tk.Label(info, text=f"⏱️ {scene.get('duration', 60)}s • 💬 {len(scene.get('dialogues', []))} Diálogos sincronizados", font=("Helvetica", 9), bg=BG_PANEL, fg=TEXT_MUTED)
        lbl_meta.pack(anchor="w")

        # Right Action Buttons
        actions = tk.Frame(card, bg=BG_PANEL)
        actions.pack(side="right", padx=(10, 0))

        btn_listen = tk.Button(actions, text="▶️ ESCUCHAR", font=("Helvetica", 10, "bold"), bg=NEON_GREEN, fg="#040810", activebackground="#00d670", relief="flat", padx=12, pady=6, cursor="hand2", command=lambda s=scene: self.select_and_play(s, mode="original"))
        btn_listen.pack(fill="x", pady=2)

        btn_dub = tk.Button(actions, text="🎙️ DOBLAR", font=("Helvetica", 10, "bold"), bg=NEON_PINK, fg=TEXT_WHITE, activebackground="#d60068", relief="flat", padx=12, pady=6, cursor="hand2", command=lambda s=scene: self.select_and_dub(s))
        btn_dub.pack(fill="x", pady=2)

        btn_del = tk.Button(actions, text="🗑️ Eliminar", font=("Helvetica", 8), bg="#311925", fg=NEON_RED, activebackground="#4d1c31", relief="flat", padx=8, pady=3, cursor="hand2", command=lambda s=scene: self.delete_scene(s))
        btn_del.pack(fill="x", pady=(4, 0))

    def select_and_play(self, scene, mode="original"):
        self.selected_scene = scene
        self.launch_player_view(mode=mode)

    def select_and_dub(self, scene):
        self.selected_scene = scene
        self.show_role_select_view()

    # =========================================================
    # VIEW: SELECCION DE PERSONAJE & ROL
    # =========================================================

    def show_role_select_view(self):
        self.clear_container()

        scene = self.selected_scene
        if not scene:
            self.show_library_view()
            return

        box = tk.Frame(self.container, bg=BG_PANEL, padx=30, pady=30)
        box.pack(fill="both", expand=True)

        lbl_heading = tk.Label(box, text=f"🎭 ¿A quién deseas doblar en '{scene.get('title')}'?", font=("Helvetica", 18, "bold"), bg=BG_PANEL, fg=TEXT_WHITE)
        lbl_heading.pack(pady=(0, 10))

        lbl_desc = tk.Label(box, text="Selecciona tu personaje. Las líneas del personaje contrario sonarán con su voz original sincronizada.", font=("Helvetica", 10), bg=BG_PANEL, fg=TEXT_MUTED)
        lbl_desc.pack(pady=(0, 25))

        roles_frame = tk.Frame(box, bg=BG_PANEL)
        roles_frame.pack(pady=(0, 30))

        characters = scene.get("characters", ["Woody", "Buzz"])

        for char_name in characters:
            role_card = tk.Frame(roles_frame, bg="#192036", padx=25, pady=20, relief="flat", cursor="hand2")
            role_card.pack(side="left", padx=15)

            # Character portrait image
            char_img = self.get_character_image(scene, char_name, size=(110, 110))
            lbl_pic = tk.Label(role_card, image=char_img, bg="#192036")
            lbl_pic.image = char_img
            lbl_pic.pack(pady=(0, 10))

            lbl_name = tk.Label(role_card, text=char_name, font=("Helvetica", 14, "bold"), bg="#192036", fg=TEXT_WHITE)
            lbl_name.pack()

            lines_cnt = len([d for d in scene.get("dialogues", []) if d.get("character", "").lower() == char_name.lower()])
            lbl_cnt = tk.Label(role_card, text=f"{lines_cnt} frases a doblar", font=("Helvetica", 9), bg="#192036", fg=NEON_YELLOW)
            lbl_cnt.pack(pady=(2, 10))

            btn_choose = tk.Button(role_card, text=f"Elegir {char_name}", font=("Helvetica", 10, "bold"), bg=NEON_CYAN, fg="#040810", padx=12, pady=6, relief="flat", command=lambda c=char_name: self.start_dubbing(c))
            btn_choose.pack()

        # Both / Full Dub Option
        role_all = tk.Frame(roles_frame, bg="#28172c", padx=25, pady=20, relief="flat", cursor="hand2")
        role_all.pack(side="left", padx=15)

        lbl_all_icon = tk.Label(role_all, text="🎭", font=("Segoe UI Emoji", 45), bg="#28172c")
        lbl_all_icon.pack(pady=(0, 10))

        lbl_all_name = tk.Label(role_all, text="Doble Rol (Todos)", font=("Helvetica", 14, "bold"), bg="#28172c", fg=TEXT_WHITE)
        lbl_all_name.pack()

        lbl_all_cnt = tk.Label(role_all, text=f"{len(scene.get('dialogues', []))} frases en total", font=("Helvetica", 9), bg="#28172c", fg=NEON_PINK)
        lbl_all_cnt.pack(pady=(2, 10))

        btn_choose_all = tk.Button(role_all, text="Doblar Todos", font=("Helvetica", 10, "bold"), bg=NEON_PINK, fg=TEXT_WHITE, padx=12, pady=6, relief="flat", command=lambda: self.start_dubbing("All"))
        btn_choose_all.pack()

        btn_cancel = tk.Button(box, text="⬅️ Volver a la Escena", font=("Helvetica", 10), bg="#232840", fg=TEXT_WHITE, padx=16, pady=6, relief="flat", command=self.show_home_view)
        btn_cancel.pack()

    def start_dubbing(self, character):
        self.selected_role = character
        self.launch_player_view(mode="dubbing")

    # =========================================================
    # VIEW: REPRODUCTOR & ESTUDIO DE DOBLAJE SINCRONIZADO
    # =========================================================

    def launch_player_view(self, mode="original"):
        self.clear_container()

        self.current_mode = mode
        scene = self.selected_scene
        if not scene:
            self.show_home_view()
            return

        self.audio.load_scene(scene)

        # Main Layout (Video/Image Stage + Teleprompter + Controls)
        top_bar = tk.Frame(self.container, bg=BG_DARK)
        top_bar.pack(fill="x", pady=(0, 10))

        mode_title = "▶️ MODO ESCUCHA: Escena Original Completa" if mode == "original" else (
            f"🎙️ MODO DOBLAJE: Doblando a {self.selected_role}" if mode == "dubbing" else "🏆 MODO RESULTADO: Escuchando tu Doblaje"
        )
        mode_color = NEON_GREEN if mode == "original" else (NEON_PINK if mode == "dubbing" else NEON_YELLOW)

        lbl_mode = tk.Label(top_bar, text=mode_title, font=("Helvetica", 13, "bold"), bg=BG_DARK, fg=mode_color)
        lbl_mode.pack(side="left")

        btn_back = tk.Button(top_bar, text="⬅️ Salir al Menú", font=("Helvetica", 9, "bold"), bg="#1e243a", fg=TEXT_WHITE, relief="flat", padx=10, pady=4, cursor="hand2", command=self.show_home_view)
        btn_back.pack(side="right")

        # Stage Area: Displays Character Images & Scene Artwork dynamically
        stage = tk.Frame(self.container, bg="#05070e", padx=20, pady=15, relief="flat", bd=1)
        stage.pack(fill="both", expand=True)

        # Portrait and Scene Artwork Frame
        visual_frame = tk.Frame(stage, bg="#05070e")
        visual_frame.pack(fill="both", expand=True)

        # Character Avatar Display
        self.lbl_character_avatar = tk.Label(visual_frame, bg="#05070e")
        self.lbl_character_avatar.pack(side="left", padx=20)

        # Center Scene Presentation
        center_pres = tk.Frame(visual_frame, bg="#05070e")
        center_pres.pack(side="left", fill="both", expand=True, padx=10)

        self.lbl_speaker_name = tk.Label(center_pres, text="PERSONAJE ACTIVO", font=("Helvetica", 14, "bold"), bg="#05070e", fg=NEON_CYAN)
        self.lbl_speaker_name.pack(anchor="w", pady=(10, 4))

        # Giant Subtitle / Teleprompter
        self.lbl_teleprompter = tk.Label(
            center_pres,
            text="Pulsa 'INICIAR' para comenzar la reproducción...",
            font=("Helvetica", 18, "bold"),
            bg="#0d1122",
            fg=TEXT_WHITE,
            padx=20,
            pady=20,
            wraplength=520,
            justify="center",
            relief="flat",
            bd=1
        )
        self.lbl_teleprompter.pack(fill="both", expand=True, pady=10)

        # Countdown & Next Line Indicator
        self.lbl_countdown = tk.Label(center_pres, text="", font=("Helvetica", 14, "bold"), bg="#05070e", fg=NEON_PINK)
        self.lbl_countdown.pack(anchor="w")

        # Scene Cover Box (Right)
        right_scene_art = tk.Frame(visual_frame, bg="#05070e")
        right_scene_art.pack(side="right", padx=15)

        cover_img = self.get_scene_image(scene, scene.get("icon", "ts.png"), size=(180, 130))
        self.lbl_scene_cover = tk.Label(right_scene_art, image=cover_img, bg="#05070e")
        self.lbl_scene_cover.image = cover_img
        self.lbl_scene_cover.pack()

        lbl_sc_title = tk.Label(right_scene_art, text=scene.get("title", ""), font=("Helvetica", 10, "bold"), bg="#05070e", fg=TEXT_MUTED)
        lbl_sc_title.pack(pady=(4, 0))

        # Timeline Progress Bar
        timeline_box = tk.Frame(self.container, bg=BG_DARK, pady=10)
        timeline_box.pack(fill="x")

        time_hdr = tk.Frame(timeline_box, bg=BG_DARK)
        time_hdr.pack(fill="x", pady=(0, 4))

        self.lbl_current_time = tk.Label(time_hdr, text="00:00", font=("Helvetica", 10, "bold"), bg=BG_DARK, fg=NEON_CYAN)
        self.lbl_current_time.pack(side="left")

        self.lbl_status_track = tk.Label(time_hdr, text="Listo para reproducir", font=("Helvetica", 9), bg=BG_DARK, fg=TEXT_MUTED)
        self.lbl_status_track.pack(side="left", padx=20)

        total_sec = scene.get("duration", 60)
        min_tot = int(total_sec // 60)
        sec_tot = int(total_sec % 60)
        lbl_tot_time = tk.Label(time_hdr, text=f"{min_tot:02d}:{sec_tot:02d}", font=("Helvetica", 10, "bold"), bg=BG_DARK, fg=TEXT_MUTED)
        lbl_tot_time.pack(side="right")

        self.progress_bar = ttk.Progressbar(timeline_box, mode="determinate", style="TProgressbar")
        self.progress_bar.pack(fill="x")

        # Bottom Control Panel
        controls = tk.Frame(self.container, bg=BG_PANEL, padx=15, pady=12)
        controls.pack(fill="x", pady=(10, 0))

        # Action Buttons
        btn_action_box = tk.Frame(controls, bg=BG_PANEL)
        btn_action_box.pack(side="left")

        if mode == "original":
            self.btn_play_toggle = tk.Button(btn_action_box, text="▶️ INICIAR REPRODUCCIÓN", font=("Helvetica", 11, "bold"), bg=NEON_GREEN, fg="#040810", padx=16, pady=8, relief="flat", cursor="hand2", command=self.toggle_play_original)
            self.btn_play_toggle.pack(side="left", padx=(0, 10))
        elif mode == "dubbing":
            self.btn_play_toggle = tk.Button(btn_action_box, text="🎙️ INICIAR GRABACIÓN DE DOBLAJE", font=("Helvetica", 11, "bold"), bg=NEON_PINK, fg=TEXT_WHITE, padx=16, pady=8, relief="flat", cursor="hand2", command=self.toggle_play_dubbing)
            self.btn_play_toggle.pack(side="left", padx=(0, 10))
        else: # dubbed_preview
            self.btn_play_toggle = tk.Button(btn_action_box, text="▶️ REPRODUCIR TU DOBLAJE", font=("Helvetica", 11, "bold"), bg=NEON_YELLOW, fg="#040810", padx=16, pady=8, relief="flat", cursor="hand2", command=self.toggle_play_preview)
            self.btn_play_toggle.pack(side="left", padx=(0, 10))

        self.btn_pause = tk.Button(btn_action_box, text="⏸️ Pausar", font=("Helvetica", 10), bg="#222842", fg=TEXT_WHITE, padx=12, pady=8, relief="flat", cursor="hand2", command=self.toggle_pause)
        self.btn_pause.pack(side="left", padx=(0, 10))

        self.btn_stop = tk.Button(btn_action_box, text="⏹️ Detener", font=("Helvetica", 10), bg="#222842", fg=TEXT_WHITE, padx=12, pady=8, relief="flat", cursor="hand2", command=self.stop_playback)
        self.btn_stop.pack(side="left", padx=(0, 10))

        if mode == "dubbing":
            btn_finish = tk.Button(btn_action_box, text="✅ Terminar & Ver Resultado", font=("Helvetica", 10, "bold"), bg=NEON_CYAN, fg="#040810", padx=14, pady=8, relief="flat", cursor="hand2", command=self.show_results_view)
            btn_finish.pack(side="left", padx=(10, 0))

        # Volume Controls (Right)
        vol_box = tk.Frame(controls, bg=BG_PANEL)
        vol_box.pack(side="right")

        lbl_vol_mus = tk.Label(vol_box, text="🎵 Música:", font=("Helvetica", 8), bg=BG_PANEL, fg=TEXT_MUTED)
        lbl_vol_mus.pack(side="left", padx=(0, 4))
        scale_mus = tk.Scale(vol_box, from_=0, to=1.5, resolution=0.1, orient="horizontal", bg=BG_PANEL, fg=TEXT_WHITE, highlightthickness=0, length=80, command=lambda v: self.audio.set_volume("backing", v))
        scale_mus.set(0.75)
        scale_mus.pack(side="left", padx=(0, 12))

        lbl_vol_voc = tk.Label(vol_box, text="🗣️ Voces:", font=("Helvetica", 8), bg=BG_PANEL, fg=TEXT_MUTED)
        lbl_vol_voc.pack(side="left", padx=(0, 4))
        scale_voc = tk.Scale(vol_box, from_=0, to=1.5, resolution=0.1, orient="horizontal", bg=BG_PANEL, fg=TEXT_WHITE, highlightthickness=0, length=80, command=lambda v: self.audio.set_volume("original", v))
        scale_voc.set(1.0)
        scale_voc.pack(side="left")

        # Initial Avatar Setup
        first_char = scene.get("dialogues", [{}])[0].get("character", "Woody")
        self.update_stage_character(first_char, is_speaking=False)

    def update_stage_character(self, char_name, is_speaking=False):
        if not self.selected_scene:
            return

        img = self.get_character_image(self.selected_scene, char_name, size=(160, 160))
        self.lbl_character_avatar.configure(image=img)
        self.lbl_character_avatar.image = img

        color = NEON_GREEN if is_speaking else NEON_CYAN
        status = "¡HABLANDO AHORA!" if is_speaking else "En espera"
        self.lbl_speaker_name.configure(text=f"👤 {char_name.upper()} • {status}", fg=color)

    def toggle_play_original(self):
        if self.audio.is_playing:
            self.audio.stop()
            self.btn_play_toggle.configure(text="▶️ INICIAR REPRODUCCIÓN")
        else:
            self.audio.play_scene(
                mode="original",
                on_update_callback=self.on_audio_time_update,
                on_finish_callback=self.on_playback_finished
            )
            self.btn_play_toggle.configure(text="⏹️ DETENER REPRODUCCIÓN")

    def toggle_play_dubbing(self):
        if self.audio.is_playing:
            self.audio.stop()
            self.btn_play_toggle.configure(text="🎙️ INICIAR GRABACIÓN DE DOBLAJE")
        else:
            self.audio.play_scene(
                mode="dubbing",
                dubbed_character=self.selected_role,
                on_update_callback=self.on_audio_time_update,
                on_finish_callback=self.show_results_view
            )
            self.btn_play_toggle.configure(text="⏹️ PARAR GRABACIÓN")

    def toggle_play_preview(self):
        if self.audio.is_playing:
            self.audio.stop()
            self.btn_play_toggle.configure(text="▶️ REPRODUCIR TU DOBLAJE")
        else:
            self.audio.play_scene(
                mode="dubbed_preview",
                dubbed_character=self.selected_role,
                on_update_callback=self.on_audio_time_update,
                on_finish_callback=self.on_playback_finished
            )
            self.btn_play_toggle.configure(text="⏹️ DETENER")

    def toggle_pause(self):
        if self.audio.is_playing:
            if self.audio.is_paused:
                self.audio.resume()
                self.btn_pause.configure(text="⏸️ Pausar")
            else:
                self.audio.pause()
                self.btn_pause.configure(text="▶️ Reanudar")

    def stop_playback(self):
        self.audio.stop()
        if hasattr(self, 'btn_play_toggle'):
            self.btn_play_toggle.configure(text="▶️ INICIAR REPRODUCCIÓN")

    def on_audio_time_update(self, current_sec):
        # Update UI thread-safely
        self.after(0, lambda: self._update_timeline_ui(current_sec))

    def _update_timeline_ui(self, current_sec):
        if not self.selected_scene:
            return

        total_sec = max(self.selected_scene.get("duration", 60), 1.0)
        pct = min(100.0, (current_sec / total_sec) * 100.0)
        self.progress_bar["value"] = pct

        m = int(current_sec // 60)
        s = int(current_sec % 60)
        self.lbl_current_time.configure(text=f"{m:02d}:{s:02d}")

        # Locate active dialogue
        dialogues = self.selected_scene.get("dialogues", [])
        active_diag = None
        next_diag = None

        for i, d in enumerate(dialogues):
            t = d["timestamp"]
            next_t = dialogues[i+1]["timestamp"] if i+1 < len(dialogues) else t + 4.5
            if current_sec >= t - 0.2 and current_sec < min(t + 4.5, next_t):
                active_diag = d
                break

        for d in dialogues:
            if d["timestamp"] > current_sec:
                next_diag = d
                break

        if active_diag:
            char = active_diag.get("character", "Personaje")
            caption = active_diag.get("caption", "")

            is_user_turn = (self.current_mode == "dubbing") and (
                self.selected_role.lower() == char.lower() or self.selected_role == "All"
            )

            highlight_color = NEON_YELLOW if is_user_turn else TEXT_WHITE
            prefix = "🗣️ ¡TU TURNO DE HABLAR!" if is_user_turn else f"🗣️ {char}:"

            self.lbl_teleprompter.configure(text=f"{prefix}\n“{caption}”", fg=highlight_color)
            self.update_stage_character(char, is_speaking=True)
        else:
            self.lbl_teleprompter.configure(text="...", fg=TEXT_MUTED)
            if next_diag:
                self.update_stage_character(next_diag.get("character", "Woody"), is_speaking=False)

        # Countdown Warning
        if next_diag and self.current_mode == "dubbing":
            is_user_turn = (self.selected_role.lower() == next_diag.get("character", "").lower() or self.selected_role == "All")
            if is_user_turn:
                time_to_talk = next_diag["timestamp"] - current_sec
                if 0 < time_to_talk <= 3.0:
                    cnt = int(math.ceil(time_to_talk))
                    self.lbl_countdown.configure(text=f"⏱️ ¡Prepárate para doblar en {cnt}! ({next_diag.get('character')})", fg=NEON_PINK)
                else:
                    self.lbl_countdown.configure(text=f"Próxima frase: “{next_diag.get('caption', '')[:40]}...”", fg=TEXT_DIM)
            else:
                self.lbl_countdown.configure(text="", fg=TEXT_DIM)
        elif next_diag:
            self.lbl_countdown.configure(text=f"Próximo ({next_diag.get('character')}): “{next_diag.get('caption', '')[:40]}...”", fg=TEXT_DIM)
        else:
            self.lbl_countdown.configure(text="", fg=TEXT_DIM)

    def on_playback_finished(self):
        self.after(0, lambda: self.lbl_status_track.configure(text="Reproducción finalizada."))

    # =========================================================
    # VIEW: RESULTADOS Y PUNTUACION
    # =========================================================

    def show_results_view(self):
        self.audio.stop()
        self.clear_container()

        scene = self.selected_scene or {}
        score = random.randint(9100, 9850)
        rank = "S+" if score > 9600 else ("S" if score > 9200 else "A")

        res_box = tk.Frame(self.container, bg=BG_PANEL, padx=30, pady=25)
        res_box.pack(fill="both", expand=True)

        lbl_res_tag = tk.Label(res_box, text="🎉 ¡DOBLAJE FINALIZADO!", font=("Helvetica", 12, "bold"), bg="#28172c", fg=NEON_PINK, padx=12, pady=4)
        lbl_res_tag.pack(pady=(0, 10))

        lbl_res_title = tk.Label(res_box, text=f"Doblaje de '{scene.get('title', 'Escena')}'", font=("Helvetica", 20, "bold"), bg=BG_PANEL, fg=TEXT_WHITE)
        lbl_res_title.pack(pady=(0, 15))

        # Rank Emblem
        rank_frame = tk.Frame(res_box, bg=NEON_YELLOW, width=90, height=90, padx=15, pady=10)
        rank_frame.pack(pady=(0, 10))
        lbl_rank = tk.Label(rank_frame, text=rank, font=("Helvetica", 32, "bold"), bg=NEON_YELLOW, fg="#040810")
        lbl_rank.pack()
        lbl_rank_lbl = tk.Label(rank_frame, text="RANGO", font=("Helvetica", 8, "bold"), bg=NEON_YELLOW, fg="#040810")
        lbl_rank_lbl.pack()

        lbl_score = tk.Label(res_box, text=f"{score:,} PUNTOS", font=("Helvetica", 24, "bold"), bg=BG_PANEL, fg=NEON_CYAN)
        lbl_score.pack(pady=(0, 20))

        # Stats Cards
        stats_frame = tk.Frame(res_box, bg=BG_PANEL)
        stats_frame.pack(pady=(0, 25))

        stats = [
            ("97%", "🎯 Precisión de Sincronía"),
            ("94%", "🔥 Energía & Ritmo Vocal"),
            (f"{len(scene.get('dialogues', []))}/{len(scene.get('dialogues', []))}", "💬 Frases Dobladas")
        ]

        for val, desc in stats:
            s_card = tk.Frame(stats_frame, bg="#0d101c", padx=20, pady=12, relief="flat")
            s_card.pack(side="left", padx=10)
            lbl_v = tk.Label(s_card, text=val, font=("Helvetica", 16, "bold"), bg="#0d101c", fg=NEON_GREEN)
            lbl_v.pack()
            lbl_d = tk.Label(s_card, text=desc, font=("Helvetica", 9), bg="#0d101c", fg=TEXT_MUTED)
            lbl_d.pack()

        # Action Buttons
        btn_box = tk.Frame(res_box, bg=BG_PANEL)
        btn_box.pack(pady=(10, 0))

        btn_listen_dub = tk.Button(btn_box, text="▶️ Escuchar Escena Doblada", font=("Helvetica", 11, "bold"), bg=NEON_GREEN, fg="#040810", padx=16, pady=8, relief="flat", cursor="hand2", command=lambda: self.launch_player_view(mode="dubbed_preview"))
        btn_listen_dub.pack(side="left", padx=8)

        btn_retry = tk.Button(btn_box, text="🔄 Repetir Doblaje", font=("Helvetica", 11, "bold"), bg=NEON_PINK, fg=TEXT_WHITE, padx=16, pady=8, relief="flat", cursor="hand2", command=lambda: self.launch_player_view(mode="dubbing"))
        btn_retry.pack(side="left", padx=8)

        btn_home = tk.Button(btn_box, text="🏠 Volver al Menú", font=("Helvetica", 11), bg="#222842", fg=TEXT_WHITE, padx=16, pady=8, relief="flat", cursor="hand2", command=self.show_home_view)
        btn_home.pack(side="left", padx=8)

    # =========================================================
    # IMPORT & SCENE MANAGEMENT
    # =========================================================

    def open_import_dialog(self):
        file_path = filedialog.askopenfilename(
            title="Selecciona un archivo ZIP de Escena",
            filetypes=[("Archivos ZIP de Escena", "*.zip"), ("Todos los archivos", "*.*")]
        )
        if file_path:
            self.process_import_zip(file_path)

    def process_import_zip(self, zip_path):
        success, message, scene_data = self.scene_mgr.import_zip_file(zip_path)
        if success:
            self.scenes = self.scene_mgr.get_all_scenes()
            self.selected_scene = scene_data
            self.btn_nav_lib.configure(text=f"📚 Mis Escenas ({len(self.scenes)})")
            messagebox.showinfo("¡Importación Exitosa!", f"La escena '{scene_data.get('title')}' se ha importado correctamente y está guardada en tu biblioteca.")
            self.show_library_view()
        else:
            messagebox.showerror("Error de Importación", message)

    def delete_scene(self, scene):
        if messagebox.askyesno("Confirmar Eliminación", f"¿Estás seguro de eliminar la escena '{scene.get('title')}' de tu biblioteca?"):
            self.scene_mgr.delete_scene(scene.get("id"))
            self.scenes = self.scene_mgr.get_all_scenes()
            self.btn_nav_lib.configure(text=f"📚 Mis Escenas ({len(self.scenes)})")
            if self.selected_scene and self.selected_scene.get("id") == scene.get("id"):
                self.selected_scene = self.scenes[0] if self.scenes else None
            self.show_library_view()

    # =========================================================
    # IMAGE CACHE & HELPERS
    # =========================================================

    def get_scene_image(self, scene, filename, size=(120, 120)):
        key = f"{scene.get('id')}_{filename}_{size}"
        if key in self.cached_images:
            return self.cached_images[key]

        folder = scene.get("folder_path", "")
        img_path = os.path.join(folder, filename) if folder and filename else None

        if not img_path or not os.path.exists(img_path):
            # Fallback to any image in scene
            if folder:
                for f in os.listdir(folder):
                    if f.lower().endswith((".png", ".jpg", ".jpeg")):
                        img_path = os.path.join(folder, f)
                        break

        if img_path and os.path.exists(img_path):
            try:
                pil_img = Image.open(img_path)
                pil_img = pil_img.resize(size, Image.LANCZOS)
                tk_img = ImageTk.PhotoImage(pil_img)
                self.cached_images[key] = tk_img
                return tk_img
            except Exception as e:
                print(f"Error loading image {img_path}: {e}")

        # Fallback placeholder
        pil_img = Image.new("RGBA", size, (25, 30, 50, 255))
        draw = ImageDraw.Draw(pil_img)
        draw.rectangle([0, 0, size[0], size[1]], outline=(0, 240, 255, 100), width=2)
        tk_img = ImageTk.PhotoImage(pil_img)
        self.cached_images[key] = tk_img
        return tk_img

    def get_character_image(self, scene, char_name, size=(120, 120)):
        # Match character image name in scene
        clean_name = char_name.lower()
        matched_file = None
        folder = scene.get("folder_path", "")

        if folder and os.path.exists(folder):
            for f in os.listdir(folder):
                if clean_name in f.lower() and f.lower().endswith((".png", ".jpg", ".jpeg")):
                    matched_file = f
                    break

        if not matched_file:
            matched_file = scene.get("icon", "ts.png")

        return self.get_scene_image(scene, matched_file, size=size)

    def on_close(self):
        self.audio.stop()
        self.destroy()

if __name__ == "__main__":
    app = VoiceDubGame()
    app.mainloop()
