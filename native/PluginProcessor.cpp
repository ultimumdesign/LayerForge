#include "PluginProcessor.h"
#include "PluginEditor.h"
#include <elem/AudioBufferResource.h>

#include <cmath>
#include <limits>

namespace
{
constexpr int patchStateMagic = 0x4c464753;
constexpr int patchStateVersion = 1;
constexpr int maximumStoredSamples = 3;
}

LayerForgeAudioProcessor::LayerForgeAudioProcessor()
    : AudioProcessor(BusesProperties()
          .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

LayerForgeAudioProcessor::~LayerForgeAudioProcessor() = default;

void LayerForgeAudioProcessor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    runtime = std::make_unique<elem::Runtime<float>>(sampleRate, samplesPerBlock);
    auto samples = getStoredSamples();
    for (auto& sample : samples) {
        if (!runtime->addSharedResource(
                sample.key,
                std::make_unique<elem::AudioBufferResource>(sample.samples.data(), sample.samples.size())))
            DBG("[LayerForge] Could not restore sample resource: " + juce::String(sample.key));
    }
    scratchBuffer.setSize(2, samplesPerBlock);
}

void LayerForgeAudioProcessor::releaseResources()
{
}

void LayerForgeAudioProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages)
{
    juce::ScopedNoDenormals noDenormals;
    buffer.clear();

    // Forward incoming Ableton MIDI Note-On events to the Elementary UI/DSP bridge
    for (const auto metadata : midiMessages)
    {
        const auto msg = metadata.getMessage();
        if (msg.isNoteOn() && onMidiNoteOn)
        {
            const int note = msg.getNoteNumber();
            const int vel = msg.getVelocity();
            juce::MessageManager::callAsync([this, note, vel]() {
                if (onMidiNoteOn)
                    onMidiNoteOn(note, vel);
            });
        }
    }

    if (runtime)
    {
        const int numSamples = buffer.getNumSamples();
        auto* outL = buffer.getWritePointer(0);
        auto* outR = buffer.getNumChannels() > 1 ? buffer.getWritePointer(1) : outL;
        float* outputs[2] = { outL, outR };

        runtime->process(nullptr, 0, outputs, 2, numSamples, nullptr);
    }
}

juce::AudioProcessorEditor* LayerForgeAudioProcessor::createEditor()
{
    return new LayerForgeAudioProcessorEditor(*this);
}

void LayerForgeAudioProcessor::getStateInformation(juce::MemoryBlock& destData)
{
    juce::String stateJson;
    std::vector<StoredSample> samples;
    {
        const juce::ScopedLock lock(patchStateLock);
        stateJson = patchStateJson;
        samples.reserve(storedSamples.size());
        for (const auto& [key, sample] : storedSamples)
            samples.push_back({ key, sample.samples, sample.sampleRate });
    }

    juce::MemoryOutputStream output(destData, false);
    output.writeInt(patchStateMagic);
    output.writeInt(patchStateVersion);
    output.writeString(stateJson);
    output.writeInt(static_cast<int>(samples.size()));
    for (const auto& sample : samples) {
        output.writeString(juce::String::fromUTF8(sample.key.c_str()));
        output.writeDouble(sample.sampleRate);
        output.writeInt(static_cast<int>(sample.samples.size()));
        output.write(sample.samples.data(), sample.samples.size() * sizeof(float));
    }
}

void LayerForgeAudioProcessor::setStateInformation(const void* data, int sizeInBytes)
{
    if (data == nullptr || sizeInBytes < 12)
        return;

    juce::MemoryInputStream input(data, static_cast<size_t>(sizeInBytes), false);
    if (input.readInt() != patchStateMagic || input.readInt() != patchStateVersion)
        return;

    const auto loadedState = input.readString();
    if (!juce::JSON::parse(loadedState).isObject())
        return;

    const auto sampleCount = input.readInt();
    if (sampleCount < 0 || sampleCount > maximumStoredSamples)
        return;

    std::unordered_map<std::string, StoredSample> loadedSamples;
    for (int i = 0; i < sampleCount; ++i) {
        const auto key = input.readString().toStdString();
        const auto sampleRate = input.readDouble();
        const auto count = input.readInt();
        if (key.empty() || !std::isfinite(sampleRate) || sampleRate <= 0.0 || sampleRate > 768000.0
            || count <= 0
            || static_cast<size_t>(count) > input.getNumBytesRemaining() / sizeof(float)
            || loadedSamples.find(key) != loadedSamples.end())
            return;

        std::vector<float> values(static_cast<size_t>(count));
        if (input.read(values.data(), values.size() * sizeof(float)) != values.size() * sizeof(float))
            return;
        for (const auto value : values)
            if (!std::isfinite(value))
                return;
        loadedSamples.emplace(key, StoredSample { key, std::move(values), sampleRate });
    }

    if (input.getNumBytesRemaining() != 0)
        return;

    {
        const juce::ScopedLock lock(patchStateLock);
        patchStateJson = loadedState;
        storedSamples = std::move(loadedSamples);
    }

    if (runtime != nullptr) {
        auto samples = getStoredSamples();
        for (auto& sample : samples) {
            if (!runtime->addSharedResource(
                    sample.key,
                    std::make_unique<elem::AudioBufferResource>(sample.samples.data(), sample.samples.size())))
                DBG("[LayerForge] Could not restore sample resource: " + juce::String(sample.key));
        }
    }
}

bool LayerForgeAudioProcessor::setPatchStateJson(const juce::String& json)
{
    if (!juce::JSON::parse(json).isObject())
        return false;

    const juce::ScopedLock lock(patchStateLock);
    patchStateJson = json;
    return true;
}

juce::String LayerForgeAudioProcessor::getPatchStateJson() const
{
    const juce::ScopedLock lock(patchStateLock);
    return patchStateJson;
}

void LayerForgeAudioProcessor::storeSampleResource(std::string key,
                                                   std::vector<float> samples,
                                                   double sampleRate)
{
    if (key.empty() || samples.empty() || !std::isfinite(sampleRate) || sampleRate <= 0.0
        || sampleRate > 768000.0
        || samples.size() > static_cast<size_t>(std::numeric_limits<int>::max()))
        return;

    const auto firstSeparator = key.find('_');
    const auto secondSeparator = firstSeparator == std::string::npos
        ? std::string::npos
        : key.find('_', firstSeparator + 1);
    const auto layerPrefix = secondSeparator == std::string::npos
        ? std::string()
        : key.substr(0, secondSeparator + 1);

    const juce::ScopedLock lock(patchStateLock);
    if (!layerPrefix.empty()) {
        for (auto it = storedSamples.begin(); it != storedSamples.end();) {
            if (it->first.compare(0, layerPrefix.size(), layerPrefix) == 0)
                it = storedSamples.erase(it);
            else
                ++it;
        }
    }
    auto sample = StoredSample { key, std::move(samples), sampleRate };
    storedSamples.insert_or_assign(std::move(key), std::move(sample));
}

std::vector<LayerForgeAudioProcessor::StoredSample> LayerForgeAudioProcessor::getStoredSamples() const
{
    std::vector<StoredSample> samples;
    const juce::ScopedLock lock(patchStateLock);
    samples.reserve(storedSamples.size());
    for (const auto& [key, sample] : storedSamples)
        samples.push_back(sample);
    return samples;
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new LayerForgeAudioProcessor();
}
