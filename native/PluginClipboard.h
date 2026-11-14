#pragma once

#include <functional>
#include <juce_core/juce_core.h>
#include <string>

namespace juce
{
#if JUCE_MAC
class NSViewComponent;
#endif
} // namespace juce

namespace layerforge
{
using WavActionStatusCallback = std::function<void(const std::string &, const juce::String &, const juce::String &)>;

bool copyFileToClipboard(const juce::File &file);
#if JUCE_MAC
void attachWavDragView(juce::NSViewComponent &component, WavActionStatusCallback statusCallback);
void setWavDragViewTarget(void *nativeView, const std::string &key, const juce::File &file);
#endif
} // namespace layerforge
