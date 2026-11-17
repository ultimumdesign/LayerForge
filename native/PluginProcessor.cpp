#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "LayerForgeNativeGraph.h"
#include "HostParameters.h"
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

class LayerForgeAudioProcessor::HostParameter : public juce::AudioParameterFloat
{
public:
    HostParameter(LayerForgeAudioProcessor& owner, const HostParameterSpec& definition)
        : juce::AudioParameterFloat(juce::ParameterID(definition.id, 1), definition.name,
              juce::NormalisableRange<float>(definition.min, definition.max), definition.initial,
              juce::AudioParameterFloatAttributes().withLabel(definition.unit)),
          processor(owner), spec(definition) {}

    void valueChanged(float) override
    {
        processor.graphGeneration.fetch_add(1, std::memory_order_release);
    }

    LayerForgeAudioProcessor& processor;
    const HostParameterSpec& spec;
};

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

        std::uint64_t appliedGeneration = std::numeric_limits<std::uint64_t>::max();
        std::uint64_t rendererRuntime = std::numeric_limits<std::uint64_t>::max();
        while (!threadShouldExit()) {
            wait(20);
            if (threadShouldExit())
                break;

            const auto generation = processor.graphGeneration.load(std::memory_order_acquire);
            if (generation == appliedGeneration)
                continue;
            const auto runtimeGeneration = processor.runtimeGeneration.load(std::memory_order_acquire);
            juce::String patch;
            juce::DynamicObject::Ptr lengths(new juce::DynamicObject());
            {
                const juce::ScopedLock lock(processor.patchStateLock);
                patch = processor.patchStateJson;
                for (const auto& [key, sample] : processor.storedSamples)
                    lengths->setProperty(juce::Identifier(juce::String::fromUTF8(key.c_str())),
                                         static_cast<int>(sample.samples.size()));
            }

            const auto state = processor.overlayParameters(patch.isEmpty() ? juce::var() : juce::JSON::parse(patch));
            const juce::var args[] { state, juce::var(lengths.get()), runtimeGeneration != rendererRuntime };
            const juce::var::NativeFunctionArgs callArgs(juce::var(), args, 3);
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
            if (runtimeGeneration != processor.runtimeGeneration.load(std::memory_order_acquire)
                || processor.runtime == nullptr) {
                rendererRuntime = std::numeric_limits<std::uint64_t>::max();
                continue;
            }
            const auto status = processor.runtime->applyInstructions(instructions.getArray());
            if (status != elem::ReturnCode::Ok()) {
                juce::Logger::writeToLog("LayerForge: could not restore audio graph: "
                                         + juce::String(elem::ReturnCode::describe(status)));
                rendererRuntime = std::numeric_limits<std::uint64_t>::max();
            } else {
                rendererRuntime = runtimeGeneration;
                appliedGeneration = generation;
            }
        }
    }

private:
    LayerForgeAudioProcessor& processor;
};

LayerForgeAudioProcessor::LayerForgeAudioProcessor()
    : AudioProcessor(BusesProperties()
          .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
    for (const auto& spec : hostParameterSpecs) {
        auto* parameter = new HostParameter(*this, spec);
        hostParameters.push_back(parameter);
        addParameter(parameter);
    }
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
    runtimeGeneration.fetch_add(1, std::memory_order_release);
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
    scratchBuffer.setSize(16, std::max(1, samplesPerBlock));
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
            float* outputs[18] = { outL, outR, gate };
            for (int channel = 3; channel < 18; ++channel)
                outputs[channel] = scratchBuffer.getWritePointer(channel - 2);
            runtime->process(nullptr, 0, outputs, 18, count, &signals);

            float peak = 0.0f;
            for (int index = 0; index < count; ++index)
                peak = std::max(peak, std::max(std::abs(outL[index]), std::abs(outR[index])));
            auto previous = outputPeak.load(std::memory_order_relaxed);
            while (peak > previous
                   && !outputPeak.compare_exchange_weak(previous, peak, std::memory_order_relaxed)) {}
            for (size_t lane = 0; lane < effectPeaks.size(); ++lane) {
                float effectPeak = 0.0f;
                for (int index = 0; index < count; ++index)
                    effectPeak = std::max(effectPeak, std::abs(outputs[13 + lane][index]));
                auto previousEffect = effectPeaks[lane].load(std::memory_order_relaxed);
                while (effectPeak > previousEffect
                       && !effectPeaks[lane].compare_exchange_weak(previousEffect, effectPeak, std::memory_order_relaxed)) {}
            }

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
    std::uint64_t revision;
    getPluginStateSnapshot(stateJson, samples, revision);
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
        importPatchParameters(juce::JSON::parse(loadedState), false);
        stateRevision.fetch_add(1, std::memory_order_release);
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

bool LayerForgeAudioProcessor::setPatchStateJson(const juce::String& json, bool importParameters,
                                                  std::uint64_t expectedRevision)
{
    const auto patch = juce::JSON::parse(json);
    if (!patch.isObject())
        return false;

    std::uint64_t revision;
    {
        const juce::ScopedLock lock(patchStateLock);
        revision = stateRevision.load(std::memory_order_relaxed);
        if (expectedRevision != std::numeric_limits<std::uint64_t>::max() && expectedRevision != revision)
            return false;
        patchStateJson = json;
    }
    if (importParameters)
        importPatchParameters(patch, true, revision);
    requestGraphRebuild();
    return true;
}

juce::String LayerForgeAudioProcessor::getPatchStateJson() const
{
    juce::String json;
    {
        const juce::ScopedLock lock(patchStateLock);
        json = patchStateJson;
    }
    return juce::JSON::toString(overlayParameters(json.isEmpty() ? juce::var() : juce::JSON::parse(json)));
}

void LayerForgeAudioProcessor::getPluginStateSnapshot(juce::String& json,
                                                       std::vector<StoredSample>& samples,
                                                       std::uint64_t& revision) const
{
    const juce::ScopedLock lock(patchStateLock);
    revision = stateRevision.load(std::memory_order_relaxed);
    json = juce::JSON::toString(overlayParameters(
        patchStateJson.isEmpty() ? juce::var() : juce::JSON::parse(patchStateJson)));
    samples.clear();
    const auto referenced = getReferencedSampleKeys(patchStateJson);
    for (const auto& [key, sample] : storedSamples)
        if (referenced.count(key) != 0)
            samples.push_back(sample);
}

namespace
{
juce::DynamicObject* parameterSection(juce::var& patch, const HostParameterSpec& spec)
{
    auto* root = patch.getDynamicObject();
    const juce::String id(spec.id);
    if (id.startsWithChar('l')) {
        auto layers = root->getProperty("layers");
        if (!layers.isArray())
            layers = juce::Array<juce::var>();
        auto* array = layers.getArray();
        const int index = id.substring(1, id.indexOfChar('_')).getIntValue();
        while (array->size() <= index) {
            juce::DynamicObject::Ptr layer(new juce::DynamicObject());
            juce::DynamicObject::Ptr start(new juce::DynamicObject()), end(new juce::DynamicObject());
            start->setProperty("time", 0);
            start->setProperty("value", 1);
            end->setProperty("time", 1);
            end->setProperty("value", 1);
            layer->setProperty("envelopePoints", juce::var(juce::Array<juce::var> { start.get(), end.get() }));
            array->add(juce::var(layer.get()));
        }
        if (!(*array)[index].isObject())
            array->set(index, juce::var(new juce::DynamicObject()));
        root->setProperty("layers", layers);
        return (*array)[index].getDynamicObject();
    }
    const auto section = id.upToFirstOccurrenceOf("_", false, false);
    auto value = root->getProperty(section);
    if (!value.isObject()) {
        value = juce::var(new juce::DynamicObject());
        root->setProperty(section, value);
    }
    return value.getDynamicObject();
}
}

juce::var LayerForgeAudioProcessor::overlayParameters(juce::var patch) const
{
    if (!patch.isObject())
        patch = juce::var(new juce::DynamicObject());
    if (!patch.getProperty("noise", {}).isObject()) {
        juce::DynamicObject::Ptr noise(new juce::DynamicObject());
        noise->setProperty("enabled", false);
        patch.getDynamicObject()->setProperty("noise", noise.get());
    }
    for (const auto* parameter : hostParameters) {
        const juce::String id(parameter->spec.id);
        parameterSection(patch, parameter->spec)->setProperty(
            id.fromFirstOccurrenceOf("_", false, false), static_cast<double>(parameter->get()));
    }
    return patch;
}

void LayerForgeAudioProcessor::importPatchParameters(const juce::var& input, bool notifyHost,
                                                      std::uint64_t revision)
{
    // Work on a private copy because filling missing sections must not alter the stored patch.
    auto patch = juce::JSON::parse(juce::JSON::toString(input));
    for (auto* parameter : hostParameters) {
        const juce::String id(parameter->spec.id);
        const auto key = id.fromFirstOccurrenceOf("_", false, false);
        auto value = parameterSection(patch, parameter->spec)->getProperty(key);
        if (value.isVoid() && (id == "master_saturationDrive" || id == "master_saturationMix"))
            value = patch.getProperty("noise", {}).getProperty(key, {});
        const double number = (value.isDouble() || value.isInt() || value.isInt64())
            ? static_cast<double>(value) : parameter->spec.initial;
        const auto plain = std::isfinite(number) ? static_cast<float>(number) : parameter->spec.initial;
        const auto normalized = parameter->convertTo0to1(juce::jlimit(parameter->spec.min, parameter->spec.max, plain));
        if (static_cast<juce::AudioProcessorParameter*>(parameter)->getValue() == normalized)
            continue;
        if (notifyHost) {
            setParameterFromEditor(id, plain, revision);
        } else {
            static_cast<juce::AudioProcessorParameter*>(parameter)->setValue(normalized);
        }
    }
}

void LayerForgeAudioProcessor::setParameterFromEditor(const juce::String& id, float value,
                                                       std::uint64_t expectedRevision)
{
    if (!std::isfinite(value))
        return;
    for (auto* parameter : hostParameters) {
        if (id != parameter->spec.id)
            continue;
        const auto normalized = parameter->convertTo0to1(juce::jlimit(parameter->spec.min, parameter->spec.max, value));
        if (static_cast<juce::AudioProcessorParameter*>(parameter)->getValue() == normalized)
            return;
        parameter->beginChangeGesture();
        bool applied = false;
        {
            const juce::ScopedLock lock(patchStateLock);
            if (expectedRevision == std::numeric_limits<std::uint64_t>::max()
                || expectedRevision == stateRevision.load(std::memory_order_relaxed)) {
                static_cast<juce::AudioProcessorParameter*>(parameter)->setValue(normalized);
                applied = true;
            }
        }
        if (applied)
            parameter->sendValueChangedMessageToListeners(
                static_cast<juce::AudioProcessorParameter*>(parameter)->getValue());
        parameter->endChangeGesture();
        return;
    }
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

    {
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
    requestGraphRebuild();
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
