#!/bin/bash
# Watchdog: keep the FastAPI bridge alive
# Restarts bot_api.py if it dies
cd /home/z/my-project/scripts

while true; do
    echo "[$(date '+%H:%M:%S')] Starting bot_api.py..."
    /home/z/.venv/bin/python -u bot_api.py >> /tmp/bot_api.log 2>&1
    EXIT_CODE=$?
    echo "[$(date '+%H:%M:%S')] bot_api.py exited with code $EXIT_CODE, restarting in 3s..."
    sleep 3
done
