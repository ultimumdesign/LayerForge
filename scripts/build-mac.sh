#!/usr/bin/env bash
set -e

echo "==> Building Production Web UI..."
npm run check
npm run build:ui

echo "==> Configuring & Building Universal macOS VST3 & AU..."
cmake -B native/build -S native -DCMAKE_BUILD_TYPE=Release
cmake --build native/build --config Release -j

echo "==> Ad-hoc code-signing local builds for Ableton Live..."
codesign --force --deep --sign - ~/Library/Audio/Plug-Ins/VST3/LayerForge.vst3 || true
codesign --force --deep --sign - ~/Library/Audio/Plug-Ins/Components/LayerForge.component || true

echo "==> Done! Open Ableton Live -> Preferences -> Plug-Ins -> Rescan."
