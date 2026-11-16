#!/usr/bin/env bash
set -e

echo "==> Building the production UI and macOS VST3/AU..."
npm run build

echo "==> Build complete. The installed plug-ins were not modified."
echo "Use 'npm run install:vst3' to install the VST3 for local development."
