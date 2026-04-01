import os
import sys
from pathlib import Path


def get_app_version() -> str:
    env_version = os.environ.get("VINYLFLOW_VERSION")
    if env_version:
        return env_version.strip()

    candidates = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / "VERSION")
    candidates.append(Path(__file__).resolve().parent / "VERSION")

    for path in candidates:
        try:
            if path.exists():
                return path.read_text(encoding="utf-8").strip()
        except Exception:
            continue

    return ""
