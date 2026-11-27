"""Tests for applying and persisting processing settings via /api/config."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from fastapi.testclient import TestClient

@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("VINYLFLOW_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("HOME", str(tmp_path))
    for k in ["DEFAULT_SILENCE_THRESHOLD","DEFAULT_MIN_SILENCE_DURATION","DEFAULT_FLAC_COMPRESSION","DEFAULT_DECLICK_THRESHOLD","DEFAULT_DECLICK_BURST","DEFAULT_MIN_TRACK_LENGTH"]:
        monkeypatch.delenv(k, raising=False)
    return tmp_path

def load_api():
    for m in ["backend.api", "config"]:
        sys.modules.pop(m, None)
    import backend.api as api
    return api

FULL = {"silence_threshold": "-28", "min_silence_duration": "2.5", "min_track_length": 20,
        "flac_compression": "5", "declick_threshold": "12", "declick_burst": 6}

def test_defaults(env):
    j = TestClient(load_api().app).get("/api/config").json()
    assert (j["silence_threshold"], j["min_silence_duration"], j["min_track_length"]) == (-40, 1.5, 30)
    assert (j["flac_compression"], j["declick_threshold"], j["declick_burst"]) == (8, 6, 4)

def test_apply_and_persist(env):
    api = load_api(); c = TestClient(api.app)
    r = c.put("/api/config", json=FULL); assert r.status_code == 200
    ap = api.audio_processor
    assert (ap.silence_threshold, ap.min_silence_duration, ap.min_track_length) == (-28.0, 2.5, 20.0)
    assert (ap.flac_compression, ap.declick_threshold, ap.declick_burst) == (5, 12, 6)
    assert all(isinstance(v, int) for v in (ap.flac_compression, ap.declick_threshold, ap.declick_burst))
    saved = json.loads((env / "cfg" / "settings.json").read_text())
    assert saved["DEFAULT_FLAC_COMPRESSION"] == 5 and saved["DEFAULT_DECLICK_BURST"] == 6
    # restart: new process state
    api2 = load_api(); j = TestClient(api2.app).get("/api/config").json()
    assert (j["silence_threshold"], j["min_silence_duration"], j["min_track_length"]) == (-28, 2.5, 20)
    assert (j["flac_compression"], j["declick_threshold"], j["declick_burst"]) == (5, 12, 6)
    ap2 = api2.audio_processor
    assert (ap2.declick_threshold, ap2.declick_burst, ap2.flac_compression) == (12, 6, 5)

def test_other_settings_preserved(env):
    api = load_api(); c = TestClient(api.app)
    c.put("/api/config", json={"output_dir": str(env / "out"), "discogs_user_token": "tok"})
    c.put("/api/config", json=FULL)
    c.post("/api/config/processing-defaults", json={"formats": ["flac", "mp3_320"], "restoration_level": 2})
    saved = json.loads((env / "cfg" / "settings.json").read_text())
    assert saved["DEFAULT_OUTPUT_DIR"] == str(env / "out") and saved["DISCOGS_USER_TOKEN"] == "tok"
    assert saved["DEFAULT_RESTORATION_LEVEL"] == 2 and saved["DEFAULT_SILENCE_THRESHOLD"] == -28.0

def test_full_ui_roundtrip(env):
    # The UI PUTs back the whole GET payload; that must succeed unchanged
    c = TestClient(load_api().app)
    cfg = c.get("/api/config").json()
    r = c.put("/api/config", json=cfg); assert r.status_code == 200
    assert r.json() == cfg

@pytest.mark.parametrize("bad", [
    {"silence_threshold": "abc"}, {"silence_threshold": 3}, {"silence_threshold": ""},
    {"silence_threshold": None}, {"silence_threshold": True}, {"silence_threshold": "nan"},
    {"min_silence_duration": 0}, {"min_silence_duration": -1}, {"min_track_length": "inf"},
    {"flac_compression": 9}, {"flac_compression": -1}, {"flac_compression": 5.5},
    {"declick_threshold": 0}, {"declick_threshold": 101}, {"declick_burst": 11}, {"declick_burst": [1]},
])
def test_invalid_rejected_atomically(env, bad):
    api = load_api(); c = TestClient(api.app)
    before = c.get("/api/config").json()
    payload = {"silence_threshold": -20, "flac_compression": 3, "output_dir": "/should/not/save", **bad}
    r = c.put("/api/config", json=payload)
    assert r.status_code == 400, (bad, r.status_code, r.text)
    assert c.get("/api/config").json() == before
    assert not (env / "cfg" / "settings.json").exists()

def test_corrupt_settings_file(env):
    (env / "cfg").mkdir()
    (env / "cfg" / "settings.json").write_text(json.dumps({"DEFAULT_SILENCE_THRESHOLD": "x", "DEFAULT_FLAC_COMPRESSION": 4.5, "DEFAULT_DECLICK_BURST": "7"}))
    j = TestClient(load_api().app).get("/api/config").json()
    assert j["silence_threshold"] == -40 and j["flac_compression"] == 8 and j["declick_burst"] == 7

requires_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


@pytest.fixture(scope="module")
def wav(tmp_path_factory):
    p = tmp_path_factory.mktemp("a") / "t.wav"
    subprocess.run(["ffmpeg","-loglevel","error","-y","-f","lavfi","-i","sine=f=440:d=40","-f","lavfi","-i","anullsrc=r=44100:cl=mono:d=2",
                    "-f","lavfi","-i","sine=f=440:d=40","-filter_complex","[0][1][2]concat=n=3:v=0:a=1",str(p)], check=True)
    return p

@requires_ffmpeg
def test_settings_change_split(env, wav):
    api = load_api(); c = TestClient(api.app)
    c.put("/api/config", json={"min_silence_duration": "1.5"})
    assert len(api.audio_processor.detect_silence(wav)) == 2
    c.put("/api/config", json={"min_silence_duration": "3"})
    assert len(api.audio_processor.detect_silence(wav)) == 1
    c.put("/api/config", json={"min_silence_duration": "1.5", "min_track_length": 50})
    assert len(api.audio_processor.detect_silence(wav)) < 2

@requires_ffmpeg
def test_declick_and_flac_reach_ffmpeg(env, wav, tmp_path):
    api = load_api(); c = TestClient(api.app)
    c.put("/api/config", json={"declick_threshold": 15, "declick_burst": 7, "flac_compression": 2})
    import audio_processor as apm
    captured = []
    real_popen = apm.subprocess.Popen
    def spy(cmd, *a, **k):
        captured.append(list(cmd)); return real_popen(cmd, *a, **k)
    apm.subprocess.Popen = spy
    real_run = apm.subprocess.run
    def spy_run(cmd, *a, **k):
        captured.append(list(cmd)); return real_run(cmd, *a, **k)
    apm.subprocess.run = spy_run
    try:
        out = tmp_path / "o.flac"
        ok = api.audio_processor.extract_track(wav, apm.Track(1, 0, 10), out, "flac", restoration_level=1)
    finally:
        apm.subprocess.Popen = real_popen; apm.subprocess.run = real_run
    assert ok and out.exists() and out.stat().st_size > 0
    cmd = next(c for c in captured if str(out) in c)
    assert cmd[cmd.index("-compression_level") + 1] == "2"
    assert "adeclick=t=15:b=7" in cmd[cmd.index("-af") + 1]
