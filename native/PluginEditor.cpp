#include "PluginEditor.h"
#include "PluginClipboard.h"
#include "BinaryData.h"
#include <elem/AudioBufferResource.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <functional>
#include <limits>
#include <new>
#include <utility>

namespace
{
juce::File getDiagnosticLogFile()
{
    return juce::FileLogger::getSystemLogFileFolder()
        .getChildFile("LayerForge")
        .getChildFile("LayerForge.log");
}

void writeNativeDiagnostic(const juce::String& message)
{
    static juce::FileLogger logger(getDiagnosticLogFile(), "LayerForge native diagnostics", 512 * 1024);
    logger.logMessage(juce::Time::getCurrentTime().toISO8601(true) + " " + message);
}

void reportNativeDiagnostic(juce::WebBrowserComponent* browser,
                            const juce::String& level,
                            const juce::String& message)
{
    writeNativeDiagnostic("[" + level + "] " + message);
    if (browser == nullptr)
        return;

    juce::DynamicObject::Ptr details(new juce::DynamicObject());
    details->setProperty("level", level);
    details->setProperty("message", message);
    browser->emitEventIfBrowserIsVisible("layerforgeNativeDiagnostic", details.get());
}

void emitWavReady(juce::WebBrowserComponent* browser,
                  const juce::String& key,
                  bool success,
                  const juce::String& error = {})
{
    if (browser == nullptr)
        return;

    juce::DynamicObject::Ptr details(new juce::DynamicObject());
    details->setProperty("key", key);
    details->setProperty("success", success);
    details->setProperty("error", error);
    browser->emitEventIfBrowserIsVisible("layerforgeWavReady", details.get());
}

void emitWavClipboardResult(juce::WebBrowserComponent* browser,
                            const juce::String& requestId,
                            bool success,
                            const juce::String& error = {})
{
    if (browser == nullptr)
        return;

    juce::DynamicObject::Ptr details(new juce::DynamicObject());
    details->setProperty("requestId", requestId);
    details->setProperty("success", success);
    details->setProperty("error", error);
    browser->emitEventIfBrowserIsVisible("layerforgeWavClipboardResult", details.get());
}

void emitWavActionStatus(juce::WebBrowserComponent* browser,
                         const juce::String& key,
                         const juce::String& status,
                         const juce::String& error = {})
{
    if (browser == nullptr)
        return;

    juce::DynamicObject::Ptr details(new juce::DynamicObject());
    details->setProperty("key", key);
    details->setProperty("status", status);
    details->setProperty("error", error);
    browser->emitEventIfBrowserIsVisible("layerforgeWavActionStatus", details.get());
}

void emitPresetStatus(juce::WebBrowserComponent* browser,
                      const juce::String& status,
                      const juce::String& error = {},
                      const juce::String& path = {})
{
    if (browser == nullptr)
        return;

    juce::DynamicObject::Ptr details(new juce::DynamicObject());
    details->setProperty("status", status);
    details->setProperty("error", error);
    details->setProperty("path", path);
    browser->emitEventIfBrowserIsVisible("layerforgePresetStatus", details.get());
}

void emitPluginState(juce::WebBrowserComponent* browser,
                     const juce::String& requestId,
                     const juce::String& stateJson)
{
    if (browser == nullptr)
        return;

    juce::DynamicObject::Ptr details(new juce::DynamicObject());
    details->setProperty("requestId", requestId);
    details->setProperty("stateJson", stateJson);
    browser->emitEventIfBrowserIsVisible("layerforgePluginState", details.get());
}

void emitSampleRestoreEvents(juce::WebBrowserComponent* browser,
                             const juce::String& requestId,
                             const LayerForgeAudioProcessor::StoredSample& sample)
{
    if (browser == nullptr)
        return;

    constexpr size_t chunkSize = 4096;
    const auto key = juce::String::fromUTF8(sample.key.c_str());
    const auto emit = [browser, &requestId, &key](const juce::String& action,
                                                   int offset,
                                                   const juce::Array<juce::var>& values) {
        juce::DynamicObject::Ptr details(new juce::DynamicObject());
        details->setProperty("requestId", requestId);
        details->setProperty("action", action);
        details->setProperty("key", key);
        details->setProperty("offset", offset);
        details->setProperty("samples", values);
        browser->emitEventIfBrowserIsVisible("layerforgeSampleRestore", details.get());
    };

    juce::Array<juce::var> noValues;
    juce::DynamicObject::Ptr begin(new juce::DynamicObject());
    begin->setProperty("requestId", requestId);
    begin->setProperty("action", "begin");
    begin->setProperty("key", key);
    begin->setProperty("sampleCount", static_cast<int>(sample.samples.size()));
    begin->setProperty("sampleRate", sample.sampleRate);
    browser->emitEventIfBrowserIsVisible("layerforgeSampleRestore", begin.get());

    for (size_t offset = 0; offset < sample.samples.size(); offset += chunkSize) {
        juce::Array<juce::var> values;
        const auto count = std::min(chunkSize, sample.samples.size() - offset);
        values.ensureStorageAllocated(static_cast<int>(count));
        for (size_t i = 0; i < count; ++i)
            values.add(static_cast<double>(sample.samples[offset + i]));
        emit("chunk", static_cast<int>(offset), values);
    }

    emit("end", static_cast<int>(sample.samples.size()), noValues);
}

void cleanupStaleWavExports(const juce::File& root)
{
    if (!root.isDirectory())
        return;

    const auto staleBefore = juce::Time::getCurrentTime() - juce::RelativeTime::days(30);
    for (const auto& file : root.findChildFiles(juce::File::findFiles, false, "*.wav"))
        if (file.getLastModificationTime() < staleBefore && !file.deleteFile())
            writeNativeDiagnostic("[warning] Could not remove stale temporary WAV: " + file.getFullPathName());

    for (const auto& folder : root.findChildFiles(juce::File::findDirectories, false, "session_*"))
        if (folder.getLastModificationTime() < staleBefore && !folder.deleteRecursively())
            writeNativeDiagnostic("[warning] Could not remove stale WAV session folder: " + folder.getFullPathName());
}

std::optional<juce::WebBrowserComponent::Resource> getUIResource(const juce::String& url)
{
    const auto path = url == "/" ? juce::String("index.html")
                                 : url.fromLastOccurrenceOf("/", false, false);

    for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
    {
        if (path != BinaryData::originalFilenames[i])
            continue;

        int dataSize = 0;
        const auto* resourceData = BinaryData::getNamedResource(BinaryData::namedResourceList[i], dataSize);
        if (resourceData == nullptr)
            return std::nullopt;

        std::vector<std::byte> data(static_cast<size_t>(dataSize));
        std::memcpy(data.data(), resourceData, data.size());

        const auto extension = path.fromLastOccurrenceOf(".", false, false).toLowerCase();
        const auto mimeType = extension == "html" ? "text/html"
                            : extension == "js"   ? "text/javascript"
                            : extension == "css"  ? "text/css"
                                                  : "application/octet-stream";

        return juce::WebBrowserComponent::Resource { std::move(data), mimeType };
    }

    writeNativeDiagnostic("[error] Embedded UI resource not found: " + url);
    return std::nullopt;
}
}

LayerForgeAudioProcessorEditor::LayerForgeAudioProcessorEditor(LayerForgeAudioProcessor& p)
    : AudioProcessorEditor(&p), audioProcessor(p)
{
    const auto tempRoot = juce::File::getSpecialLocation(juce::File::tempDirectory)
                              .getChildFile("LayerForge");
    cleanupStaleWavExports(tempRoot);
    wavTempFolder = tempRoot.getChildFile(
        "session_" + juce::File::createLegalFileName(juce::Uuid().toString()));

    auto browserOptions = juce::WebBrowserComponent::Options{};
#if JUCE_WINDOWS
    const auto webViewDataFolder =
        juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
            .getChildFile("LayerForge")
            .getChildFile("WebView2");
    browserOptions = browserOptions
        .withBackend(juce::WebBrowserComponent::Options::Backend::webview2)
        .withWinWebView2Options(
            juce::WebBrowserComponent::Options::WinWebView2{}
                .withUserDataFolder(webViewDataFolder));
#endif

    webView = std::make_unique<juce::WebBrowserComponent>(
        browserOptions
            .withNativeIntegrationEnabled()
            .withResourceProvider([](const juce::String& url) {
                return getUIResource(url);
            }, juce::URL(juce::WebBrowserComponent::getResourceProviderRoot()).getOrigin())
            .withEventListener("layerforgeDiagnostic", [](const juce::var& payload) {
                const auto message = payload.getProperty("message", payload).toString();
                writeNativeDiagnostic("[frontend] " + message);
            })
            .withEventListener("elemMessage", [this](const juce::var& payload) {
                const auto* message = payload.getDynamicObject();
                if (message == nullptr) {
                    reportNativeDiagnostic(webView.get(), "error", "Invalid renderer message");
                    return;
                }

                const auto type = message->getProperty("type").toString();
                const auto messagePayload = message->getProperty("payload");
                if (type == "pluginState") {
                    if (!audioProcessor.setPatchStateJson(messagePayload.toString()))
                        reportNativeDiagnostic(webView.get(), "error", "Invalid saved patch state from the UI");
                    return;
                }

                if (type == "getPluginState") {
                    const auto requestId =
                        messagePayload.getProperty("requestId", juce::var()).toString();
                    if (requestId.isEmpty()) {
                        reportNativeDiagnostic(webView.get(), "error", "Plugin state request has no ID");
                        return;
                    }

                    for (const auto& sample : audioProcessor.getStoredSamples())
                        emitSampleRestoreEvents(webView.get(), requestId, sample);
                    emitPluginState(webView.get(), requestId, audioProcessor.getPatchStateJson());
                    return;
                }

                if (type == "wavSaveAs") {
                    const auto key = messagePayload.getProperty("key", juce::var()).toString().toStdString();
                    saveStagedWav(key);
                    return;
                }

                if (type == "presetExport") {
                    exportPreset(messagePayload.toString());
                    return;
                }

                if (type == "wavTransfer") {
                    const auto* transfer = messagePayload.getDynamicObject();
                    if (transfer == nullptr) {
                        reportNativeDiagnostic(webView.get(), "error", "Invalid WAV transfer message");
                        return;
                    }

                    const auto action = transfer->getProperty("action").toString();
                    const auto key = transfer->getProperty("key").toString().toStdString();
                    if (key.empty()) {
                        reportNativeDiagnostic(webView.get(), "error", "WAV transfer has no key");
                        return;
                    }

                    const auto failTransfer = [this, &key](const juce::String& error) {
                        pendingWavTransfers.erase(key);
                        reportNativeDiagnostic(webView.get(), "error", error);
                        emitWavReady(webView.get(), juce::String(key), false, error);
                    };

                    if (action == "begin") {
                        const auto expectedCount = static_cast<double>(transfer->getProperty("byteCount"));
                        if (!std::isfinite(expectedCount)
                            || std::floor(expectedCount) != expectedCount
                            || expectedCount < 44.0
                            || expectedCount > static_cast<double>(std::vector<std::uint8_t>().max_size())) {
                            failTransfer("Invalid WAV size");
                            return;
                        }

                        PendingWavTransfer pending;
                        pending.expectedByteCount = static_cast<size_t>(expectedCount);
                        pending.filename = transfer->getProperty("filename").toString();
                        try {
                            pending.bytes.reserve(pending.expectedByteCount);
                        } catch (const std::bad_alloc&) {
                            failTransfer("Not enough memory to receive the WAV");
                            return;
                        }
                        pendingWavTransfers.insert_or_assign(key, std::move(pending));
                    } else if (action == "chunk") {
                        const auto pending = pendingWavTransfers.find(key);
                        const auto bytesVar = transfer->getProperty("bytes");
                        const auto* values = bytesVar.getArray();
                        const auto offset = static_cast<double>(transfer->getProperty("offset"));
                        if (pending == pendingWavTransfers.end()
                            || values == nullptr
                            || offset != static_cast<double>(pending->second.bytes.size())
                            || pending->second.bytes.size() + static_cast<size_t>(values->size())
                                > pending->second.expectedByteCount) {
                            failTransfer("Invalid WAV transfer chunk");
                            return;
                        }

                        for (const auto& value : *values) {
                            const auto byte = static_cast<double>(value);
                            if (!std::isfinite(byte) || std::floor(byte) != byte || byte < 0.0 || byte > 255.0) {
                                failTransfer("Invalid WAV byte value");
                                return;
                            }
                        }
                        for (const auto& value : *values)
                            pending->second.bytes.push_back(static_cast<std::uint8_t>(static_cast<double>(value)));
                    } else if (action == "end") {
                        const auto pending = pendingWavTransfers.find(key);
                        if (pending == pendingWavTransfers.end()
                            || pending->second.bytes.size() != pending->second.expectedByteCount) {
                            failTransfer("WAV transfer ended before completion");
                            return;
                        }

                        auto completed = std::move(pending->second);
                        pendingWavTransfers.erase(pending);
                        auto filename = juce::File::createLegalFileName(completed.filename);
                        if (!filename.endsWithIgnoreCase(".wav"))
                            filename += ".wav";

                        if (!wavTempFolder.isDirectory() && wavTempFolder.createDirectory().failed()) {
                            failTransfer("Could not create the temporary WAV folder");
                            return;
                        }

                        const auto wavFile = wavTempFolder.getChildFile(filename);
                        if (!wavFile.replaceWithData(completed.bytes.data(), completed.bytes.size())) {
                            failTransfer("Could not write the temporary WAV file");
                            return;
                        }

                        for (auto it = stagedWavFiles.begin(); it != stagedWavFiles.end();) {
                            if (it->second != wavFile && !it->second.deleteFile())
                                writeNativeDiagnostic("[warning] Could not remove replaced temporary WAV: "
                                                      + it->second.getFullPathName());
                            it = stagedWavFiles.erase(it);
                        }
                        stagedWavFiles.insert_or_assign(key, wavFile);
                        emitWavReady(webView.get(), key, true);
                    } else {
                        failTransfer("Unknown WAV transfer action");
                    }
                    return;
                }

                if (type == "wavDragTarget") {
                    const auto* target = messagePayload.getDynamicObject();
                    if (target == nullptr) {
                        reportNativeDiagnostic(webView.get(), "error", "Invalid WAV drag target");
                        return;
                    }

#if JUCE_MAC
                    if (!static_cast<bool>(target->getProperty("enabled"))) {
                        nativeWavDragView->setVisible(false);
                        return;
                    }

                    const auto key = target->getProperty("key").toString().toStdString();
                    const auto staged = stagedWavFiles.find(key);
                    if (key.empty() || staged == stagedWavFiles.end() || !staged->second.existsAsFile()) {
                        reportNativeDiagnostic(webView.get(), "error", "WAV drag target has no staged file");
                        return;
                    }

                    const auto x = static_cast<double>(target->getProperty("x"));
                    const auto y = static_cast<double>(target->getProperty("y"));
                    const auto width = static_cast<double>(target->getProperty("width"));
                    const auto height = static_cast<double>(target->getProperty("height"));
                    if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height)
                        || x < 0.0 || y < 0.0 || width <= 0.0 || height <= 0.0
                        || x + width > webView->getWidth() || y + height > webView->getHeight()) {
                        reportNativeDiagnostic(webView.get(), "error", "WAV drag target bounds are invalid");
                        return;
                    }

                    layerforge::setWavDragViewTarget(
                        nativeWavDragView->getView(), key, staged->second);
                    nativeWavDragView->setBounds(
                        webView->getX() + static_cast<int>(std::lround(x)),
                        webView->getY() + static_cast<int>(std::lround(y)),
                        static_cast<int>(std::lround(width)),
                        static_cast<int>(std::lround(height)));
                    nativeWavDragView->setVisible(true);
                    nativeWavDragView->toFront(false);
#endif
                    return;
                }

                if (type == "wavClipboard") {
                    const auto* clipboardRequest = messagePayload.getDynamicObject();
                    if (clipboardRequest == nullptr) {
                        reportNativeDiagnostic(webView.get(), "error", "Invalid WAV clipboard request");
                        return;
                    }

                    const auto requestId = clipboardRequest->getProperty("requestId").toString();
                    const auto key = clipboardRequest->getProperty("key").toString().toStdString();
                    if (requestId.isEmpty() || key.empty()) {
                        reportNativeDiagnostic(webView.get(), "error", "WAV clipboard request is missing its ID or file key");
                        emitWavClipboardResult(webView.get(), requestId, false, "Invalid clipboard request");
                        return;
                    }

                    const auto staged = stagedWavFiles.find(key);
                    if (staged == stagedWavFiles.end() || !staged->second.existsAsFile()) {
                        const juce::String error = "The prepared WAV file is no longer available";
                        reportNativeDiagnostic(webView.get(), "error", error);
                        emitWavClipboardResult(webView.get(), requestId, false, error);
                        return;
                    }

                    if (!layerforge::copyFileToClipboard(staged->second)) {
                        const juce::String error = "Could not copy the WAV file to the system clipboard";
                        reportNativeDiagnostic(webView.get(), "error", error);
                        emitWavClipboardResult(webView.get(), requestId, false, error);
                        return;
                    }

                    emitWavClipboardResult(webView.get(), requestId, true);
                    return;
                }

                if (type == "wavReveal") {
                    const auto* revealRequest = messagePayload.getDynamicObject();
                    if (revealRequest == nullptr) {
                        reportNativeDiagnostic(webView.get(), "error", "Invalid WAV reveal request");
                        return;
                    }

                    const auto key = revealRequest->getProperty("key").toString().toStdString();
                    const auto staged = stagedWavFiles.find(key);
                    if (staged == stagedWavFiles.end() || !staged->second.existsAsFile()) {
                        const juce::String error = "The prepared WAV file is no longer available";
                        reportNativeDiagnostic(webView.get(), "error", error);
                        emitWavActionStatus(webView.get(), juce::String(key), "revealFailed", error);
                        return;
                    }

                    staged->second.revealToUser();
                    emitWavActionStatus(webView.get(), juce::String(key), "revealed");
                    return;
                }

                auto* runtime = audioProcessor.getRuntime();
                if (runtime == nullptr) {
                    reportNativeDiagnostic(webView.get(), "error",
                                           "Renderer message received before audio runtime initialization");
                    return;
                }

                if (type == "renderInstructions") {
                    const auto instructions = elem::js::parseJSON(messagePayload.toString().toStdString());
                    const auto result = runtime->applyInstructions(instructions);
                    if (result != elem::ReturnCode::Ok()) {
                        const auto reason = juce::String(elem::ReturnCode::describe(result));
                        reportNativeDiagnostic(webView.get(), "error",
                                               "Elementary render instructions failed: "
                                                   + juce::String(result) + " (" + reason + ")");
                    }
                } else if (type == "updateVirtualFileSystem") {
                    const auto* resources = messagePayload.getDynamicObject();
                    if (resources == nullptr) {
                        reportNativeDiagnostic(webView.get(), "error", "Invalid sample resource message");
                        return;
                    }

                    const auto& properties = resources->getProperties();
                    for (int i = 0; i < properties.size(); ++i) {
                        const auto* values = properties.getValueAt(i).getArray();
                        if (values == nullptr || values->isEmpty()) {
                            reportNativeDiagnostic(webView.get(), "error", "Invalid sample buffer");
                            continue;
                        }

                        std::vector<float> samples;
                        samples.reserve(static_cast<size_t>(values->size()));
                        for (const auto& value : *values)
                            samples.push_back(static_cast<float>(static_cast<double>(value)));

                        const auto resourceName = properties.getName(i).toString().toStdString();
                        if (!runtime->addSharedResource(
                                resourceName,
                                std::make_unique<elem::AudioBufferResource>(samples.data(), samples.size()))) {
                            reportNativeDiagnostic(webView.get(), "error",
                                                   "Could not register sample resource: " + juce::String(resourceName));
                        }
                    }
                } else if (type == "sampleTransfer") {
                    const auto* transfer = messagePayload.getDynamicObject();
                    if (transfer == nullptr) {
                        reportNativeDiagnostic(webView.get(), "error", "Invalid sample transfer message");
                        return;
                    }

                    const auto action = transfer->getProperty("action").toString();
                    const auto key = transfer->getProperty("key").toString().toStdString();
                    if (key.empty()) {
                        reportNativeDiagnostic(webView.get(), "error", "Sample transfer has no resource key");
                        return;
                    }

                    if (action == "begin") {
                        const auto expectedCount = static_cast<double>(transfer->getProperty("sampleCount"));
                        const auto sampleRate = static_cast<double>(transfer->getProperty("sampleRate"));
                        if (!std::isfinite(expectedCount)
                            || std::floor(expectedCount) != expectedCount
                            || expectedCount < 1.0
                            || expectedCount > static_cast<double>(std::numeric_limits<int>::max())
                            || !std::isfinite(sampleRate) || sampleRate <= 0.0 || sampleRate > 768000.0) {
                            reportNativeDiagnostic(webView.get(), "error", "Invalid sample length");
                            return;
                        }

                        PendingSampleTransfer pending;
                        pending.expectedSampleCount = static_cast<size_t>(expectedCount);
                        pending.sampleRate = sampleRate;
                        try {
                            pending.samples.reserve(pending.expectedSampleCount);
                        } catch (const std::bad_alloc&) {
                            reportNativeDiagnostic(webView.get(), "error",
                                                   "Not enough memory to receive the sample");
                            return;
                        }
                        pendingSampleTransfers.insert_or_assign(key, std::move(pending));
                    } else if (action == "chunk") {
                        const auto pending = pendingSampleTransfers.find(key);
                        const auto* values = transfer->getProperty("samples").getArray();
                        const auto offset = static_cast<double>(transfer->getProperty("offset"));
                        if (pending == pendingSampleTransfers.end()
                            || values == nullptr
                            || offset != static_cast<double>(pending->second.samples.size())
                            || pending->second.samples.size() + static_cast<size_t>(values->size())
                                > pending->second.expectedSampleCount) {
                            pendingSampleTransfers.erase(key);
                            reportNativeDiagnostic(webView.get(), "error", "Invalid sample transfer chunk");
                            return;
                        }

                        for (const auto& value : *values)
                            pending->second.samples.push_back(static_cast<float>(static_cast<double>(value)));
                    } else if (action == "end") {
                        const auto pending = pendingSampleTransfers.find(key);
                        if (pending == pendingSampleTransfers.end()
                            || pending->second.samples.size() != pending->second.expectedSampleCount) {
                            pendingSampleTransfers.erase(key);
                            reportNativeDiagnostic(webView.get(), "error", "Sample transfer ended before completion");
                            return;
                        }

                        try {
                            if (!runtime->addSharedResource(
                                    key,
                                    std::make_unique<elem::AudioBufferResource>(
                                        pending->second.samples.data(), pending->second.samples.size()))) {
                                reportNativeDiagnostic(webView.get(), "error",
                                                       "Could not register sample resource: " + juce::String(key));
                            } else {
                                audioProcessor.storeSampleResource(
                                    key, std::move(pending->second.samples), pending->second.sampleRate);
                            }
                        } catch (const std::bad_alloc&) {
                            reportNativeDiagnostic(webView.get(), "error",
                                                   "Not enough memory to register sample: " + juce::String(key));
                        }
                        pendingSampleTransfers.erase(pending);
                    } else {
                        reportNativeDiagnostic(webView.get(), "error", "Unknown sample transfer action");
                    }
                }
            })
    );

    addAndMakeVisible(*webView);
#if JUCE_MAC
    nativeWavDragView = std::make_unique<juce::NSViewComponent>();
    addAndMakeVisible(*nativeWavDragView);
    layerforge::attachWavDragView(
        *nativeWavDragView,
        [this](const std::string& key, const juce::String& status, const juce::String& error) {
            if (status.startsWith("drag") || status.startsWith("drop"))
                writeNativeDiagnostic("[WAV drag] " + juce::String(key) + ": " + status
                                      + (error.isEmpty() ? juce::String() : " - " + error));
            if (!error.isEmpty())
                reportNativeDiagnostic(webView.get(), "error", error);
            emitWavActionStatus(webView.get(), juce::String(key), status, error);
        });
    nativeWavDragView->setVisible(false);
#endif

    // Forward incoming DAW MIDI Note-On triggers to the UI.
    audioProcessor.onMidiNoteOn = [this](int note, int velocity) {
        if (webView)
        {
            juce::String js = "window.dispatchEvent(new CustomEvent('layerforge:midi', { detail: { note: "
                + juce::String(note) + ", velocity: " + juce::String(velocity) + " } }));";
            webView->evaluateJavascript(js);
        }
    };

#if JUCE_DEBUG
    webView->goToURL("http://localhost:5173");
#else
    // Production Release: loads bundled dist/index.html
    webView->goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
#endif

    setResizable(true, true);
    setResizeLimits(850, 500, 1600, 1000);
    setSize(1120, 620);
}

LayerForgeAudioProcessorEditor::~LayerForgeAudioProcessorEditor()
{
    audioProcessor.onMidiNoteOn = nullptr;
    if (wavTempFolder.isDirectory() && !wavTempFolder.deleteRecursively())
        writeNativeDiagnostic("[error] Could not remove temporary WAV folder: "
                              + wavTempFolder.getFullPathName());
}

void LayerForgeAudioProcessorEditor::resized()
{
    if (webView)
        webView->setBounds(getLocalBounds());
}

void LayerForgeAudioProcessorEditor::saveStagedWav(const std::string& key)
{
    const auto staged = stagedWavFiles.find(key);
    if (staged == stagedWavFiles.end() || !staged->second.existsAsFile()) {
        const juce::String error = "The exported WAV is no longer available";
        reportNativeDiagnostic(webView.get(), "error", error);
        emitWavActionStatus(webView.get(), juce::String(key), "saveFailed", error);
        return;
    }

    if (fileChooserActive) {
        emitWavActionStatus(webView.get(), juce::String(key), "saveFailed", "A save dialog is already open");
        return;
    }

    fileChooser = std::make_unique<juce::FileChooser>(
        "Save LayerForge WAV",
        juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
            .getChildFile(staged->second.getFileName()),
        "*.wav");
    fileChooserActive = true;
    const juce::Component::SafePointer<LayerForgeAudioProcessorEditor> safeThis(this);
    fileChooser->launchAsync(
        juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles,
        [safeThis, key](const juce::FileChooser& chooser) {
            if (safeThis == nullptr)
                return;

            auto& editor = *safeThis;
            editor.fileChooserActive = false;
            auto destination = chooser.getResult();
            if (destination == juce::File()) {
                emitWavActionStatus(editor.webView.get(), juce::String(key), "saveCancelled");
                return;
            }

            if (!destination.hasFileExtension("wav"))
                destination = destination.withFileExtension("wav");
            const auto source = editor.stagedWavFiles.find(key);
            juce::TemporaryFile temporaryFile(destination);
            const auto copied = source != editor.stagedWavFiles.end()
                && source->second.copyFileTo(temporaryFile.getFile());
            if (!copied || !temporaryFile.overwriteTargetFileWithTemporary()) {
                const juce::String error = "Could not save the exported WAV";
                reportNativeDiagnostic(editor.webView.get(), "error", error);
                emitWavActionStatus(editor.webView.get(), juce::String(key), "saveFailed", error);
                return;
            }

            destination.revealToUser();
            emitWavActionStatus(editor.webView.get(), juce::String(key), "saved");
        });
}

void LayerForgeAudioProcessorEditor::exportPreset(const juce::String& stateJson)
{
    const auto parsedState = juce::JSON::parse(stateJson);
    auto* stateObject = parsedState.getDynamicObject();
    if (stateObject == nullptr) {
        const juce::String error = "Could not export an invalid patch state";
        reportNativeDiagnostic(webView.get(), "error", error);
        emitPresetStatus(webView.get(), "failed", error);
        return;
    }

    const auto layers = stateObject->getProperty("layers");
    const auto* layerArray = layers.getArray();
    auto allSamples = audioProcessor.getStoredSamples();
    std::vector<LayerForgeAudioProcessor::StoredSample> samples;
    if (layerArray != nullptr) {
        for (const auto& layerValue : *layerArray) {
            const auto* layer = layerValue.getDynamicObject();
            if (layer == nullptr || !static_cast<bool>(layer->getProperty("loaded")))
                continue;

            const auto key = layer->getProperty("sampleKey").toString().toStdString();
            const auto sample = std::find_if(
                allSamples.begin(), allSamples.end(), [&key](const auto& candidate) {
                    return candidate.key == key;
                });
            if (key.empty() || sample == allSamples.end()) {
                const juce::String error = "A loaded channel is missing its sample data; reload it before exporting";
                reportNativeDiagnostic(webView.get(), "error", error);
                emitPresetStatus(webView.get(), "failed", error);
                return;
            }
            samples.push_back(std::move(*sample));
        }
    }

    if (fileChooserActive) {
        emitPresetStatus(webView.get(), "failed", "A save dialog is already open");
        return;
    }

    fileChooser = std::make_unique<juce::FileChooser>(
        "Export LayerForge Preset",
        juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
            .getChildFile("LayerForge_Preset.lfpreset"),
        "*.lfpreset");
    fileChooserActive = true;
    const juce::Component::SafePointer<LayerForgeAudioProcessorEditor> safeThis(this);
    fileChooser->launchAsync(
        juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles,
        [safeThis, stateJson, samples = std::move(samples)](const juce::FileChooser& chooser) {
            if (safeThis == nullptr)
                return;

            auto& editor = *safeThis;
            editor.fileChooserActive = false;
            auto destination = chooser.getResult();
            if (destination == juce::File()) {
                emitPresetStatus(editor.webView.get(), "cancelled");
                return;
            }

            if (!destination.hasFileExtension("lfpreset"))
                destination = destination.withFileExtension("lfpreset");
            editor.writePresetFile(destination, stateJson, samples);
        });
}

void LayerForgeAudioProcessorEditor::writePresetFile(
    const juce::File& destination,
    const juce::String& stateJson,
    const std::vector<LayerForgeAudioProcessor::StoredSample>& samples)
{
    const auto parsedState = juce::JSON::parse(stateJson);
    auto* stateObject = parsedState.getDynamicObject();
    if (stateObject == nullptr) {
        emitPresetStatus(webView.get(), "failed", "Could not serialize the patch configuration");
        return;
    }

    juce::DynamicObject::Ptr manifest(new juce::DynamicObject());
    manifest->setProperty("format", "LayerForgePreset");
    manifest->setProperty("version", 1);
    manifest->setProperty("patch", parsedState);
    manifest->setProperty("sampleEncoding", "float32le-mono");

    juce::Array<juce::var> sampleEntries;
    const auto layerValues = stateObject->getProperty("layers");
    const auto* layers = layerValues.getArray();
    for (size_t sampleIndex = 0; sampleIndex < samples.size(); ++sampleIndex) {
        const auto& sample = samples[sampleIndex];
        const juce::DynamicObject* layer = nullptr;
        if (layers != nullptr) {
            for (const auto& layerValue : *layers) {
                const auto* candidate = layerValue.getDynamicObject();
                if (candidate != nullptr
                    && candidate->getProperty("sampleKey").toString().toStdString() == sample.key) {
                    layer = candidate;
                    break;
                }
            }
        }

        juce::DynamicObject::Ptr entry(new juce::DynamicObject());
        entry->setProperty("key", juce::String::fromUTF8(sample.key.c_str()));
        entry->setProperty(
            "embeddedLocation", "samples/sample-" + juce::String(static_cast<int>(sampleIndex)) + ".f32");
        auto sourceName = layer != nullptr ? layer->getProperty("sourceName").toString() : juce::String();
        if (sourceName.isEmpty() && layer != nullptr)
            sourceName = layer->getProperty("name").toString();
        entry->setProperty("sourceName", sourceName);
        entry->setProperty("sourceLocation", layer != nullptr
            ? layer->getProperty("sourceLocation")
            : juce::var());
        entry->setProperty("sampleRate", sample.sampleRate);
        entry->setProperty("sampleCount", static_cast<int>(sample.samples.size()));
        sampleEntries.add(juce::var(entry.get()));
    }
    manifest->setProperty("samples", sampleEntries);

    const auto manifestJson = juce::JSON::toString(juce::var(manifest.get()));
    const auto manifestBytes = manifestJson.getNumBytesAsUTF8();
    if (manifestBytes > static_cast<size_t>(std::numeric_limits<int>::max())) {
        emitPresetStatus(webView.get(), "failed", "Preset manifest is too large");
        return;
    }

    constexpr char presetMagic[] = { 'L', 'F', 'P', 'R', 'E', 'S', 'E', 'T' };
    auto expectedFileBytes = sizeof(presetMagic) + 2 * sizeof(int) + manifestBytes;
    for (const auto& sample : samples) {
        const auto sampleBytes = sample.samples.size() * sizeof(float);
        if (sampleBytes > std::numeric_limits<size_t>::max() - expectedFileBytes) {
            emitPresetStatus(webView.get(), "failed", "Preset sample data is too large");
            return;
        }
        expectedFileBytes += sampleBytes;
    }

    juce::TemporaryFile temporaryFile(destination);
    bool succeeded = false;
    {
        juce::FileOutputStream stream(temporaryFile.getFile());
        if (!stream.openedOk()) {
            const juce::String error = "Could not open the preset file for writing";
            reportNativeDiagnostic(webView.get(), "error", error);
            emitPresetStatus(webView.get(), "failed", error);
            return;
        }

        succeeded = stream.write(presetMagic, sizeof(presetMagic))
            && stream.writeInt(1)
            && stream.writeInt(static_cast<int>(manifestBytes))
            && stream.write(manifestJson.toRawUTF8(), manifestBytes);
        for (const auto& sample : samples)
            succeeded = succeeded
                && stream.write(sample.samples.data(), sample.samples.size() * sizeof(float));
        stream.flush();
    }

    succeeded = succeeded
        && temporaryFile.getFile().getSize() == static_cast<juce::int64>(expectedFileBytes);
    if (!succeeded || !temporaryFile.overwriteTargetFileWithTemporary()) {
        const juce::String error = "Could not write the complete preset file";
        reportNativeDiagnostic(webView.get(), "error", error);
        emitPresetStatus(webView.get(), "failed", error);
        return;
    }

    destination.revealToUser();
    emitPresetStatus(webView.get(), "saved", {}, destination.getFullPathName());
}
