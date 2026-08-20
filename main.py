#!/usr/bin/env python3
"""
Voice Dub Hero - Main Python Launcher
"""

import sys
import os

# Ensure local venv or packages are in sys.path
venv_site = os.path.join(os.path.dirname(__file__), "venv", "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages")
if os.path.exists(venv_site) and venv_site not in sys.path:
    sys.path.insert(0, venv_site)

from game import VoiceDubGame

if __name__ == "__main__":
    print("==================================================")
    print("🎙️ INICIANDO VOICE DUB HERO (PYTHON GAME)")
    print("==================================================")
    app = VoiceDubGame()
    app.mainloop()
