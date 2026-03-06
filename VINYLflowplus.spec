# -*- mode: python ; coding: utf-8 -*-

import shutil
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files


WINDOWS_ICON = 'assets/VINYLflowplus.ico' if sys.platform.startswith('win') else None
FFMPEG_PATH = shutil.which('ffmpeg')

if not FFMPEG_PATH:
    raise RuntimeError('ffmpeg was not found on PATH. Install ffmpeg before building.')

# certifi CA bundle — needed so requests/discogs_client can verify HTTPS certs.
# Without this, every SSL connection from the packaged app fails with
# CERTIFICATE_VERIFY_FAILED on Windows (and sometimes macOS).
certifi_datas = collect_data_files('certifi')

DATA_FILES = [
    ('backend/static', 'backend/static'),
    *certifi_datas,
]

HIDDEN_IMPORTS = [
    'backend.api',
    'webview',
]

if os.environ.get('SKIP_GUI', 'False').lower() != 'true':
    HIDDEN_IMPORTS += [
        'PyQt5',
        'PyQt5.QtWebEngineWidgets',
    ]

# No modules are excluded — previous exclusion of pythonnet/clr/clr_loader
# was the root cause of the edgechromium backend failing silently and the
# app always falling back to the browser.
EXCLUDES = []

if sys.platform.startswith('win'):
    # edgechromium (WebView2) backend needs clr / pythonnet at runtime.
    HIDDEN_IMPORTS += [
        'webview.platforms.edgechromium',
        'clr',
        'clr_loader',
    ]
    # Bundle Python.Runtime.dll so clr_loader can find it inside the bundle.
    # The runtime hook (rthooks/rthook_vinylflowplus.py) then sets
    # PYTHONNET_RUNTIME_DLL to this path before any imports happen.
    try:
        pythonnet_datas = collect_data_files('pythonnet')
    except Exception:
        pythonnet_datas = []
    DATA_FILES += pythonnet_datas

elif sys.platform == 'darwin':
    HIDDEN_IMPORTS.append('webview.platforms.cocoa')


import os

ONEFILE = os.environ.get('PYINSTALLER_ONEFILE', 'False').lower() == 'true'

a = Analysis(
    ['desktop_launcher.py'],
    pathex=[],
    binaries=[(FFMPEG_PATH, 'ffmpeg_bin')],
    datas=DATA_FILES,
    hiddenimports=HIDDEN_IMPORTS,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=['rthooks/rthook_vinylflowplus.py'],
    excludes=EXCLUDES,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

if ONEFILE:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name='VINYLflowplus',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        upx_exclude=['Python.Runtime.dll', 'ffmpeg.exe'],
        runtime_tmpdir=None,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon=WINDOWS_ICON,
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name='VINYLflowplus',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon=WINDOWS_ICON,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=True,
        upx_exclude=['Python.Runtime.dll', 'ffmpeg.exe'],
        name='VINYLflowplus',
    )

app = BUNDLE(
    exe if ONEFILE else coll,
    name='VINYLflowplus.app',
    icon='assets/VINYLflowplus.icns',
    bundle_identifier=None,
)
