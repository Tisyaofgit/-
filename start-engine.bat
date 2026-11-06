@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (set "TISYA_PYTHON=python") else (set "TISYA_PYTHON=py -3")
%TISYA_PYTHON% plugin_server.py --allow-origin tauri://localhost --allow-origin http://tauri.localhost --allow-origin https://tauri.localhost --allow-origin http://127.0.0.1:8000 --allow-origin http://localhost:8000 %*
pause
