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
bool copyFileToClipboard(const juce::File &file)
{
    if (!file.existsAsFile())
        return false;

    const auto path = file.getFullPathName();
    const auto *widePath = path.toWideCharPointer();
    const auto pathLength = std::wcslen(widePath);
    const auto dataSize = sizeof(DROPFILES) + (pathLength + 2) * sizeof(wchar_t);
    auto memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, dataSize);
    if (memory == nullptr)
        return false;

    auto *dropFiles = static_cast<DROPFILES *>(GlobalLock(memory));
    if (dropFiles == nullptr)
    {
        GlobalFree(memory);
        return false;
    }

    dropFiles->pFiles = sizeof(DROPFILES);
    dropFiles->fWide = TRUE;
    auto *fileList = reinterpret_cast<wchar_t *>(reinterpret_cast<std::byte *>(dropFiles) + sizeof(DROPFILES));
    std::memcpy(fileList, widePath, pathLength * sizeof(wchar_t));
    fileList[pathLength] = L'\0';
    fileList[pathLength + 1] = L'\0';
    GlobalUnlock(memory);

    if (!OpenClipboard(nullptr))
    {
        GlobalFree(memory);
        return false;
    }

    const bool copied = EmptyClipboard() && SetClipboardData(CF_HDROP, memory) != nullptr;
    CloseClipboard();
    if (!copied)
        GlobalFree(memory);
    return copied;
}
} // namespace layerforge
