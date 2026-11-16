#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "LayerForgeNativeGraph.h"
#include <elem/AudioBufferResource.h>
#include <juce_javascript/juce_javascript.h>

#include <cmath>
#include <limits>
#include <unordered_set>

namespace
{
constexpr int patchStateMagic = 0x4c464753;
constexpr int patchStateVersion = 1;
constexpr int maximumStoredSamples = 6;

template <int Channel>
struct MidiSignalNode : elem::GraphNode<float>
{
    using elem::GraphNode<float>::GraphNode;

    void process(const elem::BlockContext<float>& context) override
    {
        const auto* signals = static_cast<const LayerForgeMidiSignals*>(context.userData);
        if (signals == nullptr) {
            std::fill_n(context.outputData[0], context.numSamples, 0.0f);
            return;
        }
        const float* source = Channel == 0 ? signals->gate : Channel == 1 ? signals->trigger : signals->velocity;
        std::copy_n(source, context.numSamples, context.outputData[0]);
    }
};

std::unordered_set<std::string> getReferencedSampleKeys(const juce::String& json)
{
    std::unordered_set<std::string> keys;
    const auto state = juce::JSON::parse(json);
    const auto* object = state.getDynamicObject();
    const auto* layers = object != nullptr ? object->getProperty("layers").getArray() : nullptr;
    if (layers == nullptr)
        return keys;
    for (const auto& value : *layers) {
        const auto* layer = value.getDynamicObject();
        if (layer != nullptr && static_cast<bool>(layer->getProperty("loaded"))) {
            const auto key = layer->getProperty("sampleKey").toString().toStdString();
            if (!key.empty())
                keys.insert(key);
            const auto rightKey = layer->getProperty("sampleRightKey").toString().toStdString();
            if (!rightKey.empty())
                keys.insert(rightKey);
        }
    }
    return keys;
}
}

class LayerForgeAudioProcessor::GraphWorker : public juce::Thread
{
public:
    explicit GraphWorker(LayerForgeAudioProcessor& owner)
        : juce::Thread("LayerForge graph restore"), processor(owner)
    {
        startThread();
    }

    ~GraphWorker() override
    {
        signalThreadShouldExit();
        notify();
        stopThread(-1);
    }

    void run() override
    {
        juce::JavascriptEngine javascript;
        const auto code = juce::String::fromUTF8(NativeGraphData::nativegraph_js,
                                                   NativeGraphData::nativegraph_jsSize);
        const auto loaded = javascript.execute(code);
        if (loaded.failed()) {
            juce::Logger::writeToLog("LayerForge: could not initialize native graph builder: " + loaded.getErrorMessage());
            return;
        }

        while (!threadShouldExit()) {
            wait(-1);
            if (threadShouldExit())
                break;

            const auto generation = processor.graphGeneration.load(std::memory_order_acquire);
            juce::String patch;
            juce::DynamicObject::Ptr lengths(new juce::DynamicObject());
            {
                const juce::ScopedLock lock(processor.patchStateLock);
                patch = processor.patchStateJson;
                for (const auto& [key, sample] : processor.storedSamples)
                    lengths->setProperty(juce::Identifier(juce::String::fromUTF8(key.c_str())),
                                         static_cast<int>(sample.samples.size()));
            }

            const auto state = patch.isEmpty() ? juce::var() : juce::JSON::parse(patch);
            const juce::var args[] { state, juce::var(lengths.get()) };
            const juce::var::NativeFunctionArgs callArgs(juce::var(), args, 2);
            juce::Result error = juce::Result::ok();
            const auto result = javascript.callFunction("buildLayerForgeGraph", callArgs, &error);
            if (error.failed() || !result.isString()) {
                juce::Logger::writeToLog("LayerForge: could not build restored audio graph: " + error.getErrorMessage());
                continue;
            }
            const auto instructions = elem::js::parseJSON(result.toString().toStdString());
            if (!instructions.isArray()) {
                juce::Logger::writeToLog("LayerForge: restored audio graph is invalid");
                continue;
            }
            const juce::ScopedLock lock(processor.graphWriteLock);
            if (generation != processor.graphGeneration.load(std::memory_order_acquire)
                || processor.runtime == nullptr)
                continue;
            const auto status = processor.runtime->applyInstructions(instructions.getArray());
            if (status != elem::ReturnCode::Ok())
                juce::Logger::writeToLog("LayerForge: could not restore audio graph: "
                                         + juce::String(elem::ReturnCode::describe(status)));
        }
    }

private:
    LayerForgeAudioProcessor& processor;
};

LayerForgeAudioProcessor::LayerForgeAudioProcessor()
    : AudioProcessor(BusesProperties()
          .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
    graphWorker = std::make_unique<GraphWorker>(*this);
}

LayerForgeAudioProcessor::~LayerForgeAudioProcessor()
{
    graphWorker.reset();
}

void LayerForgeAudioProcessor::requestGraphRebuild()
{
    graphGeneration.fetch_add(1, std::memory_order_acq_rel);
    graphWorker->notify();
}

int LayerForgeAudioProcessor::applyRenderInstructions(const elem::js::Array& instructions)
{
    const juce::ScopedLock lock(graphWriteLock);
    graphGeneration.fetch_add(1, std::memory_order_acq_rel);
    return runtime != nullptr ? runtime->applyInstructions(instructions) : elem::ReturnCode::NodeNotFound();
}

bool LayerForgeAudioProcessor::addSampleResource(const std::string& key, std::vector<float>& samples)
{
    const juce::ScopedLock lock(graphWriteLock);
    return runtime != nullptr && runtime->addSharedResource(
        key, std::make_unique<elem::AudioBufferResource>(samples.data(), samples.size()));
}

void LayerForgeAudioProcessor::audition(float velocity)
{
    auditionVelocity.store(juce::jlimit(0.001f, 1.0f, velocity), std::memory_order_release);
}

void LayerForgeAudioProcessor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    const juce::ScopedLock lock(graphWriteLock);
    runtime = std::make_unique<elem::Runtime<float>>(sampleRate, samplesPerBlock);
    runtime->registerNodeType("layerforge-midi-gate", [](auto id, auto rate, auto size) {
        return std::make_shared<MidiSignalNode<0>>(id, rate, size);
    });
    runtime->registerNodeType("layerforge-midi-trigger", [](auto id, auto rate, auto size) {
        return std::make_shared<MidiSignalNode<1>>(id, rate, size);
    });
    runtime->registerNodeType("layerforge-midi-velocity", [](auto id, auto rate, auto size) {
        return std::make_shared<MidiSignalNode<2>>(id, rate, size);
    });
    auto samples = getStoredSamples();
    for (auto& sample : samples) {
        if (!runtime->addSharedResource(
                sample.key,
                std::make_unique<elem::AudioBufferResource>(sample.samples.data(), sample.samples.size())))
            DBG("[LayerForge] Could not restore sample resource: " + juce::String(sample.key));
    }
    scratchBuffer.setSize(11, std::max(1, samplesPerBlock));
    midiSignals.setSize(3, std::max(1, samplesPerBlock));
    midiGateRemaining = 0;
    midiVelocity = 1.0f;
    traceFrameCounter = 0;
    requestGraphRebuild();
}

void LayerForgeAudioProcessor::releaseResources()
{
}

void LayerForgeAudioProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages)
{
    juce::ScopedNoDenormals noDenormals;
    buffer.clear();

    if (runtime)
    {
        const int numSamples = buffer.getNumSamples();
        const int blockSize = scratchBuffer.getNumSamples();
        auto midi = midiMessages.cbegin();
        const auto midiEnd = midiMessages.cend();
        const auto requestedAudition = auditionVelocity.exchange(0.0f, std::memory_order_acq_rel);
        for (int offset = 0; offset < numSamples; offset += blockSize) {
            const int count = std::min(blockSize, numSamples - offset);
            auto* outL = buffer.getWritePointer(0, offset);
            auto* outR = buffer.getNumChannels() > 1 ? buffer.getWritePointer(1, offset) : outL;
            auto* gate = scratchBuffer.getWritePointer(0);
            auto* inputGate = midiSignals.getWritePointer(0);
            auto* inputTrigger = midiSignals.getWritePointer(1);
            auto* inputVelocity = midiSignals.getWritePointer(2);
            for (int index = 0; index < count; ++index) {
                bool trigger = offset == 0 && index == 0 && requestedAudition > 0.0f;
                if (trigger)
                    midiVelocity = requestedAudition;
                while (midi != midiEnd && (*midi).samplePosition <= offset + index) {
                    const auto message = (*midi).getMessage();
                    if (message.isNoteOn()) {
                        midiVelocity = message.getFloatVelocity();
                        trigger = true;
                        midiTriggerCount.fetch_add(1, std::memory_order_relaxed);
                    }
                    ++midi;
                }
                if (trigger)
                    midiGateRemaining = std::max(1, static_cast<int>(getSampleRate() * 0.028));
                inputTrigger[index] = trigger ? 1.0f : 0.0f;
                inputGate[index] = midiGateRemaining > 0 ? 1.0f : 0.0f;
                inputVelocity[index] = midiVelocity - 1.0f;
                if (midiGateRemaining > 0)
                    --midiGateRemaining;
            }
            LayerForgeMidiSignals signals { inputGate, inputTrigger, inputVelocity };
            float* outputs[13] = { outL, outR, gate };
            for (int channel = 3; channel < 13; ++channel)
                outputs[channel] = scratchBuffer.getWritePointer(channel - 2);
            runtime->process(nullptr, 0, outputs, 13, count, &signals);

            float peak = 0.0f;
            for (int index = 0; index < count; ++index)
                peak = std::max(peak, std::max(std::abs(outL[index]), std::abs(outR[index])));
            auto previous = outputPeak.load(std::memory_order_relaxed);
            while (peak > previous
                   && !outputPeak.compare_exchange_weak(previous, peak, std::memory_order_relaxed)) {}

            const int generation = traceSession.load(std::memory_order_relaxed);
            if (generation > 0) {
                int start1, size1, start2, size2;
                traceFifo.prepareToWrite(count, start1, size1, start2, size2);
                const auto writeFrames = [&](int start, int size, int sourceOffset) {
                    for (int index = 0; index < size; ++index) {
                        const int sourceIndex = sourceOffset + index;
                        auto& frame = traceFrames[static_cast<size_t>(start + index)];
                        frame.left = outL[sourceIndex];
                        frame.right = outR[sourceIndex];
                        frame.gate = gate[sourceIndex];
                        for (size_t lane = 0; lane < frame.lanes.size(); ++lane)
                            frame.lanes[lane] = outputs[3 + lane][sourceIndex];
                        frame.frame = traceFrameCounter + static_cast<std::uint64_t>(sourceIndex);
                        frame.generation = generation;
                    }
                };
                writeFrames(start1, size1, 0);
                writeFrames(start2, size2, size1);
                traceFifo.finishedWrite(size1 + size2);
            }
            traceFrameCounter += static_cast<std::uint64_t>(count);
        }
    }
}

void LayerForgeAudioProcessor::setOutputTrace(bool enabled, int generation)
{
    traceSession.store(enabled ? generation : 0, std::memory_order_relaxed);
}

int LayerForgeAudioProcessor::readOutputTrace(TraceFrame* destination, int capacity)
{
    int start1, size1, start2, size2;
    traceFifo.prepareToRead(capacity, start1, size1, start2, size2);
    std::copy_n(traceFrames.data() + start1, size1, destination);
    std::copy_n(traceFrames.data() + start2, size2, destination + size1);
    traceFifo.finishedRead(size1 + size2);
    return size1 + size2;
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
        const auto referencedKeys = getReferencedSampleKeys(stateJson);
        samples.reserve(storedSamples.size());
        for (const auto& [key, sample] : storedSamples) {
            if (referencedKeys.count(key) != 0)
                samples.push_back({ key, sample.samples, sample.sampleRate });
        }
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
        const juce::ScopedLock graphLock(graphWriteLock);
        auto samples = getStoredSamples();
        for (auto& sample : samples) {
            if (!runtime->addSharedResource(
                    sample.key,
                    std::make_unique<elem::AudioBufferResource>(sample.samples.data(), sample.samples.size())))
                DBG("[LayerForge] Could not restore sample resource: " + juce::String(sample.key));
        }
    }
    requestGraphRebuild();
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
    const auto referencedKeys = getReferencedSampleKeys(patchStateJson);
    if (!layerPrefix.empty()) {
        for (auto it = storedSamples.begin(); it != storedSamples.end();) {
            const auto isStereoPartner = it->first == key + ":right" || key == it->first + ":right";
            if (it->first.compare(0, layerPrefix.size(), layerPrefix) == 0
                && !isStereoPartner
                && referencedKeys.count(it->first) == 0)
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
