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
juce::File getPresetDirectory()
{
    return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
        .getChildFile("LayerForge")
        .getChildFile("Presets");
}

struct PresetSampleData
{
    std::string originalKey;
    juce::String sourceName;
    juce::var sourceLocation;
    double sampleRate = 44100.0;
    size_t sampleCount = 0;
    size_t layerIndex = 0;
    bool rightChannel = false;
    std::vector<float> samples;
};

struct PresetFileData
{
    juce::var manifest;
    juce::var patch;
    size_t sampleDataOffset = 0;
    std::vector<PresetSampleData> samples;
};

bool readPresetManifest(const juce::File& file,
                        PresetFileData& preset,
                        juce::String& error)
{
    constexpr char presetMagic[] = { 'L', 'F', 'P', 'R', 'E', 'S', 'E', 'T' };
    constexpr int maximumManifestBytes = 16 * 1024 * 1024;
    juce::FileInputStream stream(file);
    if (!stream.openedOk()) {
        error = "Could not open the preset file";
        return false;
    }

    char magic[sizeof(presetMagic)] {};
    if (stream.read(magic, sizeof(magic)) != static_cast<int>(sizeof(magic))
        || std::memcmp(magic, presetMagic, sizeof(presetMagic)) != 0
        || stream.readInt() != 1) {
        error = "Preset format is invalid or unsupported";
        return false;
    }

    const auto manifestLength = stream.readInt();
    if (manifestLength <= 0 || manifestLength > maximumManifestBytes
        || static_cast<juce::int64>(manifestLength) > stream.getTotalLength() - stream.getPosition()) {
        error = "Preset manifest is missing or incomplete";
        return false;
    }

    std::vector<char> manifestBytes(static_cast<size_t>(manifestLength));
    if (stream.read(manifestBytes.data(), manifestLength) != manifestLength) {
        error = "Preset manifest is incomplete";
        return false;
    }

    const auto manifestText = juce::String::fromUTF8(
        manifestBytes.data(), static_cast<int>(manifestBytes.size()));
    preset.manifest = juce::JSON::parse(manifestText);
    const auto* manifestObject = preset.manifest.getDynamicObject();
    if (manifestObject == nullptr
        || manifestObject->getProperty("format").toString() != "LayerForgePreset"
        || static_cast<int>(manifestObject->getProperty("version")) != 1
        || manifestObject->getProperty("sampleEncoding").toString() != "float32le-mono") {
        error = "Preset manifest is invalid or unsupported";
        return false;
    }

    preset.patch = manifestObject->getProperty("patch");
    const auto* patchObject = preset.patch.getDynamicObject();
    const auto layerValues = patchObject != nullptr
        ? patchObject->getProperty("layers")
        : juce::var();
    const auto* layers = layerValues.getArray();
    const auto sampleValues = manifestObject->getProperty("samples");
    const auto* sampleEntries = sampleValues.getArray();
    if (layers == nullptr || sampleEntries == nullptr || layers->size() > 3) {
        error = "Preset patch or sample list is invalid";
        return false;
    }

    const auto layerCount = static_cast<size_t>(layers->size());
    std::vector<std::array<bool, 2>> matchedLayers(layerCount, { false, false });
    std::uint64_t sampleDataBytes = 0;
    preset.samples.clear();
    for (const auto& sampleValue : *sampleEntries) {
        const auto* sampleObject = sampleValue.getDynamicObject();
        const auto key = sampleObject != nullptr
            ? sampleObject->getProperty("key").toString().toStdString()
            : std::string();
        const auto sampleRate = sampleObject != nullptr
            ? static_cast<double>(sampleObject->getProperty("sampleRate"))
            : 0.0;
        const auto sampleCountValue = sampleObject != nullptr
            ? static_cast<double>(sampleObject->getProperty("sampleCount"))
            : 0.0;
        if (sampleObject == nullptr || key.empty()
            || !std::isfinite(sampleRate) || sampleRate <= 0.0 || sampleRate > 768000.0
            || !std::isfinite(sampleCountValue) || std::floor(sampleCountValue) != sampleCountValue
            || sampleCountValue <= 0.0
            || sampleCountValue > static_cast<double>(std::numeric_limits<int>::max() / sizeof(float))) {
            error = "Preset contains invalid sample metadata";
            return false;
        }

        const auto sampleCount = static_cast<size_t>(sampleCountValue);
        const auto byteCount = static_cast<std::uint64_t>(sampleCount) * sizeof(float);
        if (byteCount > std::numeric_limits<std::uint64_t>::max() - sampleDataBytes) {
            error = "Preset sample data is too large";
            return false;
        }

        size_t layerIndex = layerCount;
        bool rightChannel = false;
        for (size_t index = 0; index < layerCount; ++index) {
            const auto* layer = (*layers)[static_cast<int>(index)].getDynamicObject();
            if (layer != nullptr && static_cast<bool>(layer->getProperty("loaded"))) {
                if (layer->getProperty("sampleKey").toString().toStdString() == key) {
                    layerIndex = index;
                    break;
                }
                if (layer->getProperty("sampleRightKey").toString().toStdString() == key) {
                    layerIndex = index;
                    rightChannel = true;
                    break;
                }
            }
        }
        if (layerIndex == layerCount || matchedLayers[layerIndex][rightChannel ? 1 : 0]
            || std::any_of(preset.samples.begin(), preset.samples.end(),
                [&key](const auto& sample) { return sample.originalKey == key; })) {
            error = "Preset sample data does not match its channels";
            return false;
        }

        matchedLayers[layerIndex][rightChannel ? 1 : 0] = true;
        sampleDataBytes += byteCount;
        PresetSampleData sample;
        sample.originalKey = key;
        sample.sourceName = sampleObject->getProperty("sourceName").toString();
        sample.sourceLocation = sampleObject->getProperty("sourceLocation");
        sample.sampleRate = sampleRate;
        sample.sampleCount = sampleCount;
        sample.layerIndex = layerIndex;
        sample.rightChannel = rightChannel;
        preset.samples.push_back(std::move(sample));
    }

    for (size_t index = 0; index < layerCount; ++index) {
        const auto* layer = (*layers)[static_cast<int>(index)].getDynamicObject();
        if (layer != nullptr && static_cast<bool>(layer->getProperty("loaded"))
            && (!matchedLayers[index][0]
                || (layer->getProperty("sampleRightKey").toString().isNotEmpty() && !matchedLayers[index][1]))) {
            error = "Preset is missing embedded sample data";
            return false;
        }
        if (matchedLayers[index][1]) {
            const auto left = std::find_if(preset.samples.begin(), preset.samples.end(),
                [index](const auto& sample) { return sample.layerIndex == index && !sample.rightChannel; });
            const auto right = std::find_if(preset.samples.begin(), preset.samples.end(),
                [index](const auto& sample) { return sample.layerIndex == index && sample.rightChannel; });
            if (left == preset.samples.end() || right == preset.samples.end()
                || left->sampleCount != right->sampleCount || left->sampleRate != right->sampleRate) {
                error = "Preset stereo channels have mismatched sample data";
                return false;
            }
        }
    }

    preset.sampleDataOffset = static_cast<size_t>(stream.getPosition());
    const auto expectedFileSize = static_cast<std::uint64_t>(preset.sampleDataOffset) + sampleDataBytes;
    if (expectedFileSize != static_cast<std::uint64_t>(file.getSize())) {
        error = "Preset embedded sample data is missing or incomplete";
        return false;
    }

    return true;
}

bool readPresetAudio(const juce::File& file, PresetFileData& preset, juce::String& error)
{
    if (!readPresetManifest(file, preset, error))
        return false;

    juce::FileInputStream stream(file);
    if (!stream.openedOk() || !stream.setPosition(static_cast<juce::int64>(preset.sampleDataOffset))) {
        error = "Could not read preset sample data";
        return false;
    }

    for (auto& sample : preset.samples) {
        try {
            sample.samples.resize(sample.sampleCount);
        } catch (const std::bad_alloc&) {
            error = "Not enough memory to load preset sample audio";
            return false;
        }
        const auto byteCount = sample.samples.size() * sizeof(float);
        if (stream.read(sample.samples.data(), static_cast<int>(byteCount)) != static_cast<int>(byteCount)) {
            error = "Preset embedded sample data is incomplete";
            return false;
        }
        if (!std::all_of(sample.samples.begin(), sample.samples.end(),
                         [](float value) { return std::isfinite(value); })) {
            error = "Preset contains invalid sample audio";
            return false;
        }
    }

    if (stream.getNumBytesRemaining() != 0) {
        error = "Preset contains unexpected extra sample data";
        return false;
    }
    return true;
}

void writeNativeDiagnostic(const juce::String& message)
{
    juce::Logger::outputDebugString(message);
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

void emitPresetList(juce::WebBrowserComponent* browser,
                    const juce::String& requestId,
                    const juce::Array<juce::var>& presets,
                    const juce::String& error = {})
{
    if (browser == nullptr)
        return;

    juce::DynamicObject::Ptr details(new juce::DynamicObject());
    details->setProperty("requestId", requestId);
    details->setProperty("presets", presets);
    details->setProperty("error", error);
    browser->emitEventIfBrowserIsVisible("layerforgePresetList", details.get());
}

void emitPresetLoadFailure(juce::WebBrowserComponent* browser,
                           const juce::String& requestId,
                           const juce::String& error)
{
    if (browser == nullptr)
        return;

    juce::DynamicObject::Ptr details(new juce::DynamicObject());
    details->setProperty("requestId", requestId);
    details->setProperty("error", error);
    browser->emitEventIfBrowserIsVisible("layerforgePresetLoadFailed", details.get());
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
                             const std::string& sampleKey,
                             const std::vector<float>& samples,
                             double sampleRate)
{
    if (browser == nullptr)
        return;

    constexpr size_t chunkSize = 4096;
    const auto key = juce::String::fromUTF8(sampleKey.c_str());
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
    begin->setProperty("sampleCount", static_cast<int>(samples.size()));
    begin->setProperty("sampleRate", sampleRate);
    browser->emitEventIfBrowserIsVisible("layerforgeSampleRestore", begin.get());

    for (size_t offset = 0; offset < samples.size(); offset += chunkSize) {
        juce::Array<juce::var> values;
        const auto count = std::min(chunkSize, samples.size() - offset);
        values.ensureStorageAllocated(static_cast<int>(count));
        for (size_t i = 0; i < count; ++i)
            values.add(static_cast<double>(samples[offset + i]));
        emit("chunk", static_cast<int>(offset), values);
    }

    emit("end", static_cast<int>(samples.size()), noValues);
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
                            : extension == "svg"  ? "image/svg+xml"
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
                if (type == "openUsageGuide") {
                    if (!juce::URL("https://github.com/ultimumdesign/LayerForge#readme").launchInDefaultBrowser())
                        reportNativeDiagnostic(webView.get(), "error", "Could not open the usage guide in the browser");
                    return;
                }
                if (type == "chooseSample") {
                    chooseSample(messagePayload.getProperty("requestId", {}).toString(),
                                 static_cast<bool>(messagePayload.getProperty("locationOnly", false)));
                    return;
                }
                if (type == "revealSample") {
                    const auto path = messagePayload.getProperty("path", {}).toString();
                    juce::String error;
                    if (!juce::File::isAbsolutePath(path) || !juce::File(path).existsAsFile())
                        error = "The original sample file is unavailable at its saved location.";
                    else
                        juce::File(path).revealToUser();
                    if (error.isNotEmpty()) {
                        reportNativeDiagnostic(webView.get(), "error", error);
                        juce::DynamicObject::Ptr details(new juce::DynamicObject());
                        details->setProperty("error", error);
                        webView->emitEventIfBrowserIsVisible("layerforgeRevealSample", details.get());
                    }
                    return;
                }
                if (type == "editorHeight") {
                    const auto height = static_cast<double>(messagePayload);
                    if (!std::isfinite(height) || height <= 0.0 || height > 10000.0) {
                        reportNativeDiagnostic(webView.get(), "error", "Invalid editor height from the UI");
                        return;
                    }
                    auto maximumHeight = 1000;
                    if (const auto* display = juce::Desktop::getInstance().getDisplays().getDisplayForRect(getScreenBounds()))
                        maximumHeight = juce::jlimit(300, maximumHeight, display->userArea.getHeight() - 60);
                    const auto targetHeight = juce::jlimit(300, maximumHeight, static_cast<int>(std::ceil(height)));
                    if (targetHeight != getHeight())
                        setSize(getWidth(), targetHeight);
                    return;
                }
                if (type == "traceActive") {
                    traceEnabled = static_cast<bool>(messagePayload.getProperty("enabled", false));
                    traceGeneration = static_cast<int>(messagePayload.getProperty("generation", 0));
                    audioProcessor.setOutputTrace(traceEnabled, traceGeneration);
                    return;
                }
                if (type == "midiAudition") {
                    const auto velocity = static_cast<double>(messagePayload.getProperty("velocity", 1.0));
                    if (!std::isfinite(velocity) || velocity <= 0.0 || velocity > 1.0) {
                        reportNativeDiagnostic(webView.get(), "error", "Invalid audition velocity");
                        return;
                    }
                    audioProcessor.audition(static_cast<float>(velocity));
                    return;
                }
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
                        emitSampleRestoreEvents(
                            webView.get(), requestId, sample.key, sample.samples, sample.sampleRate);
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

                if (type == "presetList") {
                    const auto requestId =
                        messagePayload.getProperty("requestId", juce::var()).toString();
                    if (requestId.isEmpty()) {
                        reportNativeDiagnostic(webView.get(), "error", "Preset list request has no ID");
                        return;
                    }
                    listPresets(requestId);
                    return;
                }

                if (type == "presetLoad") {
                    const auto requestId =
                        messagePayload.getProperty("requestId", juce::var()).toString();
                    const auto filename =
                        messagePayload.getProperty("filename", juce::var()).toString();
                    if (requestId.isEmpty() || filename.isEmpty()) {
                        reportNativeDiagnostic(webView.get(), "error", "Preset load request is incomplete");
                        emitPresetLoadFailure(webView.get(), requestId, "Preset load request is incomplete");
                        return;
                    }
                    loadPreset(requestId, filename);
                    return;
                }

                if (type == "presetDelete") {
                    const auto filename =
                        messagePayload.getProperty("filename", juce::var()).toString();
                    if (filename.isEmpty()) {
                        reportNativeDiagnostic(webView.get(), "error", "Preset delete request has no file");
                        emitPresetStatus(webView.get(), "deleteFailed", "Preset delete request has no file");
                        return;
                    }
                    deletePreset(filename);
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

                        if (filename == ".wav") {
                            failTransfer("Invalid WAV filename");
                            return;
                        }
                        auto wav = std::make_shared<layerforge::WavData>();
                        wav->filename = filename;
                        wav->bytes = std::move(completed.bytes);
                        stagedWavs.clear();
                        stagedWavs.insert_or_assign(key, std::move(wav));
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
                    const auto staged = stagedWavs.find(key);
                    if (key.empty() || staged == stagedWavs.end()) {
                        nativeWavDragView->setVisible(false);
                        reportNativeDiagnostic(webView.get(), "error", "WAV drag target has no prepared audio");
                        return;
                    }

                    const auto x = static_cast<double>(target->getProperty("x"));
                    const auto y = static_cast<double>(target->getProperty("y"));
                    const auto width = static_cast<double>(target->getProperty("width"));
                    const auto height = static_cast<double>(target->getProperty("height"));
                    if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height)
                        || x < 0.0 || y < 0.0 || width <= 0.0 || height <= 0.0
                        || x + width > webView->getWidth() || y + height > webView->getHeight()) {
                        nativeWavDragView->setVisible(false);
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

                    const auto staged = stagedWavs.find(key);
                    if (staged == stagedWavs.end()) {
                        const juce::String error = "The prepared WAV is no longer available";
                        reportNativeDiagnostic(webView.get(), "error", error);
                        emitWavClipboardResult(webView.get(), requestId, false, error);
                        return;
                    }

                    if (!layerforge::copyWavToClipboard(*staged->second)) {
                        const juce::String error = "Could not copy the WAV; check that any saved file still exists";
                        reportNativeDiagnostic(webView.get(), "error", error);
                        emitWavClipboardResult(webView.get(), requestId, false, error);
                        return;
                    }

                    emitWavClipboardResult(webView.get(), requestId, true);
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
                    const auto result = audioProcessor.applyRenderInstructions(instructions.getArray());
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
                        if (!audioProcessor.addSampleResource(resourceName, samples)) {
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
                            if (!audioProcessor.addSampleResource(key, pending->second.samples)) {
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

#if JUCE_DEBUG
    webView->goToURL("http://localhost:5173");
#else
    // Production Release: loads bundled dist/index.html
    webView->goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
#endif

    setResizable(true, true);
    setResizeLimits(1120, 300, 1600, 1000);
    setSize(1120, 600);
    startTimer(16);
}

LayerForgeAudioProcessorEditor::~LayerForgeAudioProcessorEditor()
{
    stopTimer();
    audioProcessor.setOutputTrace(false, 0);
#if JUCE_MAC
    layerforge::detachWavDragView(nativeWavDragView->getView());
#endif
}

void LayerForgeAudioProcessorEditor::timerCallback()
{
    if (webView == nullptr || !webView->isShowing())
        return;

    const auto midiCount = audioProcessor.takeMidiTriggerCount();
    if (midiCount > 0) {
        const auto js = "window.dispatchEvent(new CustomEvent('layerforge:midi', { detail: { count: "
            + juce::String(midiCount) + " } }));";
        webView->evaluateJavascript(js);
    }

    juce::DynamicObject::Ptr meter(new juce::DynamicObject());
    meter->setProperty("min", 0.0);
    meter->setProperty("max", static_cast<double>(audioProcessor.takeOutputPeak()));
    juce::Array<juce::var> effects;
    for (size_t index = 0; index < 5; ++index)
        effects.add(static_cast<double>(audioProcessor.takeEffectPeak(index)));
    meter->setProperty("effects", juce::var(effects));
    webView->emitEventIfBrowserIsVisible("layerforgeOutputMeter", meter.get());

    if (!traceEnabled)
        return;
    std::array<LayerForgeAudioProcessor::TraceFrame, 8192> frames;
    const int count = audioProcessor.readOutputTrace(frames.data(), static_cast<int>(frames.size()));
    juce::Array<juce::var> left, right, gate, clock;
    std::array<juce::Array<juce::var>, 10> lanes;
    left.ensureStorageAllocated(count);
    right.ensureStorageAllocated(count);
    gate.ensureStorageAllocated(count);
    clock.ensureStorageAllocated(count);
    for (auto& lane : lanes)
        lane.ensureStorageAllocated(count);
    for (int index = 0; index < count; ++index) {
        const auto& frame = frames[static_cast<size_t>(index)];
        if (frame.generation != traceGeneration)
            continue;
        left.add(static_cast<double>(frame.left));
        right.add(static_cast<double>(frame.right));
        gate.add(static_cast<double>(frame.gate));
        clock.add(static_cast<double>(frame.frame));
        for (size_t lane = 0; lane < lanes.size(); ++lane)
            lanes[lane].add(static_cast<double>(frame.lanes[lane]));
    }
    if (left.isEmpty())
        return;
    juce::Array<juce::var> channels { juce::var(left), juce::var(right), juce::var(gate), juce::var(clock) };
    for (const auto& lane : lanes)
        channels.add(juce::var(lane));
    juce::DynamicObject::Ptr details(new juce::DynamicObject());
    details->setProperty("sampleRate", audioProcessor.getSampleRate());
    details->setProperty("generation", traceGeneration);
    details->setProperty("data", juce::var(channels));
    webView->emitEventIfBrowserIsVisible("layerforgeOutputTrace", details.get());
}

void LayerForgeAudioProcessorEditor::resized()
{
    if (webView)
        webView->setBounds(getLocalBounds());
}

void LayerForgeAudioProcessorEditor::chooseSample(const juce::String& requestId, bool locationOnly)
{
    const auto emit = [this, &requestId](const juce::String& action, const juce::String& error = {}) {
        juce::DynamicObject::Ptr details(new juce::DynamicObject());
        details->setProperty("requestId", requestId);
        details->setProperty("action", action);
        details->setProperty("error", error);
        webView->emitEventIfBrowserIsVisible("layerforgeSampleFile", details.get());
    };
    if (requestId.isEmpty() || fileChooserActive) {
        emit("error", "A file dialog is already open or the sample request is invalid.");
        return;
    }

    fileChooser = std::make_unique<juce::FileChooser>(
        locationOnly ? "Locate the original LayerForge sample" : "Choose a LayerForge sample",
        juce::File::getSpecialLocation(juce::File::userDocumentsDirectory), "*");
    fileChooserActive = true;
    const juce::Component::SafePointer<LayerForgeAudioProcessorEditor> safeThis(this);
    fileChooser->launchAsync(
        juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
        [safeThis, requestId, locationOnly](const juce::FileChooser& chooser) {
            if (safeThis == nullptr)
                return;
            auto& editor = *safeThis;
            editor.fileChooserActive = false;
            const auto send = [&editor, &requestId](juce::DynamicObject::Ptr details) {
                details->setProperty("requestId", requestId);
                editor.webView->emitEventIfBrowserIsVisible("layerforgeSampleFile", details.get());
            };
            const auto file = chooser.getResult();
            if (file == juce::File()) {
                juce::DynamicObject::Ptr details(new juce::DynamicObject());
                details->setProperty("action", "cancel");
                send(details);
                return;
            }
            if (locationOnly) {
                juce::DynamicObject::Ptr details(new juce::DynamicObject());
                details->setProperty("action", "location");
                details->setProperty("name", file.getFileName());
                details->setProperty("path", file.getFullPathName());
                send(details);
                return;
            }
            const auto size = file.getSize();
            juce::FileInputStream stream(file);
            if (!stream.openedOk() || size <= 0 || size > std::numeric_limits<int>::max()) {
                juce::DynamicObject::Ptr details(new juce::DynamicObject());
                details->setProperty("action", "error");
                details->setProperty("error", "Could not read the selected sample, or the file is too large.");
                send(details);
                return;
            }
            juce::DynamicObject::Ptr begin(new juce::DynamicObject());
            begin->setProperty("action", "begin");
            begin->setProperty("name", file.getFileName());
            begin->setProperty("path", file.getFullPathName());
            begin->setProperty("size", static_cast<int>(size));
            send(begin);

            std::array<unsigned char, 8192> buffer;
            juce::int64 offset = 0;
            while (offset < size) {
                const auto count = static_cast<int>(std::min<juce::int64>(buffer.size(), size - offset));
                if (stream.read(buffer.data(), count) != count) {
                    juce::DynamicObject::Ptr error(new juce::DynamicObject());
                    error->setProperty("action", "error");
                    error->setProperty("error", "Could not read the complete sample file.");
                    send(error);
                    return;
                }
                juce::Array<juce::var> bytes;
                bytes.ensureStorageAllocated(count);
                for (int i = 0; i < count; ++i)
                    bytes.add(static_cast<int>(buffer[static_cast<size_t>(i)]));
                juce::DynamicObject::Ptr chunk(new juce::DynamicObject());
                chunk->setProperty("action", "chunk");
                chunk->setProperty("offset", static_cast<int>(offset));
                chunk->setProperty("bytes", juce::var(bytes));
                send(chunk);
                offset += count;
            }
            juce::DynamicObject::Ptr end(new juce::DynamicObject());
            end->setProperty("action", "end");
            send(end);
        });
}

void LayerForgeAudioProcessorEditor::saveStagedWav(const std::string& key)
{
    const auto staged = stagedWavs.find(key);
    if (staged == stagedWavs.end()) {
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
            .getChildFile(staged->second->filename),
        "*.wav");
    fileChooserActive = true;
    const juce::Component::SafePointer<LayerForgeAudioProcessorEditor> safeThis(this);
    fileChooser->launchAsync(
        juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles,
        [safeThis, key, wav = staged->second](const juce::FileChooser& chooser) {
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
            juce::TemporaryFile temporaryFile(destination);
            if (!temporaryFile.getFile().replaceWithData(wav->bytes.data(), wav->bytes.size())
                || !temporaryFile.overwriteTargetFileWithTemporary()) {
                const juce::String error = "Could not save the exported WAV";
                reportNativeDiagnostic(editor.webView.get(), "error", error);
                emitWavActionStatus(editor.webView.get(), juce::String(key), "saveFailed", error);
                return;
            }

            wav->savedFile = destination;
            destination.revealToUser();
            emitWavActionStatus(editor.webView.get(), juce::String(key), "saved");
        });
}

void LayerForgeAudioProcessorEditor::listPresets(const juce::String& requestId)
{
    const auto directory = getPresetDirectory();
    if (!directory.exists()) {
        emitPresetList(webView.get(), requestId, {});
        return;
    }
    if (!directory.isDirectory()) {
        const juce::String error = "The LayerForge preset location is not a folder";
        emitPresetList(webView.get(), requestId, {}, error);
        reportNativeDiagnostic(webView.get(), "error", error);
        return;
    }

    auto files = directory.findChildFiles(juce::File::findFiles, false, "*.lfpreset");
    std::sort(files.begin(), files.end(), [](const juce::File& left, const juce::File& right) {
        return left.getFileNameWithoutExtension().compareIgnoreCase(
            right.getFileNameWithoutExtension()) < 0;
    });

    juce::Array<juce::var> presets;
    for (const auto& file : files) {
        PresetFileData data;
        juce::String error;
        const auto available = readPresetManifest(file, data, error);
        juce::DynamicObject::Ptr entry(new juce::DynamicObject());
        entry->setProperty("filename", file.getFileName());
        entry->setProperty("name", file.getFileNameWithoutExtension());
        entry->setProperty("available", available);
        entry->setProperty("error", available ? juce::String() : error);
        presets.add(juce::var(entry.get()));
    }
    emitPresetList(webView.get(), requestId, presets);
}

void LayerForgeAudioProcessorEditor::loadPreset(
    const juce::String& requestId,
    const juce::String& filename)
{
    const auto directory = getPresetDirectory();
    const auto file = directory.getChildFile(filename);
    if (filename.contains("/") || filename.contains("\\")
        || !filename.endsWithIgnoreCase(".lfpreset")
        || file.getParentDirectory() != directory || !file.existsAsFile()) {
        const juce::String error = "Preset file was not found in the LayerForge preset folder";
        emitPresetLoadFailure(webView.get(), requestId, error);
        return;
    }

    PresetFileData preset;
    juce::String error;
    if (!readPresetAudio(file, preset, error)) {
        reportNativeDiagnostic(webView.get(), "error", error);
        emitPresetLoadFailure(webView.get(), requestId, error);
        return;
    }

    auto* patch = preset.patch.getDynamicObject();
    const auto layersValue = patch != nullptr
        ? patch->getProperty("layers")
        : juce::var();
    auto* layers = layersValue.getArray();
    auto* runtime = audioProcessor.getRuntime();
    if (patch == nullptr || layers == nullptr || runtime == nullptr) {
        const juce::String loadError = "Audio engine is not ready to load this preset";
        emitPresetLoadFailure(webView.get(), requestId, loadError);
        return;
    }

    for (auto& sample : preset.samples) {
        auto* layer = (*layers)[static_cast<int>(sample.layerIndex)].getDynamicObject();
        if (layer == nullptr) {
            const juce::String loadError = "Preset channel data is invalid";
            emitPresetLoadFailure(webView.get(), requestId, loadError);
            return;
        }

        const auto key = "layer_" + std::to_string(sample.layerIndex) + "_preset_"
            + std::to_string(juce::Time::getCurrentTime().toMilliseconds()) + "_"
            + std::to_string(juce::Random::getSystemRandom().nextInt());
        if (!audioProcessor.addSampleResource(key, sample.samples)) {
            const juce::String loadError = "Could not register preset sample audio";
            reportNativeDiagnostic(webView.get(), "error", loadError);
            emitPresetLoadFailure(webView.get(), requestId, loadError);
            return;
        }

        sample.originalKey = key;
        layer->setProperty(sample.rightChannel ? "sampleRightKey" : "sampleKey", juce::String::fromUTF8(key.c_str()));
        if (!sample.rightChannel) {
            layer->setProperty("sampleRate", sample.sampleRate);
            layer->setProperty("sampleCount", static_cast<int>(sample.sampleCount));
        }
        if (sample.sourceName.isNotEmpty())
            layer->setProperty("sourceName", sample.sourceName);
    }

    const auto stateJson = juce::JSON::toString(preset.patch);
    if (!audioProcessor.setPatchStateJson(stateJson)) {
        const juce::String loadError = "Could not apply the preset patch configuration";
        reportNativeDiagnostic(webView.get(), "error", loadError);
        emitPresetLoadFailure(webView.get(), requestId, loadError);
        return;
    }

    for (auto& sample : preset.samples) {
        emitSampleRestoreEvents(
            webView.get(), requestId, sample.originalKey, sample.samples, sample.sampleRate);
        audioProcessor.storeSampleResource(
            sample.originalKey, std::move(sample.samples), sample.sampleRate);
    }

    emitPluginState(webView.get(), requestId, stateJson);
    emitPresetStatus(webView.get(), "loaded", {}, filename);
}

void LayerForgeAudioProcessorEditor::deletePreset(const juce::String& filename)
{
    const auto directory = getPresetDirectory();
    const auto file = directory.getChildFile(filename);
    if (filename.contains("/") || filename.contains("\\")
        || !filename.endsWithIgnoreCase(".lfpreset")
        || file.getParentDirectory() != directory || !file.existsAsFile()) {
        const juce::String error = "Preset file was not found in the LayerForge preset folder";
        reportNativeDiagnostic(webView.get(), "error", error);
        emitPresetStatus(webView.get(), "deleteFailed", error);
        return;
    }

    if (!file.deleteFile()) {
        const juce::String error = "Could not delete the preset file";
        reportNativeDiagnostic(webView.get(), "error", error);
        emitPresetStatus(webView.get(), "deleteFailed", error);
        return;
    }

    emitPresetStatus(webView.get(), "deleted", {}, filename);
}

void LayerForgeAudioProcessorEditor::exportPreset(const juce::String& payloadJson)
{
    const auto parsedPayload = juce::JSON::parse(payloadJson);
    const auto* payload = parsedPayload.getDynamicObject();
    const auto parsedState = payload != nullptr
        ? payload->getProperty("state")
        : juce::var();
    const auto stateJson = juce::JSON::toString(parsedState);
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

            for (const auto* property : { "sampleKey", "sampleRightKey" }) {
                const auto key = layer->getProperty(property).toString().toStdString();
                if (key.empty() && juce::String(property) == "sampleRightKey")
                    continue;
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
                samples.push_back(*sample);
            }
        }
    }

    const auto directory = getPresetDirectory();
    if (!directory.isDirectory() && directory.createDirectory().failed()) {
        const juce::String error = "Could not create the LayerForge preset folder";
        reportNativeDiagnostic(webView.get(), "error", error);
        emitPresetStatus(webView.get(), "failed", error);
        return;
    }

    auto presetName = payload != nullptr
        ? payload->getProperty("name").toString().trim()
        : juce::String();
    presetName = juce::File::createLegalFileName(presetName).substring(0, 100);
    if (presetName.endsWithIgnoreCase(".lfpreset"))
        presetName = presetName.dropLastCharacters(9);
    if (presetName.isEmpty())
        presetName = "LayerForge Preset";

    auto destination = directory.getChildFile(presetName + ".lfpreset");
    for (int suffix = 2; destination.existsAsFile(); ++suffix)
        destination = directory.getChildFile(presetName + " (" + juce::String(suffix) + ").lfpreset");

    writePresetFile(destination, stateJson, samples);
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
                    && (candidate->getProperty("sampleKey").toString().toStdString() == sample.key
                        || candidate->getProperty("sampleRightKey").toString().toStdString() == sample.key)) {
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

    emitPresetStatus(webView.get(), "saved", {}, destination.getFileName());
}
