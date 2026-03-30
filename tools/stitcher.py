#!/usr/bin/env python3
import os
import subprocess
import sys
from pathlib import Path

def _ffmpeg() -> str:
    """Return the ffmpeg executable to use."""
    return os.environ.get("VINYLFLOW_FFMPEG_PATH") or "ffmpeg"

def stitch_files(input_dir, output_name="VINYLflowplus_master.wav"):
    input_path = Path(input_dir)
    files = sorted([f for f in input_path.glob("*") if f.suffix.lower() in [".wav", ".flac", ".mp3", ".aiff", ".aif"]])
    
    if not files:
        print(f"Geen audiobestanden gevonden in {input_dir}")
        return

    print(f"Gevonden bestanden: {[f.name for f in files]}")
    
    # Maak een tijdelijk stilte-bestand van 3 seconden
    silence_file = "silence_3s.wav"
    subprocess.run([
        _ffmpeg(), "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", 
        "-t", "3", silence_file
    ], capture_output=True)

    # Bouw het concat commando
    filter_complex = ""
    for i in range(len(files)):
        filter_complex += f"[{i}:a][{len(files)}:a]" # Audio + Stilte
    
    # Verwijder de laatste stilte (optioneel, maar netter)
    filter_complex += f"concat=n={len(files)*2}:v=0:a=1[outa]"
    
    cmd = [_ffmpeg(), "-y"]
    for f in files:
        cmd.extend(["-i", str(f)])
    cmd.extend(["-i", silence_file])
    cmd.extend(["-filter_complex", filter_complex, "-map", "[outa]", output_name])
    
    print("Bezig met samenvoegen...")
    subprocess.run(cmd, capture_output=True)
    os.remove(silence_file)
    print(f"Klaar! Je kunt nu '{output_name}' uploaden in VINYLflowplus.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Gebruik: python stitcher.py /pad/naar/map")
    else:
        stitch_files(sys.argv[1])
