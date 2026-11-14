#!/usr/bin/env bash
set -euo pipefail

default_destination="$HOME/Library/Audio/Plug-Ins/VST3"
if [[ ! -f native/third_party/JUCE/CMakeLists.txt || ! -f native/third_party/elementary/runtime/CMakeLists.txt ]]; then
  echo "Native dependencies are missing. Run 'npm run setup' first." >&2
  exit 1
fi

read -r -p "Install VST3 into [$default_destination]: " destination || destination=""
destination="${destination:-$default_destination}"
destination="${destination/#\~/$HOME}"
plugin_name="LayerForge.vst3"
plugin_path="$destination/$plugin_name"

echo "==> Building production UI..."
npm run check
npm run build:ui

echo "==> Configuring native plugin..."
cmake -B native/build -S native -DCMAKE_BUILD_TYPE=Release

echo "==> Building VST3..."
cmake --build native/build --config Release --target LayerForge_VST3 --parallel

build_path="$(find native/build -type d -name "$plugin_name" -print -quit)"
if [[ -z "$build_path" ]]; then
  echo "VST3 build completed, but $plugin_name was not found under native/build." >&2
  exit 1
fi

mkdir -p "$destination"
ditto "$build_path" "$plugin_path"
codesign --force --deep --sign - "$plugin_path"

echo "==> Installed $plugin_path"
echo "In Ableton Live, rescan plug-ins in Settings/Preferences > Plug-Ins."
