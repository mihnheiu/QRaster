@echo off
title QRaster Windows PyInstaller Build
echo Installing PyInstaller...
pip install pyinstaller
echo Building standalone executable...
pyinstaller --noconfirm --onedir --windowed --icon="app.ico" --add-data "app.ico;." main.py --name "QRaster"
echo Build complete. Executable located in dist\QRaster\QRaster.exe
pause
