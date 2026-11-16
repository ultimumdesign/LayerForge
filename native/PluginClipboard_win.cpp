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
bool copyWavToClipboard(const WavData &wav)
{
    if (wav.bytes.empty())
        return false;

    if (wav.savedFile != juce::File())
    {
        if (!wav.savedFile.existsAsFile())
            return false;
        const auto path = wav.savedFile.getFullPathName();
        const auto *widePath = path.toWideCharPointer();
        const auto length = std::wcslen(widePath);
        auto fileMemory =
            GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, sizeof(DROPFILES) + (length + 2) * sizeof(wchar_t));
        if (fileMemory == nullptr)
            return false;
        auto *dropFiles = static_cast<DROPFILES *>(GlobalLock(fileMemory));
        if (dropFiles == nullptr)
        {
            GlobalFree(fileMemory);
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
            return false;
        }
        const bool copied = EmptyClipboard() && SetClipboardData(CF_HDROP, fileMemory) != nullptr;
        CloseClipboard();
        if (!copied)
            GlobalFree(fileMemory);
        return copied;
    }

    auto memory = GlobalAlloc(GMEM_MOVEABLE, wav.bytes.size());
    if (memory == nullptr)
        return false;

    auto *data = GlobalLock(memory);
    if (data == nullptr)
    {
        GlobalFree(memory);
        return false;
    }

    std::memcpy(data, wav.bytes.data(), wav.bytes.size());
    GlobalUnlock(memory);

    if (!OpenClipboard(nullptr))
    {
        GlobalFree(memory);
        return false;
    }

    const bool copied = EmptyClipboard() && SetClipboardData(CF_WAVE, memory) != nullptr;
    CloseClipboard();
    if (!copied)
        GlobalFree(memory);
    return copied;
}
} // namespace layerforge
