#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>

#include "PluginClipboard.h"

#include <cstddef>
#include <cstring>
#include <cwchar>
#include <shlobj.h>

namespace layerforge
{
namespace
{
juce::File clipboardTempFile;
} // namespace

void releaseClipboardTempFile()
{
    if (clipboardTempFile != juce::File())
        clipboardTempFile.getParentDirectory().deleteRecursively();
    clipboardTempFile = juce::File();
}

bool copyWavToClipboard(const WavData &wav)
{
    if (wav.bytes.empty())
        return false;

    releaseClipboardTempFile();
    auto file = wav.savedFile;
    if (file != juce::File() && !file.existsAsFile())
        return false;
    if (file == juce::File())
    {
        // Kept after the editor closes so the host can paste it.
        file = writeTemporaryWavFile(wav);
        if (file == juce::File())
            return false;
        clipboardTempFile = file;
    }

    const auto path = file.getFullPathName();
    const auto *widePath = path.toWideCharPointer();
    const auto length = std::wcslen(widePath);
    auto fileMemory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, sizeof(DROPFILES) + (length + 2) * sizeof(wchar_t));
    if (fileMemory == nullptr)
    {
        releaseClipboardTempFile();
        return false;
    }
    auto *dropFiles = static_cast<DROPFILES *>(GlobalLock(fileMemory));
    if (dropFiles == nullptr)
    {
        GlobalFree(fileMemory);
        releaseClipboardTempFile();
        return false;
    }
    dropFiles->pFiles = sizeof(DROPFILES);
    dropFiles->fWide = TRUE;
    auto *fileList = reinterpret_cast<wchar_t *>(reinterpret_cast<std::byte *>(dropFiles) + sizeof(DROPFILES));
    std::memcpy(fileList, widePath, length * sizeof(wchar_t));
    GlobalUnlock(fileMemory);
    if (!OpenClipboard(nullptr))
    {
        GlobalFree(fileMemory);
        releaseClipboardTempFile();
        return false;
    }
    const bool copied = EmptyClipboard() && SetClipboardData(CF_HDROP, fileMemory) != nullptr;
    CloseClipboard();
    if (!copied)
    {
        GlobalFree(fileMemory);
        releaseClipboardTempFile();
    }
    return copied;
}
} // namespace layerforge
