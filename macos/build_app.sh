#!/usr/bin/env bash
echo "Building macOS .app bundle..."
pip3 install pyinstaller
pyinstaller --noconfirm --onedir --windowed --icon="icon.png" --add-data "icon.png:." main.py --name "QRaster"
echo "Build complete. App bundle located in dist/QRaster.app"
