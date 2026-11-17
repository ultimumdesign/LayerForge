#import <AppKit/AppKit.h>

#include "PluginClipboard.h"

namespace
{
juce::File clipboardTempFile;

void removeClipboardTempFile()
{
    if (clipboardTempFile != juce::File())
        clipboardTempFile.getParentDirectory().deleteRecursively();
    clipboardTempFile = juce::File();
}

bool writeWavToPasteboard(NSPasteboard *pasteboard, const layerforge::WavData &wav)
{
    if (wav.bytes.empty())
        return false;

    NSData *data = [NSData dataWithBytes:wav.bytes.data() length:wav.bytes.size()];
    removeClipboardTempFile();
    auto file = wav.savedFile;
    if (file != juce::File() && !file.existsAsFile())
        return false;
    if (file == juce::File())
    {
        // Kept after the editor closes so the host can paste it.
        file = layerforge::writeTemporaryWavFile(wav);
        if (file == juce::File())
            return false;
        clipboardTempFile = file;
    }
    NSString *path = [NSString stringWithUTF8String:file.getFullPathName().toRawUTF8()];
    if (path == nil)
    {
        removeClipboardTempFile();
        return false;
    }

    [pasteboard clearContents];
    NSURL *url = [NSURL fileURLWithPath:path];
    const bool hasUrl = [pasteboard writeObjects:@[ url ]];
    const bool hasFileList = [pasteboard setPropertyList:@[ path ] forType:NSFilenamesPboardType];
    const bool hasWav = [pasteboard setData:data forType:@"com.microsoft.waveform-audio"];
    const bool hasSound = [pasteboard setData:data forType:NSPasteboardTypeSound];
    return hasUrl || hasFileList || hasWav || hasSound;
}
} // namespace

namespace layerforge
{
bool copyWavToClipboard(const WavData &wav)
{
    @autoreleasepool
    {
        return writeWavToPasteboard([NSPasteboard generalPasteboard], wav);
    }
}

void releaseClipboardTempFile()
{
    removeClipboardTempFile();
}
} // namespace layerforge
