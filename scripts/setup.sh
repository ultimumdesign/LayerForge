#!/usr/bin/env bash
set -e

echo "==> Installing Node dependencies..."
npm install

mkdir -p native/third_party

if [ ! -d "native/third_party/JUCE" ]; then
  echo "==> Cloning JUCE 8..."
  git clone --depth 1 --branch 8.0.4 https://github.com/juce-framework/JUCE.git native/third_party/JUCE
fi

if [ ! -d "native/third_party/elementary" ]; then
  echo "==> Cloning Elementary Audio C++ Runtime..."
  git clone --depth 1 --recurse-submodules https://github.com/elemaudio/elementary.git native/third_party/elementary
fi

echo "==> Setup complete! Run 'npm run dev' for browser preview or 'npm run build' to compile VST3/AU."
