"""
VINYLflowplus - Audio Processing Module

Handles silence detection, track splitting, and audio format conversion.
Uses FFmpeg for audio analysis and format conversion.
Supports FLAC, MP3, and AIFF output formats.
"""

import os
import re
import subprocess
import time
import threading
import sys
import shutil
import logging
from pathlib import Path
from typing import List, Tuple, Optional

# Constants for Windows subprocess management
CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

logger = logging.getLogger("VINYLflowplus")
_FFMPEG_CACHE = None


class ProcessingCancelled(Exception):
    pass


def _ffmpeg_debug_path() -> Path:
    base_dir = os.environ.get("VINYLFLOW_DATA_DIR")
    base_path = Path(base_dir) if base_dir else Path.home() / ".vinylflowplus"
    return base_path / "ffmpeg_debug.log"


def _append_ffmpeg_debug(lines: List[str]) -> None:
    try:
        log_path = _ffmpeg_debug_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8", errors="replace") as f:
            f.write("\n".join(lines) + "\n")
    except Exception:
        pass


def _is_meipass_path(path: str) -> bool:
    meipass = getattr(sys, "_MEIPASS", None)
    if not meipass:
        return False
    try:
        candidate = Path(path)
        if candidate.exists():
            try:
                candidate = candidate.resolve()
            except Exception:
                pass
        meipass_path = Path(meipass)
        try:
            return candidate == meipass_path or meipass_path in candidate.parents
        except Exception:
            return False
    except Exception:
        return False


def _bundled_ffmpeg_path() -> Optional[Path]:
    meipass = getattr(sys, "_MEIPASS", None)
    if not meipass:
        return None
    ffmpeg_dir = Path(meipass) / "ffmpeg_bin"
    candidates = ["ffmpeg.exe", "ffmpeg"] if sys.platform == "win32" else ["ffmpeg"]
    for name in candidates:
        path = ffmpeg_dir / name
        if path.exists() and path.is_file():
            return path
    root_candidate = Path(meipass) / ("ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")
    if root_candidate.exists() and root_candidate.is_file():
        return root_candidate
    return None


def _stable_ffmpeg_path() -> Path:
    base_dir = os.environ.get("VINYLFLOW_DATA_DIR")
    base_path = Path(base_dir) if base_dir else Path.home() / ".vinylflowplus"
    name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
    return base_path / "tools" / name


def _ensure_stable_ffmpeg(bundled_path: Path) -> tuple[Optional[Path], bool]:
    if sys.platform != "win32" or not bundled_path:
        return None, False
    stable_path = _stable_ffmpeg_path()
    refreshed = False
    try:
        stable_path.parent.mkdir(parents=True, exist_ok=True)
        if stable_path.exists():
            try:
                if stable_path.stat().st_size == bundled_path.stat().st_size:
                    return stable_path, False
            except Exception:
                pass
        shutil.copy2(bundled_path, stable_path)
        refreshed = True
    except Exception as exc:
        logger.warning("FFmpeg stable copy failed: %r", exc)
        _append_ffmpeg_debug([
            "--- FFmpeg Stable Copy Failure ---",
            f"Bundled Path: {bundled_path}",
            f"Stable Path: {stable_path}",
            f"Exception: {repr(exc)}",
        ])
        if stable_path.exists():
            return stable_path, False
        return None, False
    return stable_path, refreshed


def _smoke_test_ffmpeg(path: str) -> dict:
    result = {
        "ok": False,
        "stdout": "",
        "stderr": "",
        "returncode": None,
        "exception": None,
        "version": "",
    }
    try:
        res = subprocess.run(
            [path, "-version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            creationflags=CREATE_NO_WINDOW,
        )
        result["returncode"] = res.returncode
        result["stdout"] = res.stdout or ""
        result["stderr"] = res.stderr or ""
        result["ok"] = res.returncode == 0
        if result["stdout"]:
            result["version"] = result["stdout"].splitlines()[0].strip()
    except Exception as exc:
        result["exception"] = repr(exc)
    return result


def resolve_ffmpeg(force_refresh: bool = False) -> dict:
    """Resolve the best FFmpeg path with smoke test validation."""
    global _FFMPEG_CACHE
    if _FFMPEG_CACHE and not force_refresh:
        return _FFMPEG_CACHE

    configured_path = os.environ.get("VINYLFLOW_FFMPEG_PATH")
    if configured_path:
        configured_path = configured_path.strip().strip('"')
    configured_candidate = None
    bundled_candidate = None
    if configured_path:
        if _is_meipass_path(configured_path):
            bundled_candidate = Path(configured_path)
        else:
            configured_candidate = configured_path

    system_path = shutil.which("ffmpeg")
    if system_path and _is_meipass_path(system_path):
        bundled_candidate = Path(system_path)
        system_path = None

    bundled_path = _bundled_ffmpeg_path() or bundled_candidate
    stable_path = None
    copy_refreshed = False
    if bundled_path:
        stable_path, copy_refreshed = _ensure_stable_ffmpeg(bundled_path)

    candidates: List[dict] = []
    if configured_candidate:
        candidates.append({"path": configured_candidate, "source": "configured"})
    if system_path:
        candidates.append({"path": system_path, "source": "system"})
    if stable_path:
        candidates.append({"path": str(stable_path), "source": "bundled_stable"})
    if bundled_path:
        candidates.append({"path": str(bundled_path), "source": "bundled_temp"})
    if not candidates:
        candidates.append({"path": "ffmpeg", "source": "system"})

    selected = None
    selected_test = None
    last_candidate = None
    last_test = None
    for idx, candidate in enumerate(candidates):
        path = candidate["path"]
        test = _smoke_test_ffmpeg(path)
        last_candidate = candidate
        last_test = test
        exists = Path(path).exists() if path and path not in ("ffmpeg", "ffmpeg.exe") else None
        _append_ffmpeg_debug([
            "--- FFmpeg Smoke Test ---",
            f"Path: {path}",
            f"Source: {candidate['source']}",
            f"Exists: {exists}",
            f"ReturnCode: {test['returncode']}",
            f"Stdout: {test['stdout'][:1000]}",
            f"Stderr: {test['stderr'][:1000]}",
            f"Exception: {test['exception']}",
            f"Stable Copy Refreshed: {copy_refreshed if candidate['source'] == 'bundled_stable' else False}",
        ])
        if test["ok"]:
            selected = candidate
            selected_test = test
            fallback_used = idx > 0
            break
        logger.warning(
            "FFmpeg candidate failed: source=%s path=%s exists=%s returncode=%s exception=%s stderr=%s stdout=%s",
            candidate["source"],
            path,
            exists,
            test["returncode"],
            test["exception"],
            (test["stderr"] or "")[:500],
            (test["stdout"] or "")[:500],
        )

    if selected is None:
        selected = last_candidate or candidates[-1]
        selected_test = last_test or _smoke_test_ffmpeg(selected["path"])
        fallback_used = len(candidates) > 1

    selected_path = selected["path"]
    selected_source = selected["source"]
    exists = Path(selected_path).exists() if selected_path and selected_path not in ("ffmpeg", "ffmpeg.exe") else None

    if selected_source != "configured" and (
        not configured_candidate or _is_meipass_path(configured_path or "")
    ):
        def _set_env_if_unstable(key: str, value: str) -> None:
            current = os.environ.get(key)
            if not current or _is_meipass_path(current):
                os.environ[key] = value

        _set_env_if_unstable("VINYLFLOW_FFMPEG_PATH", str(selected_path))
        _set_env_if_unstable("FFMPEG_BINARY", str(selected_path))
        _set_env_if_unstable("IMAGEIO_FFMPEG_EXE", str(selected_path))

    resolution = {
        "path": selected_path,
        "source": selected_source,
        "ok": bool(selected_test["ok"]),
        "version": selected_test.get("version") or "",
        "error": selected_test.get("exception") or "",
        "returncode": selected_test.get("returncode"),
        "stdout": selected_test.get("stdout") or "",
        "stderr": selected_test.get("stderr") or "",
        "exists": exists,
        "fallback_used": fallback_used,
        "copy_refreshed": copy_refreshed,
    }
    _FFMPEG_CACHE = resolution
    return resolution


def _ffmpeg() -> str:
    """Return the ffmpeg executable to use (validated by resolve_ffmpeg)."""
    return resolve_ffmpeg().get("path") or "ffmpeg"

# Supported input formats
SUPPORTED_INPUT_EXTENSIONS = {".wav", ".aiff", ".aif", ".flac", ".mp3"}

# Output format configurations: codec flags for FFmpeg + file extension
OUTPUT_FORMATS = {
    "flac": {
        "extension": ".flac",
        "codec_args": ["-c:a", "flac", "-sample_fmt", "s16", "-ar", "44100"],
        "label": "FLAC 16-bit",
    },
    "flac24": {
        "extension": ".flac",
        "codec_args": ["-c:a", "flac", "-sample_fmt", "s32", "-ar", "44100"],
        "label": "FLAC 24-bit",
    },
    "mp3_320": {
        "extension": ".mp3",
        "codec_args": ["-c:a", "libmp3lame", "-b:a", "320k", "-ar", "44100"],
        "label": "MP3 320kbps (CBR)",
    },
    "mp3_v0": {
        "extension": ".mp3",
        "codec_args": ["-c:a", "libmp3lame", "-q:a", "0", "-ar", "44100"],
        "label": "MP3 V0 (Extreme VBR)",
    },
    "aiff": {
        "extension": ".aiff",
        "codec_args": ["-c:a", "pcm_s16be", "-ar", "44100"],
        "label": "AIFF (Lossless)",
    },
}


class Track:
    """Represents a detected or split track."""

    def __init__(self, number: int, start: float, end: float):
        """
        Initialize track.

        Args:
            number: Track number (1-indexed)
            start: Start time in seconds
            end: End time in seconds
        """
        self.number = number
        self.start = start
        self.end = end
        self.duration = end - start
        self.vinyl_number = None  # Will be set during mapping (e.g., "A1", "B2")
        self.title = None  # Will be set from Discogs

    def format_time(self, seconds: float) -> str:
        """Format seconds as MM:SS."""
        minutes = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{minutes}:{secs:02d}"

    def __repr__(self):
        duration_str = self.format_time(self.duration)
        time_range = f"{self.format_time(self.start)} - {self.format_time(self.end)}"
        vinyl = f" [{self.vinyl_number}]" if self.vinyl_number else ""
        title = f" - {self.title}" if self.title else ""
        return f"Track {self.number}{vinyl}: {time_range} ({duration_str}){title}"


class AudioProcessor:
    """Handles audio processing operations."""

    def __init__(
        self,
        silence_threshold=-40,
        min_silence_duration=1.5,
        min_track_length=30,
        flac_compression=8,
        declick_threshold=6,
        declick_burst=4,
    ):
        """
        Initialize audio processor.
        """
        self.silence_threshold = silence_threshold
        self.min_silence_duration = min_silence_duration
        self.min_track_length = min_track_length
        self.flac_compression = flac_compression
        self.declick_threshold = declick_threshold
        self.declick_burst = declick_burst
        self.last_error = ""

    def get_audio_duration(self, file_path: Path) -> Optional[float]:
        """
        Get total duration of audio file in seconds.
        """
        debug_dir = Path.home() / ".vinylflowplus"
        debug_log = debug_dir / "ffmpeg_debug.log"
        
        try:
            resolution = resolve_ffmpeg()
            ffmpeg_cmd = resolution.get("path") or "ffmpeg"
            cmd = [ffmpeg_cmd, "-i", str(file_path), "-f", "null", "-"]
            
            result = subprocess.run(
                cmd, capture_output=True, encoding="utf-8", errors="replace", timeout=30,
                creationflags=CREATE_NO_WINDOW
            )

            # Capture output for debugging
            if result.returncode != 0 or not result.stderr or "Duration" not in result.stderr:
                self.last_error = (
                    f"ExitCode {result.returncode}. Source: {resolution.get('source')}. "
                    f"Path: {ffmpeg_cmd}. Stderr: {result.stderr[:500]}"
                )
            else:
                self.last_error = ""

            # Log for Windows debugging if it fails or if we want to trace
            if sys.platform == "win32":
                try:
                    debug_dir.mkdir(parents=True, exist_ok=True)
                    with open(debug_log, "a") as f:
                        if not result.stderr or "Duration" not in result.stderr:
                            f.write(f"\n--- FFmpeg Duration Failure ---\n")
                            f.write(f"File Exists: {file_path.exists()}\n")
                            f.write(f"FFmpeg Path: {ffmpeg_cmd}\n")
                            f.write(f"FFmpeg Source: {resolution.get('source')}\n")
                            f.write(f"FFmpeg Exists: {Path(ffmpeg_cmd).exists()}\n")
                            f.write(f"Cmd: {' '.join(cmd)}\n")
                            f.write(f"ExitCode: {result.returncode}\n")
                            f.write(f"Stderr: {result.stderr[:1000]}\n")
                except: pass

            # Parse duration from ffmpeg output
            match = re.search(r"Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})", result.stderr)
            if match:
                hours, minutes, seconds = match.groups()
                return int(hours) * 3600 + int(minutes) * 60 + float(seconds)

            return None
        except Exception as e:
            if sys.platform == "win32":
                try:
                    debug_dir.mkdir(parents=True, exist_ok=True)
                    resolution = resolve_ffmpeg()
                    with open(debug_log, "a") as f: 
                        f.write(f"FFmpeg Exception: {str(e)}\n")
                        f.write(f"Attempted FFmpeg Path: {resolution.get('path')}\n")
                        f.write(f"Attempted FFmpeg Source: {resolution.get('source')}\n")
                except: pass
            return None

    def detect_silence(self, file_path: Path, verbose=False) -> List[Track]:
        """
        Detect silence in audio file and return track boundaries.

        Args:
            file_path: Path to audio file
            verbose: Print detailed output

        Returns:
            List of Track objects
        """
        if verbose:
            print(f"Detecting silence in: {file_path.name}")
            print(
                f"Threshold: {self.silence_threshold}dB, Min duration: {self.min_silence_duration}s"
            )

        # Run ffmpeg silence detection
        cmd = [
            _ffmpeg(),
            "-i",
            str(file_path),
            "-af",
            f"silencedetect=noise={self.silence_threshold}dB:duration={self.min_silence_duration}",
            "-f",
            "null",
            "-",
        ]

        try:
            result = subprocess.run(
                cmd, capture_output=True, encoding="utf-8", errors="replace", timeout=300,
                creationflags=CREATE_NO_WINDOW
            )

            # Parse silence periods from stderr
            silence_starts = []
            silence_ends = []

            for line in result.stderr.split("\n"):
                if "silence_start" in line:
                    match = re.search(r"silence_start: ([\d.]+)", line)
                    if match:
                        silence_starts.append(float(match.group(1)))
                elif "silence_end" in line:
                    match = re.search(r"silence_end: ([\d.]+)", line)
                    if match:
                        silence_ends.append(float(match.group(1)))

            # Get total duration
            total_duration = self.get_audio_duration(file_path)
            if total_duration is None:
                raise ValueError("Could not determine audio duration")

            # Calculate track boundaries
            tracks = self._calculate_tracks(silence_starts, silence_ends, total_duration)

            if verbose:
                print(f"\nDetected {len(tracks)} tracks:")
                for track in tracks:
                    print(f"  {track}")

            return tracks

        except subprocess.TimeoutExpired:
            raise RuntimeError("Silence detection timed out (>5 minutes)")
        except Exception as e:
            raise RuntimeError(f"Silence detection failed: {e}")

    def _calculate_tracks(
        self, silence_starts: List[float], silence_ends: List[float], total_duration: float
    ) -> List[Track]:
        """
        Calculate track boundaries from silence periods.

        Args:
            silence_starts: List of silence start times
            silence_ends: List of silence end times
            total_duration: Total audio duration

        Returns:
            List of Track objects
        """
        tracks = []
        track_num = 1

        # Handle case with no silence detected
        if not silence_starts:
            if total_duration >= self.min_track_length:
                tracks.append(Track(track_num, 0, total_duration))
            return tracks

        # First track
        if silence_starts[0] >= self.min_track_length:
            tracks.append(Track(track_num, 0, silence_starts[0]))
            track_num += 1

        # Middle tracks
        for i in range(len(silence_ends) - 1):
            start = silence_ends[i]
            end = silence_starts[i + 1] if i + 1 < len(silence_starts) else total_duration
            if end - start >= self.min_track_length:
                tracks.append(Track(track_num, start, end))
                track_num += 1

        # Last track
        if silence_ends:
            last_start = silence_ends[-1]
            if total_duration - last_start >= self.min_track_length:
                tracks.append(Track(track_num, last_start, total_duration))

        return tracks

    def split_tracks_duration_based(
        self, file_path: Path, durations: List[float], verbose=False
    ) -> List[Track]:
        """
        Create track splits based on provided durations (for when silence detection fails).

        Args:
            file_path: Path to audio file
            durations: List of track durations from Discogs
            verbose: Print detailed output

        Returns:
            List of Track objects
        """
        tracks = []
        current_time = 0.0
        track_num = 1

        for duration in durations:
            start = current_time
            end = current_time + duration
            tracks.append(Track(track_num, start, end))
            current_time = end
            track_num += 1

        if verbose:
            print(f"\nCreated {len(tracks)} duration-based tracks:")
            for track in tracks:
                print(f"  {track}")

        return tracks

    def _build_restoration_filters(self, restoration_level: int, hum_freq: int = 0) -> Optional[str]:
        """Build an ffmpeg -af filter chain for audio restoration.

        Args:
            restoration_level: 0=disabled, 1=enabled
            hum_freq: Optional hum notch frequency in Hz (0=off, 50=EU, 60=US)

        Returns:
            Filter chain string, or None if restoration is disabled
        """
        if restoration_level != 1:
            return None

        # highpass=f=15: removes inaudible turntable motor rumble (below 15 Hz) without touching bass
        # adeclick t=threshold (higher = less aggressive), b=burst tolerance
        filters = ["highpass=f=15", f"adeclick=t={self.declick_threshold}:b={self.declick_burst}", "loudnorm=I=-14:LRA=11:TP=-1"]
        return ", ".join(filters)

    def extract_track(
        self,
        input_file: Path,
        track: Track,
        output_file: Path,
        output_format: str = "flac",
        verbose: bool = False,
        restoration_level: int = 0,
        hum_freq: int = 50,
        cancel_event: Optional[threading.Event] = None,
    ) -> bool:
        """
        Extract a single track and convert to the specified format.

        Args:
            input_file: Source audio file
            track: Track object with start/end times
            output_file: Output file path
            output_format: One of 'flac', 'mp3', 'aiff'
            verbose: Print detailed output
            restoration_level: 0=none, 1=light clean, 2=full restore
            hum_freq: Electrical hum frequency in Hz (50 or 60) for full restore
            cancel_event: Optional event to cancel extraction mid-process

        Returns:
            True if successful
        """
        if verbose:
            print(f"Extracting {track.vinyl_number or f'Track {track.number}'}: {output_file.name}")

        format_config = OUTPUT_FORMATS.get(output_format, OUTPUT_FORMATS["flac"])

        cmd = [
            _ffmpeg(),
            "-i",
            str(input_file),
            "-ss",
            str(track.start),
            "-t",
            str(track.duration),
        ]

        # Add codec-specific args
        cmd.extend(format_config["codec_args"])

        # Clean metadata (prevent carrying over old tags that might conflict)
        cmd.extend(["-map_metadata", "-1"])

        # Add FLAC compression level if applicable
        if output_format.startswith("flac"):
            cmd.extend(["-compression_level", str(self.flac_compression)])

        # Add audio restoration filter chain if requested
        af_chain = self._build_restoration_filters(restoration_level, hum_freq)
        if af_chain:
            cmd.extend(["-af", af_chain])

        cmd.extend([
            "-y",  # Overwrite output file
            str(output_file),
        ])

        if cancel_event and cancel_event.is_set():
            raise ProcessingCancelled("Track extraction cancelled")

        try:
            if cancel_event:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    encoding="utf-8",
                    errors="replace",
                    creationflags=CREATE_NO_WINDOW,
                )
                stdout = ""
                stderr = ""
                while True:
                    if cancel_event.is_set():
                        proc.terminate()
                        try:
                            proc.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait(timeout=2)
                        raise ProcessingCancelled("Track extraction cancelled")
                    try:
                        stdout, stderr = proc.communicate(timeout=0.2)
                        break
                    except subprocess.TimeoutExpired:
                        continue
                result = subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)
            else:
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=1800,
                    creationflags=CREATE_NO_WINDOW,
                )

            if result.returncode != 0:
                print(f"Error: ffmpeg failed: {result.stderr}")
                return False

            # Verify output file exists and has reasonable size
            if not output_file.exists():
                print(f"Error: Output file not created: {output_file}")
                return False

            if output_file.stat().st_size < 1000:
                print(f"Error: Output file suspiciously small: {output_file}")
                return False

            return True

        except ProcessingCancelled:
            if output_file.exists():
                output_file.unlink()
            raise
        except subprocess.TimeoutExpired:
            print(f"Error: Track extraction timed out")
            return False
        except Exception as e:
            print(f"Error extracting track: {e}")
            return False

    def extract_all_tracks(
        self,
        input_file: Path,
        tracks: List[Track],
        output_dir: Path,
        output_format: str = "flac",
        verbose: bool = False,
        cancel_event: Optional[threading.Event] = None,
    ) -> List[Path]:
        """
        Extract all tracks from input file.

        Args:
            input_file: Source audio file
            tracks: List of Track objects
            output_dir: Directory for output files
            output_format: One of 'flac', 'mp3', 'aiff'
            verbose: Print detailed output

        Returns:
            List of successfully created output file paths
        """
        output_dir.mkdir(parents=True, exist_ok=True)
        output_files = []

        format_config = OUTPUT_FORMATS.get(output_format, OUTPUT_FORMATS["flac"])
        ext = format_config["extension"]

        for track in tracks:
            # Use vinyl number if available, otherwise track number
            track_id = track.vinyl_number if track.vinyl_number else f"{track.number:02d}"
            output_file = output_dir / f"temp_{track_id}{ext}"

            if self.extract_track(input_file, track, output_file, output_format, verbose, cancel_event=cancel_event):
                output_files.append(output_file)
            else:
                print(f"Failed to extract track {track.number}")
                # Clean up partial output
                if output_file.exists():
                    output_file.unlink()

        return output_files

    def validate_audio_file(self, file_path: Path) -> Tuple[bool, str]:
        """
        Validate that file is a valid audio file.

        Args:
            file_path: Path to file

        Returns:
            (is_valid, message)
        """
        if not file_path.exists():
            return False, f"File not found: {file_path}"

        if not file_path.is_file():
            return False, f"Not a file: {file_path}"

        if file_path.stat().st_size == 0:
            return False, f"File is empty: {file_path}"

        # Check extension
        if file_path.suffix.lower() not in SUPPORTED_INPUT_EXTENSIONS:
            return False, (
                f"Unsupported format: {file_path.suffix}. "
                f"Supported: {', '.join(SUPPORTED_INPUT_EXTENSIONS)}"
            )

        # Try to get duration (validates it's a readable audio file)
        duration = self.get_audio_duration(file_path)
        if duration is None:
            return False, f"Not a valid audio file: {file_path}"

        if duration < 60:
            return False, f"Audio file too short ({duration:.1f}s): {file_path}"

        return True, f"Valid audio file ({duration / 60:.1f} minutes)"
