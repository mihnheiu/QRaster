@echo off
title QRaster Windows Launcher
echo Starting QRaster Desktop App...
python main.py
if %ERRORLEVEL% NEQ 0 (
    echo Python executable not found in PATH or error occurred.
    echo Trying Windows 'py' launcher...
    py main.py
)
pause
