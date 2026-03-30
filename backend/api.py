"""
VINYLflowplus - FastAPI Backend
v1.0.3 - Multi-Format Iron Queue (STABLE)
"""

import os
import sys
import uuid
import copy
import shutil
import subprocess
import asyncio
import time
from pathlib import Path
from typing import Dict, List, Optional
import json
import threading
from datetime import datetime, timedelta
import logging

from fastapi import FastAPI, File, UploadFile, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Setup logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger("VINYLflowplus")

# Constants for Windows subprocess management
CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

# --- INITIALIZATION ---
import sys
import numpy as np
sys.path.insert(0, str(Path(__file__).parent.parent))

from config import Config
from audio_processor import AudioProcessor, Track, SUPPORTED_INPUT_EXTENSIONS, OUTPUT_FORMATS, resolve_ffmpeg, ProcessingCancelled
from metadata_handler import MetadataHandler

try:
    import psutil
    _psutil_error = None
except Exception as e:
    psutil = None
    _psutil_error = repr(e)

def _ensure_psutil():
    global psutil, _psutil_error
    if psutil is not None:
        return
    try:
        import importlib
        psutil = importlib.import_module("psutil")
        _psutil_error = None
    except Exception as e:
        _psutil_error = repr(e)

def _ffmpeg() -> str:
    """Return the ffmpeg executable to use (validated by resolve_ffmpeg)."""
    return resolve_ffmpeg().get("path") or "ffmpeg"

app = FastAPI(title="VINYLflowplus API", version="1.0.3")

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
processing_cancel_flags: Dict[str, threading.Event] = {}
websocket_connections: List[WebSocket] = []

def _update_job_progress(job_id: str, **updates) -> None:
    job = processing_jobs.get(job_id)
    if not job:
        return
    updates.setdefault("updated_at", time.time())
    job.update(updates)

def _cancel_event(job_id: str) -> Optional[threading.Event]:
    return processing_cancel_flags.get(job_id)

# --- PATHS ---
def get_base_path():
    # 1. Environment Variable (highest priority)
    env_path = os.getenv("VINYLFLOW_DATA_DIR")
    if env_path:
        p = Path(env_path)
        try:
            p.mkdir(parents=True, exist_ok=True)
            return p
        except: pass

    # 2. Try Home Directory (safest for Linux/Mac)
    home_dir = Path.home() / ".vinylflowplus"
    try:
        home_dir.mkdir(parents=True, exist_ok=True)
        # Test write access
        test_f = home_dir / ".write_test"
        test_f.touch()
        test_f.unlink()
        return home_dir
    except:
        pass

    # 3. Last resort: Current Working Directory
    return Path.cwd()

# Initialize paths with absolute safety
BASE_DATA_PATH = get_base_path()

_upload_dir_env = os.getenv("VINYLFLOW_UPLOAD_DIR")
UPLOAD_DIR = Path(_upload_dir_env) if _upload_dir_env else BASE_DATA_PATH / "temp_uploads"
try:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
except:
    # Final Emergency: /tmp
    UPLOAD_DIR = Path("/tmp/vinylflow_uploads")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

QUEUE_STATE_FILE = BASE_DATA_PATH / "config" / "queue_state.json"
try:
    QUEUE_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
except:
    # Final Emergency: /tmp
    QUEUE_STATE_FILE = Path("/tmp/vinylflow_queue.json")

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
            status = info.get("status")
            if status not in ("processing", "complete", "completed"):
                continue
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
            status = info.get("status")
            if status in ("uploaded", "analyzed") or status not in ("processing", "complete", "completed"):
                continue
            file_path = Path(info.get("path", ""))
            if not file_path.exists() or not (UPLOAD_DIR / fid).exists():
                continue
            if "detected_tracks" in info: info["detected_tracks"] = [Track(number=t.get("number", 0), start=t.get("start", 0), end=t.get("end", 0)) for t in info["detected_tracks"]]
            verified[fid] = info
        uploaded_files = verified
        save_queue_state()
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

@app.post("/api/merge")
async def merge_files_api(request: dict):
    file_ids = request.get("file_ids", [])
    if not file_ids: raise HTTPException(status_code=400, detail="No files selected")
    
    # Create master session
    master_fid = str(uuid.uuid4())
    master_dir = UPLOAD_DIR / master_fid
    master_dir.mkdir(parents=True, exist_ok=True)
    master_path = master_dir / "VINYLflowplus_merged_master.wav"
    
    # Prep inputs
    inputs = []
    for fid in file_ids:
        info = uploaded_files.get(fid)
        if info: inputs.append(Path(info["path"]))
    
    if not inputs: raise HTTPException(status_code=404)
    
    try:
        # Generate 3s silence
        silence = master_dir / "silence_3s.wav"
        await asyncio.to_thread(subprocess.run, [_ffmpeg(), "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "3", str(silence)], capture_output=True, creationflags=CREATE_NO_WINDOW)
        
        # Build concat filter
        filter_complex = ""
        cmd = [_ffmpeg(), "-y"]
        for i, path in enumerate(inputs):
            cmd.extend(["-i", str(path)])
            filter_complex += f"[{i}:a][{len(inputs)}:a]" # Audio + Silence
        
        cmd.extend(["-i", str(silence)])
        filter_complex += f"concat=n={len(inputs)*2}:v=0:a=1[outa]"
        cmd.extend(["-filter_complex", filter_complex, "-map", "[outa]", str(master_path)])
        
        await asyncio.to_thread(subprocess.run, cmd, capture_output=True, creationflags=CREATE_NO_WINDOW)
        if silence.exists(): silence.unlink()
        
        # Add to queue
        duration = audio_processor.get_audio_duration(master_path)
        new_info = {
            "id": master_fid,
            "filename": "VINYLflowplus_merged_master.wav",
            "path": str(master_path),
            "size": master_path.stat().st_size,
            "duration": duration,
            "status": "uploaded",
            "detected_tracks": []
        }
        uploaded_files[master_fid] = new_info
        save_queue_state()
        return {"file_id": master_fid}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/analyze")
async def analyze_file(request: dict):
    fid = request.get("file_id")
    info = uploaded_files.get(fid)
    if not info: raise HTTPException(status_code=404)
    
    # Check if duration is 0 (FFmpeg failure)
    if info.get("duration", 0) <= 0:
        raise HTTPException(status_code=500, detail="FFmpeg failed to read file duration. Please ensure FFmpeg is working correctly.")

    await broadcast_message({"type": "progress", "file_id": fid, "progress": 0.1, "message": "Analyzing..."})
    try:
        logger.info(f"Analyzing file: {info['path']}")
        tracks = audio_processor.detect_silence(Path(info["path"]))
        logger.info(f"Detected {len(tracks)} tracks")
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
    processing_cancel_flags[job_id] = threading.Event()
    processing_jobs[job_id] = {
        "job_id": job_id,
        "file_id": request.file_id,
        "status": "processing",
        "cancel_requested": False,
        "progress": 0.1,
        "message": "Processing...",
        "updated_at": time.time(),
    }
    asyncio.create_task(process_file_background(request, job_id))
    return {"job_id": job_id}

async def process_file_background(request: ProcessRequest, job_id: str):
    cancel_event = _cancel_event(job_id)
    def _check_cancel():
        if cancel_event and cancel_event.is_set():
            raise ProcessingCancelled("Processing cancelled")

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

        current_temp = None
        for fmt_idx, fmt in enumerate(request.output_formats, start=1):
            _check_cancel()
            album_folder = output_base / metadata_handler.create_album_folder_name(release, fmt)
            album_folder.mkdir(parents=True, exist_ok=True)
            cover_data = None
            if release.cover_url:
                cp = album_folder / "folder.jpg"
                if metadata_handler.download_cover_art(release.cover_url, cp): cover_data = metadata_handler.prepare_cover_for_embedding(cp)

            for track_idx, track in enumerate(det_tracks, start=1):
                _check_cancel()
                count += 1
                prog_start = 0.1 + ((count - 1) / total) * 0.8
                msg = "Processing..."
                _update_job_progress(
                    job_id,
                    progress=prog_start,
                    message=msg,
                    stage="track_start",
                    track={
                        "number": track.number,
                        "vinyl_number": track.vinyl_number,
                        "title": track.title,
                    },
                    track_index=track_idx,
                    track_total=len(det_tracks),
                    format=fmt,
                    format_label=OUTPUT_FORMATS[fmt]["label"],
                    format_index=fmt_idx,
                    format_total=len(request.output_formats),
                )
                await broadcast_message({
                    "type": "progress",
                    "stage": "track_start",
                    "file_id": request.file_id,
                    "progress": prog_start,
                    "message": msg,
                    "track": {
                        "number": track.number,
                        "vinyl_number": track.vinyl_number,
                        "title": track.title,
                    },
                    "track_index": track_idx,
                    "track_total": len(det_tracks),
                    "format": fmt,
                    "format_label": OUTPUT_FORMATS[fmt]["label"],
                    "format_index": fmt_idx,
                    "format_total": len(request.output_formats),
                })
                
                vinyl_number = metadata_handler.sanitize_filename(track.vinyl_number or f"T{track.number}")
                if not vinyl_number:
                    vinyl_number = f"T{track.number}"
                temp = album_folder / f"temp_{vinyl_number}{OUTPUT_FORMATS[fmt]['extension']}"
                current_temp = temp
                await asyncio.to_thread(
                    audio_processor.extract_track,
                    Path(file_info["path"]),
                    track,
                    temp,
                    fmt,
                    False,
                    request.restoration_level,
                    request.hum_freq,
                    cancel_event=cancel_event,
                )
                _check_cancel()
                metadata_handler.tag_file(temp, track, release, cover_data, fmt)
                _check_cancel()
                final_name = metadata_handler.create_track_filename(track, release, fmt)
                final_path = album_folder / final_name
                if final_path.exists(): final_path.unlink()
                temp.rename(final_path)
                current_temp = None
                # Final safety check: force track tag from final filename
                metadata_handler.fix_track_tags_from_filename(final_path, fmt)
                all_outs.append(f"[{fmt.upper()}] {final_name}")
                prog_done = 0.1 + (count / total) * 0.8
                _update_job_progress(
                    job_id,
                    progress=prog_done,
                    message=msg,
                    stage="track_done",
                    track={
                        "number": track.number,
                        "vinyl_number": track.vinyl_number,
                        "title": track.title,
                    },
                    track_index=track_idx,
                    track_total=len(det_tracks),
                    format=fmt,
                    format_label=OUTPUT_FORMATS[fmt]["label"],
                    format_index=fmt_idx,
                    format_total=len(request.output_formats),
                )
                await broadcast_message({
                    "type": "progress",
                    "stage": "track_done",
                    "file_id": request.file_id,
                    "progress": prog_done,
                    "message": msg,
                    "track": {
                        "number": track.number,
                        "vinyl_number": track.vinyl_number,
                        "title": track.title,
                    },
                    "track_index": track_idx,
                    "track_total": len(det_tracks),
                    "format": fmt,
                    "format_label": OUTPUT_FORMATS[fmt]["label"],
                    "format_index": fmt_idx,
                    "format_total": len(request.output_formats),
                })

        _update_job_progress(job_id, status="complete", progress=1.0, tracks=all_outs, message="Complete")
        if request.file_id in uploaded_files: 
            uploaded_files[request.file_id]["status"] = "completed"
            save_queue_state()
        await broadcast_message({"type": "complete", "file_id": request.file_id, "tracks": all_outs})
    except ProcessingCancelled:
        if current_temp and current_temp.exists():
            try:
                current_temp.unlink()
            except Exception:
                pass
        _update_job_progress(job_id, status="cancelled", message="Cancelled", stage="cancelled", cancel_requested=True)
        if request.file_id in uploaded_files:
            uploaded_files[request.file_id]["status"] = "cancelled"
            save_queue_state()
        await broadcast_message({"type": "cancelled", "file_id": request.file_id, "job_id": job_id, "status": "cancelled"})
    except Exception as e:
        _update_job_progress(job_id, status="error", error=str(e), message="Error")
        await broadcast_message({"type": "error", "file_id": request.file_id, "message": str(e)})
    finally:
        processing_cancel_flags.pop(job_id, None)

@app.post("/api/multi-process")
async def multi_process_api(request: MultiProcessRequest):
    job_id = str(uuid.uuid4())
    processing_cancel_flags[job_id] = threading.Event()
    processing_jobs[job_id] = {
        "job_id": job_id,
        "status": "processing",
        "cancel_requested": False,
        "progress": 0.1,
        "message": "Processing...",
        "updated_at": time.time(),
    }
    asyncio.create_task(multi_process_background(request, job_id))
    return {"job_id": job_id}

async def multi_process_background(request: MultiProcessRequest, job_id: str):
    cancel_event = _cancel_event(job_id)
    def _check_cancel():
        if cancel_event and cancel_event.is_set():
            raise ProcessingCancelled("Processing cancelled")

    try:
        release = metadata_handler.get_release_by_id(request.release_id)
        output_base = Path(config.default_output_dir).expanduser()
        all_outs = []
        total = len(request.output_formats) * len(request.track_mapping)
        count = 0

        current_temp = None
        for fmt_idx, fmt in enumerate(request.output_formats, start=1):
            _check_cancel()
            album_folder = output_base / metadata_handler.create_album_folder_name(release, fmt)
            album_folder.mkdir(parents=True, exist_ok=True)
            cover_data = None
            if release.cover_url:
                cp = album_folder / "folder.jpg"
                if metadata_handler.download_cover_art(release.cover_url, cp): cover_data = metadata_handler.prepare_cover_for_embedding(cp)

            for track_idx, m in enumerate(request.track_mapping, start=1):
                _check_cancel()
                count += 1
                prog_start = 0.1 + ((count - 1) / total) * 0.8
                msg = "Processing..."
                _update_job_progress(
                    job_id,
                    progress=prog_start,
                    message=msg,
                    stage="track_start",
                    track={
                        "number": m.detected,
                        "vinyl_number": m.discogs,
                        "title": m.title,
                    },
                    track_index=track_idx,
                    track_total=len(request.track_mapping),
                    format=fmt,
                    format_label=OUTPUT_FORMATS[fmt]["label"],
                    format_index=fmt_idx,
                    format_total=len(request.output_formats),
                )
                await broadcast_message({
                    "type": "progress",
                    "stage": "track_start",
                    "file_id": "multi",
                    "progress": prog_start,
                    "message": msg,
                    "track": {
                        "number": m.detected,
                        "vinyl_number": m.discogs,
                        "title": m.title,
                    },
                    "track_index": track_idx,
                    "track_total": len(request.track_mapping),
                    "format": fmt,
                    "format_label": OUTPUT_FORMATS[fmt]["label"],
                    "format_index": fmt_idx,
                    "format_total": len(request.output_formats),
                })
                
                f_info = uploaded_files.get(m.source_file_id)
                if not f_info: continue
                bounds = request.track_boundaries_map.get(m.source_file_id, [])
                b = next((x for x in bounds if x.number == m.detected), None)
                if not b: continue
                
                track_obj = Track(number=m.detected, start=b.start, end=b.end)
                track_obj.vinyl_number = m.discogs
                track_obj.title = m.title
                vinyl_number = metadata_handler.sanitize_filename(m.discogs or f"T{m.detected}")
                if not vinyl_number:
                    vinyl_number = f"T{m.detected}"
                temp = album_folder / f"temp_{vinyl_number}{OUTPUT_FORMATS[fmt]['extension']}"
                current_temp = temp
                await asyncio.to_thread(
                    audio_processor.extract_track,
                    Path(f_info["path"]),
                    track_obj,
                    temp,
                    fmt,
                    False,
                    request.restoration_level,
                    request.hum_freq,
                    cancel_event=cancel_event,
                )
                _check_cancel()
                metadata_handler.tag_file(temp, track_obj, release, cover_data, fmt)
                _check_cancel()
                final_name = metadata_handler.create_track_filename(track_obj, release, fmt)
                final_path = album_folder / final_name
                if final_path.exists(): final_path.unlink()
                temp.rename(final_path)
                current_temp = None
                # Final safety check: force track tag from final filename
                metadata_handler.fix_track_tags_from_filename(final_path, fmt)
                all_outs.append(f"[{fmt.upper()}] {final_name}")
                prog_done = 0.1 + (count / total) * 0.8
                _update_job_progress(
                    job_id,
                    progress=prog_done,
                    message=msg,
                    stage="track_done",
                    track={
                        "number": m.detected,
                        "vinyl_number": m.discogs,
                        "title": m.title,
                    },
                    track_index=track_idx,
                    track_total=len(request.track_mapping),
                    format=fmt,
                    format_label=OUTPUT_FORMATS[fmt]["label"],
                    format_index=fmt_idx,
                    format_total=len(request.output_formats),
                )
                await broadcast_message({
                    "type": "progress",
                    "stage": "track_done",
                    "file_id": "multi",
                    "progress": prog_done,
                    "message": msg,
                    "track": {
                        "number": m.detected,
                        "vinyl_number": m.discogs,
                        "title": m.title,
                    },
                    "track_index": track_idx,
                    "track_total": len(request.track_mapping),
                    "format": fmt,
                    "format_label": OUTPUT_FORMATS[fmt]["label"],
                    "format_index": fmt_idx,
                    "format_total": len(request.output_formats),
                })

        _update_job_progress(job_id, status="complete", progress=1.0, tracks=all_outs, message="Complete")
        for fid in set(m.source_file_id for m in request.track_mapping):
            if fid in uploaded_files: uploaded_files[fid]["status"] = "completed"
        save_queue_state()
        await broadcast_message({"type": "complete", "file_id": "multi", "tracks": all_outs})
    except ProcessingCancelled:
        if current_temp and current_temp.exists():
            try:
                current_temp.unlink()
            except Exception:
                pass
        _update_job_progress(job_id, status="cancelled", message="Cancelled", stage="cancelled", cancel_requested=True)
        for fid in set(m.source_file_id for m in request.track_mapping):
            if fid in uploaded_files:
                uploaded_files[fid]["status"] = "cancelled"
        save_queue_state()
        await broadcast_message({"type": "cancelled", "file_id": "multi", "job_id": job_id, "status": "cancelled"})
    except Exception as e:
        _update_job_progress(job_id, status="error", error=str(e), message="Error")
    finally:
        processing_cancel_flags.pop(job_id, None)

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
        try: await asyncio.to_thread(subprocess.run, [_ffmpeg(), "-y", "-i", str(path), "-ac", "2", "-acodec", "libmp3lame", "-b:a", "192k", str(mp3)], capture_output=True, creationflags=CREATE_NO_WINDOW)
        except: pass

@app.post("/api/utils/select-folder")
async def select_folder_api():
    if sys.platform == "win32":
        # Use PowerShell FolderBrowserDialog with a topmost dummy form as owner
        # so the dialog always appears in front of the pywebview window.
        ps_script = """
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing

        # Invisible owner form — forces dialog to top of z-order
        $owner = New-Object System.Windows.Forms.Form
        $owner.TopMost = $true
        $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $owner.Width  = 0
        $owner.Height = 0
        $owner.ShowInTaskbar = $false
        $owner.Show()
        $owner.Activate()

        $f = New-Object System.Windows.Forms.FolderBrowserDialog
        $f.Description = "Select VINYLflowplus Output Folder"
        $f.ShowNewFolderButton = $true
        $result = $f.ShowDialog($owner)
        $owner.Dispose()
        if ($result -eq "OK") {
            Write-Output $f.SelectedPath
        }
        """
        try:
            res = await asyncio.to_thread(
                subprocess.run,
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
                capture_output=True, text=True, creationflags=CREATE_NO_WINDOW
            )
            path = res.stdout.strip()
            return {"path": path if path else None}
        except:
            return {"path": None}
    
    import shutil
    cmd = ["kdialog", "--getexistingdirectory", os.path.expanduser("~")] if shutil.which("kdialog") else ["zenity", "--file-selection", "--directory"]
    try:
        res = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, creationflags=CREATE_NO_WINDOW)
        return {"path": res.stdout.strip() or None}
    except: return {"path": None}

@app.get("/api/status")
async def get_status(): 
    resolution = resolve_ffmpeg()
    ffmpeg_ok = bool(resolution.get("ok"))
    ffmpeg_ver = resolution.get("version") or ("Error running ffmpeg" if not ffmpeg_ok else "Unknown version")
    ffmpeg_last_error = audio_processor.last_error
    if not ffmpeg_ok and not ffmpeg_last_error:
        ffmpeg_last_error = resolution.get("error") or (resolution.get("stderr") or "")[:500]
    
    return {
        "discogs_configured": bool(config.discogs_token and config.discogs_token != "your_token_here"),
        "ffmpeg_ok": ffmpeg_ok,
        "ffmpeg_version": ffmpeg_ver,
        "ffmpeg_last_error": ffmpeg_last_error,
        "ffmpeg_path": resolution.get("path"),
        "ffmpeg_source": resolution.get("source"),
        "ffmpeg_fallback": resolution.get("fallback_used"),
        "ffmpeg_path_exists": resolution.get("exists"),
        "ffmpeg_bundled_refreshed": resolution.get("copy_refreshed"),
        "ffmpeg_smoke_returncode": resolution.get("returncode"),
        "data_dir": str(BASE_DATA_PATH),
        "os": sys.platform
    }

@app.get("/api/system-metrics")
async def get_system_metrics():
    _ensure_psutil()
    data = {
        "cpu_percent": None,
        "ram_used_gb": None,
        "ram_total_gb": None,
        "ram_percent": None,
        "process_rss_mb": None,
        "psutil_available": bool(psutil),
    }
    if _psutil_error:
        data["psutil_error"] = _psutil_error
    if psutil:
        try:
            data["cpu_percent"] = psutil.cpu_percent(interval=0.1)
            mem = psutil.virtual_memory()
            data["ram_used_gb"] = round(mem.used / (1024 ** 3), 2)
            data["ram_total_gb"] = round(mem.total / (1024 ** 3), 2)
            data["ram_percent"] = mem.percent
            proc = psutil.Process(os.getpid())
            data["process_rss_mb"] = round(proc.memory_info().rss / (1024 ** 2), 1)
        except Exception:
            pass
    return data

@app.get("/api/formats")
async def get_formats(): return {"formats": [{"id": k, "label": v["label"]} for k, v in OUTPUT_FORMATS.items()]}

@app.get("/api/config")
async def get_config_api(): 
    return {
        "silence_threshold": audio_processor.silence_threshold, 
        "min_silence_duration": audio_processor.min_silence_duration, 
        "min_track_length": audio_processor.min_track_length, 
        "output_dir": config.default_output_dir, 
        "flac_compression": audio_processor.flac_compression,
        "discogs_user_token": config.discogs_token,
        "discogs_user_agent": config.discogs_user_agent,
        "default_output_formats": config.default_output_formats,
        "default_restoration_level": config.default_restoration_level
    }

@app.put("/api/config")
async def update_config_api(updates: dict):
    if "output_dir" in updates: 
        config.default_output_dir = updates["output_dir"]
        config.save_output_dir(updates["output_dir"])
    if "flac_compression" in updates: audio_processor.flac_compression = int(updates["flac_compression"])
    if "discogs_user_token" in updates or "discogs_user_agent" in updates:
        token = updates.get("discogs_user_token", config.discogs_token)
        user_agent = updates.get("discogs_user_agent", config.discogs_user_agent)
        config.save_token(token, user_agent)
        config.discogs_token = token
        config.discogs_user_agent = user_agent
        metadata_handler.reinitialize(config.discogs_token, config.discogs_user_agent)
    return await get_config_api()

@app.post("/api/config/processing-defaults")
async def save_processing_defaults_api(data: dict):
    formats = data.get("formats", ["flac"])
    restoration = int(data.get("restoration_level", 0))
    config.save_processing_defaults(formats, restoration)
    config.default_output_formats = formats
    config.default_restoration_level = restoration
    return {"status": "success"}

@app.get("/api/waveform-peaks/{file_id}")
async def get_peaks(file_id: str):
    info = uploaded_files.get(file_id)
    if not info: raise HTTPException(status_code=404)
    peaks_cache_path = get_session_path(file_id, "peaks.json")
    if peaks_cache_path.exists():
        with open(peaks_cache_path, "r") as f: return JSONResponse(content=json.load(f))
    try:
        cmd = [_ffmpeg(), "-i", info["path"], "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", "8000", "-"]
        result = subprocess.run(cmd, capture_output=True, check=True, timeout=60, creationflags=CREATE_NO_WINDOW)
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

@app.post("/api/process/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = processing_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    status = job.get("status")
    if status not in ("processing", "cancelling"):
        return {"job_id": job_id, "status": status, "cancel_requested": False}
    event = _cancel_event(job_id)
    if event:
        event.set()
    _update_job_progress(job_id, status="cancelling", message="Cancelling...", stage="cancelling", cancel_requested=True)
    await broadcast_message({"type": "cancelling", "job_id": job_id, "file_id": job.get("file_id"), "status": "cancelling"})
    return {"job_id": job_id, "status": "cancelling", "cancel_requested": True}

@app.post("/api/quit")
async def quit_api(request: dict = None):
    if request and request.get("clear_queue"):
        # Clear all temp uploads and state
        try:
            for fid in list(uploaded_files.keys()):
                cleanup_session(fid)
            if QUEUE_STATE_FILE.exists():
                QUEUE_STATE_FILE.unlink()
        except Exception as e:
            logger.error(f"Failed to clear queue on quit: {e}")
    
    logger.warning("Shutdown requested via API.")
    os._exit(0)

app.mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))
