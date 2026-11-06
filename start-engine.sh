#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec python3 plugin_server.py --allow-origin tauri://localhost --allow-origin http://tauri.localhost --allow-origin https://tauri.localhost --allow-origin http://127.0.0.1:8000 --allow-origin http://localhost:8000 "$@"
