#include "PluginEditor.h"
#include "BinaryData.h"
#include <elem/AudioBufferResource.h>

#include <cmath>
#include <cstring>
#include <new>

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
    webView = std::make_unique<juce::WebBrowserComponent>(
        juce::WebBrowserComponent::Options{}
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

                        const auto tempFolder = juce::File::getSpecialLocation(juce::File::tempDirectory)
                                                    .getChildFile("LayerForge");
                        if (!tempFolder.isDirectory() && tempFolder.createDirectory().failed()) {
                            failTransfer("Could not create the temporary WAV folder");
                            return;
                        }

                        const auto wavFile = tempFolder.getChildFile(
                            juce::File::createLegalFileName(juce::String(key)) + "_" + filename);
                        if (!wavFile.replaceWithData(completed.bytes.data(), completed.bytes.size())) {
                            failTransfer("Could not write the temporary WAV file");
                            return;
                        }

                        stagedWavFiles.insert_or_assign(key, wavFile);
                        emitWavReady(webView.get(), key, true);
                    } else {
                        failTransfer("Unknown WAV transfer action");
                    }
                    return;
                }

                if (type == "wavDrag") {
                    const auto* dragRequest = messagePayload.getDynamicObject();
                    if (dragRequest == nullptr) {
                        reportNativeDiagnostic(webView.get(), "error", "Invalid WAV drag request");
                        return;
                    }

                    const auto key = dragRequest->getProperty("key").toString().toStdString();
                    const auto staged = stagedWavFiles.find(key);
                    if (staged == stagedWavFiles.end() || !staged->second.existsAsFile()) {
                        reportNativeDiagnostic(webView.get(), "error", "The prepared WAV file is no longer available");
                        return;
                    }

                    juce::StringArray files;
                    files.add(staged->second.getFullPathName());
                    if (!juce::DragAndDropContainer::performExternalDragDropOfFiles(
                            files, false, webView.get())) {
                        reportNativeDiagnostic(webView.get(), "error", "Could not start the native WAV drag");
                    }
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
                        if (!std::isfinite(expectedCount)
                            || std::floor(expectedCount) != expectedCount
                            || expectedCount < 1.0
                            || expectedCount > static_cast<double>(std::vector<float>().max_size())) {
                            reportNativeDiagnostic(webView.get(), "error", "Invalid sample length");
                            return;
                        }

                        PendingSampleTransfer pending;
                        pending.expectedSampleCount = static_cast<size_t>(expectedCount);
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

    setSize(1120, 620);
}

LayerForgeAudioProcessorEditor::~LayerForgeAudioProcessorEditor()
{
    audioProcessor.onMidiNoteOn = nullptr;
    for (const auto& [key, file] : stagedWavFiles) {
        juce::ignoreUnused(key);
        file.deleteFile();
    }
}

void LayerForgeAudioProcessorEditor::resized()
{
    if (webView)
        webView->setBounds(getLocalBounds());
}
