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

// Writes unsaved audio to a temporary file in its own folder; callers delete
// the parent folder as soon as the drag or clipboard transaction ends.
inline juce::File writeTemporaryWavFile(const WavData &wav)
{
    const auto directory = juce::File::getSpecialLocation(juce::File::tempDirectory)
                               .getChildFile("LayerForge-transfer-" +
                                             juce::String::toHexString(juce::Random::getSystemRandom().nextInt64()));
    const auto file = directory.getChildFile(juce::File::createLegalFileName(wav.filename));
    if (directory.createDirectory().failed() || !file.replaceWithData(wav.bytes.data(), wav.bytes.size()))
    {
        directory.deleteRecursively();
        return {};
    }
    return file;
}

bool copyWavToClipboard(const WavData &wav);
// Removes the temporary file backing the last clipboard copy, if any.
void releaseClipboardTempFile();
#if JUCE_MAC
void attachWavDragView(juce::NSViewComponent &component, WavActionStatusCallback statusCallback);
void setWavDragViewTarget(void *nativeView, const std::string &key, WavDataPtr wav);
void detachWavDragView(void *nativeView);
#endif
} // namespace layerforge
