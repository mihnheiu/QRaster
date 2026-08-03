#!/usr/bin/env bash
echo "Building Linux executable..."
pip3 install pyinstaller
pyinstaller --noconfirm --onedir --windowed --icon="icon.png" --add-data "icon.png:." main.py --name "QRaster"
echo "Build complete. Output binary placed in dist/QRaster/QRaster"
