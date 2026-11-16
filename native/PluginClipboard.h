#pragma once

#include <functional>
#include <juce_core/juce_core.h>
#include <memory>
#include <string>
#include <vector>

namespace juce
{
#if JUCE_MAC
class NSViewComponent;
#endif
} // namespace juce

namespace layerforge
{
using WavActionStatusCallback = std::function<void(const std::string &, const juce::String &, const juce::String &)>;

struct WavData
{
    juce::String filename;
    std::vector<std::uint8_t> bytes;
    juce::File savedFile;
};

using WavDataPtr = std::shared_ptr<WavData>;

bool copyWavToClipboard(const WavData &wav);
#if JUCE_MAC
void attachWavDragView(juce::NSViewComponent &component, WavActionStatusCallback statusCallback);
void setWavDragViewTarget(void *nativeView, const std::string &key, WavDataPtr wav);
void detachWavDragView(void *nativeView);
#endif
} // namespace layerforge
