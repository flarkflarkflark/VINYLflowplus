"""
VINYLflowplus - FastAPI Backend
v1.0.0 - Multi-Format Iron Queue (STABLE)
"""

import os
import uuid
import copy
import shutil
import subprocess
import asyncio
from pathlib import Path
from typing import Dict, List, Optional
import json
from datetime import datetime, timedelta
import logging

from fastapi import FastAPI, File, UploadFile, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("VINYLflowplus")

# --- INITIALIZATION ---
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from config import Config
from audio_processor import AudioProcessor, Track, SUPPORTED_INPUT_EXTENSIONS, OUTPUT_FORMATS
from metadata_handler import MetadataHandler

app = FastAPI(title="VINYLflowplus API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- GLOBAL STATE ---
uploaded_files: Dict[str, dict] = {}
processing_jobs: Dict[str, dict] = {}
websocket_connections: List[WebSocket] = []

# --- PATHS ---
_upload_dir_env = os.getenv("VINYLFLOW_UPLOAD_DIR")
UPLOAD_DIR = Path(_upload_dir_env) if _upload_dir_env else Path(__file__).parent.parent / "temp_uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

QUEUE_STATE_FILE = Path(__file__).parent.parent / "config" / "queue_state.json"
QUEUE_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)

# --- CONFIG & HANDLERS ---
config = Config()
audio_processor = AudioProcessor(
    silence_threshold=config.default_silence_threshold,
    min_silence_duration=config.default_min_silence_duration,
    min_track_length=config.default_min_track_length,
    flac_compression=config.default_flac_compression,
)
metadata_handler = MetadataHandler(config.discogs_token, config.discogs_user_agent)

# --- PERSISTENCE LOGIC ---

def save_queue_state():
    try:
        serializable = {}
        for fid, info in uploaded_files.items():
            item = info.copy()
            if "detected_tracks" in item:
                tracks_raw = []
                for t in item["detected_tracks"]:
                    if hasattr(t, 'to_dict'): tracks_raw.append(t.to_dict())
                    elif isinstance(t, dict): tracks_raw.append(t)
                    else: tracks_raw.append({"number": getattr(t, 'number', 0), "start": getattr(t, 'start', 0), "end": getattr(t, 'end', 0), "duration": getattr(t, 'duration', 0)})
                item["detected_tracks"] = tracks_raw
            serializable[fid] = item
        with open(QUEUE_STATE_FILE, "w") as f: json.dump(serializable, f, indent=2)
    except Exception as e: logger.error(f"Sync Failure: {e}")

def load_queue_state():
    global uploaded_files
    if not QUEUE_STATE_FILE.exists(): return
    try:
        with open(QUEUE_STATE_FILE, "r") as f: data = json.load(f)
        verified = {}
        for fid, info in data.items():
            if (UPLOAD_DIR / fid).exists():
                if "detected_tracks" in info: info["detected_tracks"] = [Track(number=t.get("number", 0), start=t.get("start", 0), end=t.get("end", 0)) for t in info["detected_tracks"]]
                verified[fid] = info
        uploaded_files = verified
    except Exception as e: logger.error(f"Failed to load queue state: {e}")

load_queue_state()

# --- HELPER FUNCTIONS ---

def get_session_path(file_id: str, filename: str = None) -> Path:
    session_dir = UPLOAD_DIR / file_id
    return session_dir if filename is None else session_dir / filename

def cleanup_session(file_id: str) -> bool:
    try:
        session_dir = get_session_path(file_id)
        if session_dir.exists(): shutil.rmtree(session_dir)
        if file_id in uploaded_files: del uploaded_files[file_id]
        save_queue_state()
        return True
    except Exception as e:
        if file_id in uploaded_files: del uploaded_files[file_id]
        save_queue_state()
        return False

# --- API MODELS ---

class SearchRequest(BaseModel):
    query: str
    max_results: Optional[int] = 12

class TrackMapping(BaseModel):
    detected: int
    discogs: str
    title: Optional[str] = ""

class TrackBoundary(BaseModel):
    number: int
    start: float
    end: float
    duration: float

class ProcessRequest(BaseModel):
    file_id: str
    release_id: int
    track_mapping: List[TrackMapping]
    track_boundaries: Optional[List[TrackBoundary]] = None
    output_formats: List[str] = ["flac"]
    restoration_level: int = 0
    hum_freq: int = 50

class MultiTrackMapping(BaseModel):
    source_file_id: str
    detected: int
    discogs: str
    title: Optional[str] = ""

class MultiProcessRequest(BaseModel):
    release_id: int
    track_mapping: List[MultiTrackMapping]
    track_boundaries_map: Dict[str, List[TrackBoundary]]
    output_formats: List[str] = ["flac"]
    restoration_level: int = 0
    hum_freq: int = 50

# --- API ROUTES ---

@app.get("/favicon.ico")
async def favicon():
    from fastapi.responses import FileResponse
    favicon_path = Path(__file__).parent / "static" / "favicon.ico"
    if favicon_path.exists():
        return FileResponse(favicon_path)
    # Fallback to PNG if ico doesn't exist
    png_path = Path(__file__).parent.parent / "assets" / "VFplus.png"
    if png_path.exists():
        return FileResponse(png_path)
    raise HTTPException(status_code=404)

@app.get("/")
async def read_root():
    html_path = Path(__file__).parent / "static" / "index.html"
    return HTMLResponse(content=html_path.read_text(encoding="utf-8"))

@app.get("/api/queue")
async def get_queue():
    items = list(uploaded_files.values())
    items.sort(key=lambda x: x.get('filename', ''))
    return {"uploaded": items, "processing": list(processing_jobs.values())}

@app.post("/api/upload")
async def upload_files(files: List[UploadFile] = File(...)):
    uploaded = []
    for file in files:
        file_ext = Path(file.filename).suffix.lower()
        if file_ext not in [ext.lower() for ext in SUPPORTED_INPUT_EXTENSIONS]: continue
        file_id = str(uuid.uuid4())
        session_dir = get_session_path(file_id)
        session_dir.mkdir(parents=True, exist_ok=True)
        file_path = session_dir / f"source{file_ext}"
        with open(file_path, "wb") as buffer:
            while content := await file.read(1024 * 1024): buffer.write(content)
        uploaded_files[file_id] = {"id": file_id, "filename": file.filename, "path": str(file_path), "size": file_path.stat().st_size, "duration": audio_processor.get_audio_duration(file_path) or 0, "status": "uploaded"}
        asyncio.create_task(preconvert_to_mp3(file_id, file_path))
        uploaded.append(uploaded_files[file_id])
    save_queue_state()
    return {"files": uploaded}

@app.delete("/api/queue/{file_id}")
async def remove_from_queue(file_id: str):
    cleanup_session(file_id)
    return {"status": "removed"}

@app.post("/api/analyze")
async def analyze_file(request: dict):
    fid = request.get("file_id")
    info = uploaded_files.get(fid)
    if not info: raise HTTPException(status_code=404)
    await broadcast_message({"type": "progress", "file_id": fid, "progress": 0.1, "message": "Analyzing..."})
    try:
        tracks = audio_processor.detect_silence(Path(info["path"]))
        info["detected_tracks"] = tracks
        info["status"] = "analyzed"
        save_queue_state()
        return {"tracks": [{"number": i+1, "start": t.start, "end": t.end, "duration": t.duration} for i, t in enumerate(tracks)]}
    except Exception as e: raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/search")
async def search_discogs_api(request: SearchRequest):
    releases = metadata_handler.search_releases(request.query, max_results=request.max_results)
    return {"results": [{"id": r.id, "artist": r.artist, "title": r.title, "year": r.year, "label": r.label, "cover_url": r.cover_url, "uri": r.uri, "tracks": [{"position": t.position, "title": t.title, "duration": t.duration_str} for t in r.tracks]} for _, r in releases]}

@app.post("/api/process")
async def process_file_api(request: ProcessRequest):
    job_id = str(uuid.uuid4())
    processing_jobs[job_id] = {"job_id": job_id, "file_id": request.file_id, "status": "processing", "progress": 0.1}
    asyncio.create_task(process_file_background(request, job_id))
    return {"job_id": job_id}

async def process_file_background(request: ProcessRequest, job_id: str):
    try:
        file_info = uploaded_files[request.file_id]
        release = metadata_handler.get_release_by_id(request.release_id)
        det_tracks = [Track(number=b.number, start=b.start, end=b.end) for b in request.track_boundaries] if request.track_boundaries else copy.deepcopy(file_info.get("detected_tracks", []))
        for m in request.track_mapping:
            t = next((x for x in det_tracks if x.number == m.detected), None)
            if t:
                t.vinyl_number = m.discogs
                t.title = m.title

        output_base = Path(config.default_output_dir).expanduser()
        all_outs = []
        total = len(request.output_formats) * len(det_tracks)
        count = 0

        for fmt in request.output_formats:
            album_folder = output_base / metadata_handler.create_album_folder_name(release, fmt)
            album_folder.mkdir(parents=True, exist_ok=True)
            cover_data = None
            if release.cover_url:
                cp = album_folder / "folder.jpg"
                if metadata_handler.download_cover_art(release.cover_url, cp): cover_data = metadata_handler.prepare_cover_for_embedding(cp)

            for track in det_tracks:
                count += 1
                prog = 0.1 + (count/total)*0.8
                msg = f"[{fmt.upper()}] Processing Track {track.vinyl_number}..."
                processing_jobs[job_id].update({"progress": prog, "message": msg})
                await broadcast_message({"type": "progress", "file_id": request.file_id, "progress": prog, "message": msg})
                
                temp = album_folder / f"temp_{track.vinyl_number}{OUTPUT_FORMATS[fmt]['extension']}"
                audio_processor.extract_track(Path(file_info["path"]), track, temp, fmt, restoration_level=request.restoration_level, hum_freq=request.hum_freq)
                metadata_handler.tag_file(temp, track, release, cover_data, fmt)
                final_name = metadata_handler.create_track_filename(track, release, fmt)
                final_path = album_folder / final_name
                if final_path.exists(): final_path.unlink()
                temp.rename(final_path)
                # Final safety check: force track tag from final filename
                metadata_handler.fix_track_tags_from_filename(final_path, fmt)
                all_outs.append(f"[{fmt.upper()}] {final_name}")

        processing_jobs[job_id].update({"status": "complete", "progress": 1.0, "tracks": all_outs})
        if request.file_id in uploaded_files: 
            uploaded_files[request.file_id]["status"] = "completed"
            save_queue_state()
        await broadcast_message({"type": "complete", "file_id": request.file_id, "tracks": all_outs})
    except Exception as e:
        processing_jobs[job_id].update({"status": "error", "error": str(e)})
        await broadcast_message({"type": "error", "file_id": request.file_id, "message": str(e)})

@app.post("/api/multi-process")
async def multi_process_api(request: MultiProcessRequest):
    job_id = str(uuid.uuid4())
    processing_jobs[job_id] = {"job_id": job_id, "status": "processing", "progress": 0.1}
    asyncio.create_task(multi_process_background(request, job_id))
    return {"job_id": job_id}

async def multi_process_background(request: MultiProcessRequest, job_id: str):
    try:
        release = metadata_handler.get_release_by_id(request.release_id)
        output_base = Path(config.default_output_dir).expanduser()
        all_outs = []
        total = len(request.output_formats) * len(request.track_mapping)
        count = 0

        for fmt in request.output_formats:
            album_folder = output_base / metadata_handler.create_album_folder_name(release, fmt)
            album_folder.mkdir(parents=True, exist_ok=True)
            cover_data = None
            if release.cover_url:
                cp = album_folder / "folder.jpg"
                if metadata_handler.download_cover_art(release.cover_url, cp): cover_data = metadata_handler.prepare_cover_for_embedding(cp)

            for m in request.track_mapping:
                count += 1
                prog = 0.1 + (count/total)*0.8
                msg = f"[{fmt.upper()}] Processing {m.discogs}..."
                processing_jobs[job_id].update({"progress": prog, "message": msg})
                await broadcast_message({"type": "progress", "file_id": "multi", "progress": prog, "message": msg})
                
                f_info = uploaded_files.get(m.source_file_id)
                if not f_info: continue
                bounds = request.track_boundaries_map.get(m.source_file_id, [])
                b = next((x for x in bounds if x.number == m.detected), None)
                if not b: continue
                
                track_obj = Track(number=m.detected, start=b.start, end=b.end)
                track_obj.vinyl_number = m.discogs
                track_obj.title = m.title
                temp = album_folder / f"temp_{m.discogs}{OUTPUT_FORMATS[fmt]['extension']}"
                audio_processor.extract_track(Path(f_info["path"]), track_obj, temp, fmt, restoration_level=request.restoration_level, hum_freq=request.hum_freq)
                metadata_handler.tag_file(temp, track_obj, release, cover_data, fmt)
                final_name = metadata_handler.create_track_filename(track_obj, release, fmt)
                final_path = album_folder / final_name
                if final_path.exists(): final_path.unlink()
                temp.rename(final_path)
                # Final safety check: force track tag from final filename
                metadata_handler.fix_track_tags_from_filename(final_path, fmt)
                all_outs.append(f"[{fmt.upper()}] {final_name}")

        processing_jobs[job_id].update({"status": "complete", "progress": 1.0, "tracks": all_outs})
        for fid in set(m.source_file_id for m in request.track_mapping):
            if fid in uploaded_files: uploaded_files[fid]["status"] = "completed"
        save_queue_state()
        await broadcast_message({"type": "complete", "file_id": "multi", "tracks": all_outs})
    except Exception as e:
        processing_jobs[job_id].update({"status": "error", "error": str(e)})

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    websocket_connections.append(websocket)
    try:
        await websocket.send_json({"type": "connected"})
        while True:
            data = await websocket.receive_text()
            if data == "ping": await websocket.send_text("pong")
    except: websocket_connections.remove(websocket)

async def broadcast_message(message: dict):
    for ws in websocket_connections[:]:
        try: await ws.send_json(message)
        except: websocket_connections.remove(ws)

async def preconvert_to_mp3(fid: str, path: Path):
    mp3 = get_session_path(fid, "full.mp3")
    if not mp3.exists():
        try: await asyncio.to_thread(subprocess.run, ["ffmpeg", "-y", "-i", str(path), "-ac", "2", "-acodec", "libmp3lame", "-b:a", "192k", str(mp3)], capture_output=True)
        except: pass

@app.post("/api/utils/select-folder")
async def select_folder_api():
    import shutil
    cmd = ["kdialog", "--getexistingdirectory", os.path.expanduser("~")] if shutil.which("kdialog") else ["zenity", "--file-selection", "--directory"]
    try:
        res = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True)
        return {"path": res.stdout.strip() or None}
    except: return {"path": None}

@app.get("/api/status")
async def get_status(): return {"discogs_configured": bool(config.discogs_token and config.discogs_token != "your_token_here")}

@app.get("/api/formats")
async def get_formats(): return {"formats": [{"id": k, "label": v["label"]} for k, v in OUTPUT_FORMATS.items()]}

@app.get("/api/config")
async def get_config_api(): return {"silence_threshold": audio_processor.silence_threshold, "min_silence_duration": audio_processor.min_silence_duration, "min_track_length": audio_processor.min_track_length, "output_dir": config.default_output_dir, "flac_compression": audio_processor.flac_compression}

@app.put("/api/config")
async def update_config_api(updates: dict):
    if "output_dir" in updates: 
        config.default_output_dir = updates["output_dir"]
        config.save_output_dir(updates["output_dir"])
    if "flac_compression" in updates: audio_processor.flac_compression = int(updates["flac_compression"])
    return await get_config_api()

@app.get("/api/waveform-peaks/{file_id}")
async def get_peaks(file_id: str):
    info = uploaded_files.get(file_id)
    if not info: raise HTTPException(status_code=404)
    peaks_cache_path = get_session_path(file_id, "peaks.json")
    if peaks_cache_path.exists():
        with open(peaks_cache_path, "r") as f: return JSONResponse(content=json.load(f))
    try:
        cmd = ["ffmpeg", "-i", info["path"], "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", "8000", "-"]
        result = subprocess.run(cmd, capture_output=True, check=True, timeout=60)
        import numpy as np
        audio_data = np.frombuffer(result.stdout, dtype=np.int16)
        samples_per_peak = max(1, len(audio_data) // 3000)
        peaks = [float(np.max(np.abs(audio_data[i : i + samples_per_peak])) / 32768.0) for i in range(0, len(audio_data), samples_per_peak) if len(audio_data[i : i + samples_per_peak]) > 0]
        res = {"peaks": peaks or [0.0], "length": len(peaks), "duration": info.get("duration", 0)}
        with open(peaks_cache_path, "w") as f: json.dump(res, f)
        return JSONResponse(content=res)
    except: raise HTTPException(status_code=500)

@app.get("/api/audio/{file_id}")
async def get_audio(file_id: str):
    info = uploaded_files.get(file_id)
    if not info: raise HTTPException(status_code=404)
    from fastapi.responses import FileResponse
    return FileResponse(info["path"])

@app.get("/api/process/{job_id}")
async def get_job(job_id: str): return processing_jobs.get(job_id, {"status": "not_found"})

app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))
