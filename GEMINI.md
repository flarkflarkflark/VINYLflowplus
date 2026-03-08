# 🎵 VINYLflowplus Workspace State

Dit bestand bevat de configuratie en aanpassingen die zijn doorgevoerd voor deze specifieke installatie.

## 🛠 Systeem Configuratie
- **Projectlocatie:** `/mnt/PRODUCTION/GIT/VINYLflowplus` (exFAT partitie)
- **Virtuele Omgeving (venv):** `/home/flark/.gemini/tmp/vinylflowplus/venv`
- **Output Map:** `/mnt/PRODUCTION/GIT/VINYLflowplus/output/`
- **Persistent Settings:** `/mnt/PRODUCTION/GIT/VINYLflowplus/config/settings.json`

## ✨ Nieuwe Features & Aanpassingen
### 1. Audio Support
- Volledige ondersteuning voor **24-bit FLAC** (inclusief correcte tagging).
- Ondersteuning voor **MP3 (320kbps)** import en export.
- Sample rates geforceerd naar **44.1 kHz** voor optimale grootte/kwaliteit balans.

### 2. Multi-File Workflow
- **🪄 Merge & Analyze:** Mogelijkheid om losse bestanden (bijv. Side A, B, C, D) samen te voegen met 3s stilte voor gezamenlijke analyse.
- **Batch Processing:** Ondersteuning voor het mappen van tracks uit verschillende bronbestanden naar één album.

### 3. UI & UX
- **Thema:** Goudgele styling (`#E5A100`) consistent doorgevoerd.
- **Queue:** Alfabetisch gesorteerd en vergroot naar 600px voor beter overzicht.
- **Error Handling:** Verbeterde alerts bij analyse- of visualisatiefouten.
- **Naming Convention:**
  - Mappen: `Artist - Title [Label - CatNo][Year][Format]`
  - Bestanden: `Position - Artist - Title.ext`

### 4. Desktop Integratie (Bugfixes v1.0.3+)
- **Standalone FFmpeg Fix:** Backend gebruikt nu altijd de gebundelde FFmpeg-binary via `_ffmpeg()` helper (lost "Silent Failure" op Windows op).
- **Backend Logging:** Realtime voortgang en foutmeldingen zichtbaar in de terminal van de launcher.
- KDE Desktop snelkoppeling met goudgeel icoon (`assets/VFplus.png`).
- Start in een open Terminal venster voor realtime voortgangscontrole.
- Automatische poort-vrijgave bij opstarten (killt oude server op 8000).

## 🚀 Commando's
- **Start Server:** `/home/flark/.gemini/tmp/vinylflowplus/venv/bin/python -m uvicorn backend.api:app --host 0.0.0.0 --port 8000`
- **Stitcher Script:** `/mnt/PRODUCTION/GIT/VINYLflowplus/stitcher.py` (hulpscript voor handmatig mergen)
