#pragma once

#include <functional>
#include <juce_core/juce_core.h>
#if JUCE_MAC
#include <juce_gui_basics/juce_gui_basics.h>
#endif
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
// the parent folder when the next transfer starts or the editor closes.
inline juce::File writeTemporaryWavFile(const WavData &wav)
{
    const auto tempRoot = juce::File::getSpecialLocation(juce::File::tempDirectory);
    // Sweep folders left behind by a crashed host.
    for (const auto &old : tempRoot.findChildFiles(juce::File::findDirectories, false, "LayerForge-transfer-*"))
        if (old.getLastModificationTime() < juce::Time::getCurrentTime() - juce::RelativeTime::hours(2))
            old.deleteRecursively();
    const auto directory = tempRoot.getChildFile(
        "LayerForge-transfer-" + juce::String::toHexString(juce::Random::getSystemRandom().nextInt64()));
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
// Starts a native file drag from the editor window using the current mouse event.
// Returns false if macOS refuses to start the drag.
bool beginWavFileDrag(juce::Component &source, const WavData &wav, std::function<void(bool)> finished);
void attachWavDragView(juce::NSViewComponent &component, WavActionStatusCallback statusCallback);
void setWavDragViewTarget(void *nativeView, const std::string &key, WavDataPtr wav);
void detachWavDragView(void *nativeView);
#endif
} // namespace layerforge
