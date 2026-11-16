#import <AppKit/AppKit.h>

#include "PluginClipboard.h"
#include <juce_gui_extra/juce_gui_extra.h>

#include <cmath>
#include <utility>

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
        // Lives only until the next copy or until the editor closes.
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
    NSLog(@"LayerForge transfer: clipboard %@ url=%d list=%d wav=%d sound=%d", path, hasUrl, hasFileList, hasWav,
          hasSound);
    return hasUrl || hasFileList || hasWav || hasSound;
}

struct WavDragViewState
{
    layerforge::WavDataPtr wav;
    std::string key;
    layerforge::WavActionStatusCallback statusCallback;
    bool dragAttempted = false;
    juce::File dragTempFile;

    void removeDragTempFile()
    {
        if (dragTempFile != juce::File())
            dragTempFile.getParentDirectory().deleteRecursively();
        dragTempFile = juce::File();
    }
};
} // namespace

@interface LayerForgeWavDragNSView : NSView <NSDraggingSource>
{
  @public
    WavDragViewState *state;
    NSPoint mouseDownLocation;
}

- (instancetype)initWithFrame:(NSRect)frame state:(WavDragViewState *)stateIn;
@end

@implementation LayerForgeWavDragNSView

- (instancetype)initWithFrame:(NSRect)frame state:(WavDragViewState *)stateIn
{
    self = [super initWithFrame:frame];
    if (self != nil)
    {
        state = stateIn;
        self.wantsLayer = YES;
        self.layer.backgroundColor = NSColor.clearColor.CGColor;
    }
    return self;
}

- (BOOL)isOpaque
{
    return NO;
}

- (void)dealloc
{
    delete state;
#if !__has_feature(objc_arc)
    [super dealloc];
#endif
}

- (void)notifyStatus:(const char *)status error:(const char *)error
{
    if (state != nullptr && state->statusCallback)
        state->statusCallback(state->key, juce::String(status), juce::String(error));
}

- (void)mouseDown:(NSEvent *)event
{
    NSLog(@"LayerForge transfer: mouseDown");
    if (state != nullptr)
    {
        state->dragAttempted = false;
        [self notifyStatus:"dragReady" error:""];
    }
    mouseDownLocation = [self convertPoint:[event locationInWindow] fromView:nil];
}

- (void)mouseDragged:(NSEvent *)event
{
    if (state == nullptr || state->dragAttempted)
        return;

    const auto location = [self convertPoint:[event locationInWindow] fromView:nil];
    if (std::abs(location.x - mouseDownLocation.x) < 5.0 && std::abs(location.y - mouseDownLocation.y) < 5.0)
        return;

    state->dragAttempted = true;
    NSLog(@"LayerForge transfer: drag threshold reached");
    if (state->wav == nullptr || state->wav->bytes.empty())
    {
        [self notifyStatus:"dragFailed" error:"The prepared WAV is no longer available"];
        return;
    }

    if ([self window] == nil)
    {
        [self notifyStatus:"dragFailed" error:"Could not access the Ableton plug-in window for dragging"];
        return;
    }

    state->removeDragTempFile();
    auto dragFile = state->wav->savedFile;
    if (dragFile != juce::File())
    {
        if (!dragFile.existsAsFile())
        {
            [self notifyStatus:"dragFailed" error:"The saved WAV is no longer available"];
            return;
        }
    }
    else
    {
        // Unsaved audio is written to a temporary file that exists until the next drag or until the editor closes.
        const auto file = layerforge::writeTemporaryWavFile(*state->wav);
        if (file == juce::File())
        {
            [self notifyStatus:"dragFailed" error:"Could not create the temporary WAV for dragging"];
            return;
        }
        state->dragTempFile = file;
        dragFile = file;
    }
    NSString *path = [NSString stringWithUTF8String:dragFile.getFullPathName().toRawUTF8()];
    if (path == nil)
    {
        state->removeDragTempFile();
        [self notifyStatus:"dragFailed" error:"Could not convert the WAV path"];
        return;
    }
    NSDraggingItem *dragItem = [[NSDraggingItem alloc] initWithPasteboardWriter:[NSURL fileURLWithPath:path]];
    const auto windowLocation = [event locationInWindow];
    const auto dragRect = [self convertRect:NSMakeRect(windowLocation.x - 16.0, windowLocation.y - 16.0, 32.0, 32.0)
                                   fromView:nil];
    [dragItem setDraggingFrame:dragRect contents:[[NSWorkspace sharedWorkspace] iconForFileType:@"wav"]];
    NSDraggingSession *session = [self beginDraggingSessionWithItems:@[ dragItem ] event:event source:self];
#if !__has_feature(objc_arc)
    [dragItem release];
#endif

    if (session == nil)
    {
        state->removeDragTempFile();
        [self notifyStatus:"dragFailed" error:"macOS did not start the WAV drag session"];
        return;
    }

    NSLog(@"LayerForge transfer: drag session started for %@", path);
    session.animatesToStartingPositionsOnCancelOrFail = YES;
    session.draggingFormation = NSDraggingFormationNone;
    [self notifyStatus:"dragStarted" error:""];
}

- (void)mouseUp:(NSEvent *)event
{
    juce::ignoreUnused(event);
    NSLog(@"LayerForge transfer: mouseUp (dragAttempted=%d)", state != nullptr && state->dragAttempted);
    if (state == nullptr || state->dragAttempted)
        return;

    if (state->wav == nullptr || !layerforge::copyWavToClipboard(*state->wav))
    {
        [self notifyStatus:"copyFailed" error:"Could not copy the WAV; check that the saved file still exists"];
        return;
    }

    [self notifyStatus:"copied" error:""];
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context
{
    juce::ignoreUnused(session, context);
    return NSDragOperationCopy;
}

- (void)draggingSession:(NSDraggingSession *)session
           endedAtPoint:(NSPoint)screenPoint
              operation:(NSDragOperation)operation
{
    juce::ignoreUnused(session, screenPoint);
    NSLog(@"LayerForge transfer: drag ended, operation=%lu", (unsigned long)operation);
    // DAWs reference or import the file after the drop, so keep it until the next
    // drag or until the editor closes.
    const bool hadTempFile = state->dragTempFile != juce::File() && state->dragTempFile.existsAsFile();
    if (operation == NSDragOperationNone)
    {
        const auto detail = juce::String("The drop target did not accept the WAV file (operation 0, ") +
                            (hadTempFile ? "temporary file existed" : "saved file used") + ")";
        [self notifyStatus:"dropRejected" error:detail.toRawUTF8()];
    }
    else
        [self notifyStatus:"dropAccepted" error:""];
}

@end

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

void attachWavDragView(juce::NSViewComponent &component, WavActionStatusCallback statusCallback)
{
    auto *state = new WavDragViewState();
    state->statusCallback = std::move(statusCallback);
    auto *view = [[LayerForgeWavDragNSView alloc] initWithFrame:NSZeroRect state:state];
#if __has_feature(objc_arc)
    component.setView((__bridge void *)view);
#else
    component.setView(view);
    [view release];
#endif
}

void setWavDragViewTarget(void *nativeView, const std::string &key, WavDataPtr wav)
{
#if __has_feature(objc_arc)
    auto *view = (__bridge LayerForgeWavDragNSView *)nativeView;
#else
    auto *view = (LayerForgeWavDragNSView *)nativeView;
#endif
    if (view == nil || view->state == nullptr)
        return;

    if (view->state->key != key)
        view->state->dragAttempted = false;
    view->state->key = key;
    view->state->wav = std::move(wav);
}

void detachWavDragView(void *nativeView)
{
#if __has_feature(objc_arc)
    auto *view = (__bridge LayerForgeWavDragNSView *)nativeView;
#else
    auto *view = (LayerForgeWavDragNSView *)nativeView;
#endif
    if (view != nil && view->state != nullptr)
        view->state->statusCallback = {};
}
} // namespace layerforge
