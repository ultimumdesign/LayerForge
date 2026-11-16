#import <AppKit/AppKit.h>

#include "PluginClipboard.h"
#include <juce_gui_extra/juce_gui_extra.h>

#include <cmath>
#include <utility>

namespace
{
bool writeWavToPasteboard(NSPasteboard *pasteboard, const layerforge::WavData &wav)
{
    if (wav.bytes.empty())
        return false;

    NSData *data = [NSData dataWithBytes:wav.bytes.data() length:wav.bytes.size()];
    const bool saved = wav.savedFile != juce::File();
    NSString *path = nil;
    if (saved)
    {
        if (!wav.savedFile.existsAsFile())
            return false;
        path = [NSString stringWithUTF8String:wav.savedFile.getFullPathName().toRawUTF8()];
        if (path == nil)
            return false;
    }

    [pasteboard clearContents];
    bool hasFile = false;
    if (saved)
    {
        NSURL *url = [NSURL fileURLWithPath:path];
        const bool hasUrl = [pasteboard writeObjects:@[ url ]];
        const bool hasFileList = [pasteboard setPropertyList:@[ path ] forType:NSFilenamesPboardType];
        hasFile = hasUrl || hasFileList;
    }
    const bool hasWav = [pasteboard setData:data forType:@"com.microsoft.waveform-audio"];
    const bool hasSound = [pasteboard setData:data forType:NSPasteboardTypeSound];
    return saved ? hasFile : hasWav || hasSound;
}

struct WavDragViewState
{
    layerforge::WavDataPtr wav;
    std::string key;
    layerforge::WavActionStatusCallback statusCallback;
    bool dragAttempted = false;
};
} // namespace

@interface LayerForgeWavPromise : NSObject <NSFilePromiseProviderDelegate>
{
  @public
    layerforge::WavDataPtr wav;
}
@end

@implementation LayerForgeWavPromise

- (NSString *)filePromiseProvider:(NSFilePromiseProvider *)provider fileNameForType:(NSString *)fileType
{
    juce::ignoreUnused(provider, fileType);
    return [NSString stringWithUTF8String:wav->filename.toRawUTF8()];
}

- (void)filePromiseProvider:(NSFilePromiseProvider *)provider
          writePromiseToURL:(NSURL *)url
          completionHandler:(void (^)(NSError *))completionHandler
{
    juce::ignoreUnused(provider);
    __block NSError *writeError = nil;
    NSError *coordinationError = nil;
    NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
    [coordinator coordinateWritingItemAtURL:url
                                    options:NSFileCoordinatorWritingForReplacing
                                      error:&coordinationError
                                 byAccessor:^(NSURL *destination) {
                                   NSData *data = [NSData dataWithBytes:wav->bytes.data() length:wav->bytes.size()];
                                   if (![data writeToURL:destination options:0 error:&writeError] && writeError == nil)
                                       writeError = [NSError errorWithDomain:NSCocoaErrorDomain
                                                                        code:NSFileWriteUnknownError
                                                                    userInfo:nil];
                                 }];
    completionHandler(coordinationError != nil ? coordinationError : writeError);
#if !__has_feature(objc_arc)
    [coordinator release];
#endif
}

@end

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

    NSDraggingItem *dragItem = nil;
    LayerForgeWavPromise *delegate = nil;
    NSFilePromiseProvider *provider = nil;
    const auto savedFile = state->wav->savedFile;
    if (savedFile != juce::File())
    {
        if (!savedFile.existsAsFile())
        {
            [self notifyStatus:"dragFailed" error:"The saved WAV is no longer available"];
            return;
        }
        NSString *path = [NSString stringWithUTF8String:savedFile.getFullPathName().toRawUTF8()];
        if (path == nil)
        {
            [self notifyStatus:"dragFailed" error:"Could not convert the saved WAV path"];
            return;
        }
        dragItem = [[NSDraggingItem alloc] initWithPasteboardWriter:[NSURL fileURLWithPath:path]];
    }
    else
    {
        delegate = [[LayerForgeWavPromise alloc] init];
        delegate->wav = state->wav;
        provider = [[NSFilePromiseProvider alloc] initWithFileType:@"com.microsoft.waveform-audio" delegate:delegate];
        provider.userInfo = delegate;
        dragItem = [[NSDraggingItem alloc] initWithPasteboardWriter:provider];
    }
    const auto windowLocation = [event locationInWindow];
    const auto dragRect = [self convertRect:NSMakeRect(windowLocation.x - 16.0, windowLocation.y - 16.0, 32.0, 32.0)
                                   fromView:nil];
    [dragItem setDraggingFrame:dragRect contents:[[NSWorkspace sharedWorkspace] iconForFileType:@"wav"]];
    NSDraggingSession *session = [self beginDraggingSessionWithItems:@[ dragItem ] event:event source:self];
#if !__has_feature(objc_arc)
    [dragItem release];
    [provider release];
    [delegate release];
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
    if (operation == NSDragOperationNone)
        [self notifyStatus:"dropRejected" error:"The drop target did not accept the WAV file"];
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
