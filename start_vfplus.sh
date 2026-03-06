#!/bin/bash
# VINYLflowplus Start Wrapper
# 1. Kill alle oude launcher processen
pkill -f desktop_launcher.py
# 2. Wacht heel even tot de poort en het venster echt vrij zijn
sleep 0.5
# 3. Start de nieuwe instance
/home/flark/.gemini/tmp/vinylflow/venv/bin/python /mnt/PRODUCTION/GIT/VINYLflow/desktop_launcher.py
