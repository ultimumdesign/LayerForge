#import <AppKit/AppKit.h>

#include "PluginClipboard.h"
#include <juce_gui_extra/juce_gui_extra.h>

#include <cmath>
#include <utility>

namespace
{
struct WavDragViewState
{
    juce::NSViewComponent *sourceComponent = nullptr;
    juce::File file;
    std::string key;
    layerforge::WavActionStatusCallback statusCallback;
    bool dragAttempted = false;
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
    if (!state->file.existsAsFile())
    {
        [self notifyStatus:"dragFailed" error:"The staged WAV file is no longer available"];
        return;
    }

    if (!layerforge::copyFileToClipboard(state->file))
        [self notifyStatus:"copyFailed" error:"Could not copy the WAV file to the macOS clipboard"];

    auto *sourceView =
        state->sourceComponent != nullptr ? (__bridge NSView *)state->sourceComponent->getWindowHandle() : nil;
    if (sourceView == nil)
    {
        [self notifyStatus:"dragFailed" error:"Could not access the Ableton plug-in window for dragging"];
        return;
    }

    const auto path = state->file.getFullPathName();
    NSString *pathString = [NSString stringWithUTF8String:path.toRawUTF8()];
    if (pathString == nil)
    {
        [self notifyStatus:"dragFailed" error:"Could not convert the WAV path for native dragging"];
        return;
    }

    NSURL *fileUrl = [NSURL fileURLWithPath:pathString];
    NSDraggingItem *dragItem = [[NSDraggingItem alloc] initWithPasteboardWriter:fileUrl];
    const auto windowLocation = [event locationInWindow];
    const auto dragRect =
        [sourceView convertRect:NSMakeRect(windowLocation.x - 16.0, windowLocation.y - 16.0, 32.0, 32.0) fromView:nil];
    [dragItem setDraggingFrame:dragRect contents:[[NSWorkspace sharedWorkspace] iconForFile:pathString]];
    NSDraggingSession *session = [sourceView beginDraggingSessionWithItems:@[ dragItem ] event:event source:self];
#if !__has_feature(objc_arc)
    [dragItem release];
#endif

    if (session == nil)
    {
        [self notifyStatus:"dragFailed" error:"macOS did not start the WAV drag session"];
        return;
    }

    session.animatesToStartingPositionsOnCancelOrFail = YES;
    session.draggingFormation = NSDraggingFormationNone;
    [self notifyStatus:"dragStarted" error:""];
}

- (void)mouseUp:(NSEvent *)event
{
    juce::ignoreUnused(event);
    if (state == nullptr || state->dragAttempted)
        return;

    if (!state->file.existsAsFile() || !layerforge::copyFileToClipboard(state->file))
    {
        [self notifyStatus:"copyFailed" error:"Could not copy the WAV file to the macOS clipboard"];
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
    if (operation == NSDragOperationNone)
        [self notifyStatus:"dropRejected" error:"The drop target did not accept the WAV file"];
    else
        [self notifyStatus:"dropAccepted" error:""];
}

@end

namespace layerforge
{
bool copyFileToClipboard(const juce::File &file)
{
    if (!file.existsAsFile())
        return false;

    const auto path = file.getFullPathName();
    @autoreleasepool
    {
        NSString *pathString = [NSString stringWithUTF8String:path.toRawUTF8()];
        if (pathString == nil)
            return false;

        NSURL *fileUrl = [NSURL fileURLWithPath:pathString];
        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        [pasteboard clearContents];
        const bool hasFileUrl = [pasteboard writeObjects:@[ fileUrl ]];
        const bool hasFileList = [pasteboard setPropertyList:@[ pathString ] forType:NSFilenamesPboardType];
        return hasFileUrl || hasFileList;
    }
}

void attachWavDragView(juce::NSViewComponent &component, WavActionStatusCallback statusCallback)
{
    auto *state = new WavDragViewState();
    state->sourceComponent = &component;
    state->statusCallback = std::move(statusCallback);
    auto *view = [[LayerForgeWavDragNSView alloc] initWithFrame:NSZeroRect state:state];
#if __has_feature(objc_arc)
    component.setView((__bridge void *)view);
#else
    component.setView(view);
    [view release];
#endif
}

void setWavDragViewTarget(void *nativeView, const std::string &key, const juce::File &file)
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
    view->state->file = file;
}
} // namespace layerforge
