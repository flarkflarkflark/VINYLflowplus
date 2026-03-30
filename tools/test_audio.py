import os
from pathlib import Path
from audio_processor import AudioProcessor
from config import Config

config = Config()
ap = AudioProcessor()
file_path = Path("test_24bit.flac")

print(f"Testing file: {file_path}")
is_valid, msg = ap.validate_audio_file(file_path)
print(f"Validation: {is_valid}, {msg}")

duration = ap.get_audio_duration(file_path)
print(f"Duration: {duration}")

try:
    tracks = ap.detect_silence(file_path, verbose=True)
    print(f"Tracks detected: {len(tracks)}")
except Exception as e:
    print(f"Error during detection: {e}")
