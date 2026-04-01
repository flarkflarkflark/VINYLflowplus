# <img src="assets/vinylflowplus-logo.svg" height="40" vertical-align="middle" />

> [!NOTE]
> **VINYLflowplus** is an enhanced fork of the original [VINYLflow](https://github.com/olimic1000/vinylflow) by [olimic1000](https://github.com/olimic1000). This version adds features, improved naming conventions, and better metadata handling for professional vinyl digitization workflows.

**Digitize vinyl faster. Open source.**

Turn your vinyl recordings into perfectly tagged, organized digital files in minutes - not hours. VINYLflowplus automates track splitting, Discogs metadata tagging, cover art embedding, and vinyl-style numbering (A1, A2, B1, B2).

![VINYLflowplus Demo](docs/demo.gif)

## What Makes VINYLflowplus Different?

VINYLflowplus keeps the original VINYLflow idea intact: upload a recording, detect tracks, fetch Discogs metadata, and export properly tagged files.

What it adds on top is a more complete desktop-oriented workflow:

- **Portable desktop releases** - Windows, macOS, Linux AppImage, and Linux Lite browser edition
- **Workflow polish** - undo, minimap, autoscroll, better queueing, and improved completion flow
- **Better metadata handling** - stronger naming, per-track artists, and sub-track / medley support
- **Distribution focus** - multi-platform release automation for real-world local setups, including lightweight Linux paths

---

## Use VINYLflowplus

- **Desktop apps (Recommended):** Download portable Click and Run builds from [flarkflarkflark.github.io/VINYLflowplus](https://flarkflarkflark.github.io/VINYLflowplus/)
- **Docker (Server):** run locally via [Quick Start (Docker)](#quick-start-docker)
- **Python local mode:** see [Manual Setup (Non-Docker)](#manual-setup-non-docker)

### Desktop artifacts

- **Windows:** `VINYLflowplus-Windows.exe` (portable x64, FFmpeg bundled)
- **macOS Apple Silicon:** `VINYLflowplus-macOS-Universal.zip` (ARM64 for M1/M2/M3)
- **macOS Intel legacy:** `VINYLflowplus-macOS-Intel.zip` (x86_64, 10.15+)
- **Linux:** `VINYLflowplus-Linux.AppImage`
- **Linux Lite:** `VINYLflowplus-Linux-Lite.AppImage` (browser edition)
- **Linux Lite (ARM64):** `VINYLflowplus-Linux-Lite-aarch64.AppImage` (browser edition)

---

## Current highlights (v1.1.0)

- **Undo stack in waveform editor** — undo/redo track boundary edits
- **Minimap overlay** — waveform overview panel for fast navigation across long recordings
- **Autoscroll** — waveform follows playback cursor automatically
- **Settings in step 3** — format and output settings accessible directly in the processing step
- **Full track names with per-track artists** — complete track info shown throughout the processing view
- **Success screen redesign** — new completion screen with one-click open-folder shortcut
- **Top queue bar** — upload queue visible from the top bar throughout the workflow
- **Multi-artist filenames fixed** — now correct in filenames and tags
- **Sub-track / medley support** — Discogs sub-positions (A1.a, A1.b, A1.c) collapsed into one vinyl segment with joined title
- **Two-column processing view** — Queued/Processing left, Done right; track labels show position and title
- **Track mapping transport buttons** — Play, Stop, Previous, Next per track in the mapping view
- **Declick settings in UI** — configure adeclick threshold and burst in Settings modal
- **Progress bar improvement** — overall progress now more up to date
- **Waveform scrub icons** — fast-rewind / fast-forward style; RST replaced by fit-zoom icon
- **Professional vinyl workflow** - track splitting, Discogs metadata, and vinyl-side numbering
- **Interactive cue / hotcue editor** - edit cue start, length, and end with up to 32 slots
- **Realtime processing updates** - live stage, active track, and system metrics
- **Cancelable processing** - safe stop with cleanup of partial outputs
- **Bundled FFmpeg** - included in all desktop builds
- **Cross-platform desktop builds** - Windows, macOS Apple Silicon, macOS Intel legacy, Linux AppImage, Linux Lite AppImage

---

## Features

- **Automatic silence detection** - finds track boundaries in your recording
- **Duration-based splitting** - fallback for seamlessly mixed tracks with no gaps
- **Discogs integration** - visual search with artwork, metadata, and track listings
- **Professional output formats** - FLAC (16/24-bit), MP3 (320/V0), or AIFF
- **Ironclad metadata** - proper A1, A2, B1, B2 notation, year, label, catalog number
- **Cover art** - downloads and embeds high-quality artwork automatically
- **Interactive waveform editor** - fine-tune boundaries and edit cues
- **Cue / hotcue workflow (up to 32)** - manage large releases cleanly
- **Batch queue with realtime progress** - live status and system metrics
- **Cancelable processing** - stop safely when settings need adjustment
- **Restoration tools** - optional highpass rumble filter and loudness normalization
- **Remote access** - control from any device on your network

---

## Quick Start (Docker)

**Recommended path for servers:** Docker (stable). For a portable desktop experience, use the [Desktop Apps](https://flarkflarkflark.github.io/VINYLflowplus/).

### Prerequisites

You'll need:
- **Docker Desktop** (free) - [Download here](https://www.docker.com/products/docker-desktop/)

That's it. Git is optional (see Step 1 below). No need to edit configuration files - VINYLflowplus guides setup in your browser.

## 1. Get VINYLflowplus

### Option A: Download ZIP (easiest - no Git required)

1. Go to [github.com/flarkflarkflark/VINYLflowplus](https://github.com/flarkflarkflark/VINYLflowplus)
2. Click the green **Code** button, then **Download ZIP**
3. Unzip the folder to a location you can find (like your Downloads or Desktop)
4. Open the unzipped `vinylflowplus` folder

### Option B: Clone with Git (for terminal users)

```bash
git clone https://github.com/flarkflarkflark/VINYLflowplus.git
cd vinylflowplus
```

## 2. Start VINYLflowplus

1. **Open your terminal:**
   - **Mac:** Open "Terminal" app (or iTerm)
   - **Windows:** Open "Command Prompt" or "PowerShell"
   - **Linux:** Open your terminal application

2. **Navigate to the VINYLflowplus folder:**
   - If you downloaded the ZIP, type `cd ` (with a space after) and drag the `vinylflowplus` folder into the terminal window, then press Enter
   - Or type the full path, like: `cd ~/Downloads/vinylflowplus` or `cd C:\Users\YourName\Downloads\vinylflowplus`
   - **Windows shortcut:** In File Explorer, open the vinylflowplus folder, click the address bar, type `cmd` and press Enter

3. **Start VINYLflowplus:**
   ```bash
   docker compose up -d
   ```

4. **Open your browser** and go to **http://localhost:8000**

## 3. First-Run Setup

VINYLflowplus no longer uses a first-run welcome modal. Set your Discogs token in **Settings** (recommended before searching):

![VINYLflowplus Setup Screen](docs/modal.png)

1. **Get your free Discogs API token** - Visit [discogs.com/settings/developers](https://www.discogs.com/settings/developers)
2. **Generate a new token** - Click "Generate new token" on the Discogs settings page
3. **Copy and paste** - Open **Settings → Discogs** and paste your token
4. **Save** - Done! You can search Discogs immediately after saving

**That's it.** No hidden files, no terminal commands, no restart needed. Your token is saved securely and persists across restarts.

**Tip:** If Discogs search is empty, check Settings → Discogs first.

---

## Manual Setup (Non-Docker)

For tech-savvy users who prefer managing their own Python environment.

### Prerequisites

You'll need to install these system dependencies first:

- **Python 3.11 or later**
- **FFmpeg** (required for audio processing and format conversion: MP3, FLAC, AIFF)
- **FLAC encoder** (optional, provides dedicated FLAC encoding tools)
- **libsndfile1** (optional, audio I/O library)

**Installation by OS:**

**macOS** (using Homebrew):
```bash
brew install python@3.11 ffmpeg flac libsndfile
```

**Ubuntu/Debian**:
```bash
sudo apt-get update
sudo apt-get install python3.11 python3.11-venv ffmpeg flac libsndfile1-dev
```

**Windows**:
- Install [Python 3.11+](https://www.python.org/downloads/) (check "Add to PATH" during installation)
- Download [FFmpeg](https://ffmpeg.org/download.html) and add it to your PATH
- FLAC and libsndfile are bundled with FFmpeg on Windows

### Installation Steps

```bash
# 1. Clone the repository
git clone https://github.com/flarkflarkflark/VINYLflowplus.git
cd vinylflowplus

# 2. Create and activate a Python virtual environment
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# 3. Install Python dependencies
pip install -r requirements.txt

# 4. Start the server
python -m uvicorn backend.api:app --host 0.0.0.0 --port 8000
```

Open **http://localhost:8000** in your browser.

---

## How It Works

1. **Upload** - drag and drop your WAV or AIFF recording
2. **Analyze** - VINYLflowplus detects track boundaries using silence detection
3. **Search** - find your album on Discogs with visual artwork results
4. **Map** - match detected tracks to Discogs track listings
5. **Choose format** - FLAC, MP3, or AIFF output
6. **Process** - tracks are split, converted, tagged, and saved with cover art

Your files appear in the `output/` folder, organized as `Artist - Album/A1-Track Name.flac`.

---

## Configuration

**Discogs Token**: Managed via the web UI (Settings menu)

**Audio Processing Settings**: Adjust in the app via Settings, or for advanced users, edit `config/settings.json` or `.env`:

```ini
# Silence detection (adjust if tracks are not splitting correctly)
DEFAULT_SILENCE_THRESHOLD=-40      # dB - increase to -35 if tracks are merging
DEFAULT_MIN_SILENCE_DURATION=1.5   # seconds - decrease to 1.0 for short gaps
DEFAULT_MIN_TRACK_LENGTH=30        # seconds - ignore segments shorter than this

# FLAC compression (0-8, higher = smaller files)
DEFAULT_FLAC_COMPRESSION=8
```

**Config Priority**: `config/settings.json` (UI-editable) + `.env` (manual) + environment variables (Docker)

---

## Technology Stack

| Component | Technology |
|---|---|
| Backend | Python, FastAPI, uvicorn |
| Audio processing | FFmpeg |
| Metadata tagging | Mutagen (FLAC, MP3, AIFF) |
| Music database | Discogs API |
| Frontend | Alpine.js, Tailwind CSS |
| Waveform display | WaveSurfer.js |
| Desktop runtime | PyWebView (WebView2 on Windows) |
| Deployment | Docker, PyInstaller |

---

## Contributing

Found a bug? Have a feature idea? [Open an issue](https://github.com/flarkflarkflark/VINYLflowplus/issues) - contributions welcome.

---

## Credits & Acknowledgments

**VINYLflowplus** is a fork of the amazing [VINYLflow](https://github.com/olimic1000/vinylflow) project. Special thanks to the original author, **[olimic1000](https://github.com/olimic1000)**, for inventing such a powerful tool for the vinyl community. We are building on that solid foundation to bring even more features to vinyl enthusiasts everywhere.
