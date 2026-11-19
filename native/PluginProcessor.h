#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <elem/Runtime.h>
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <limits>
#include <string>
#include <unordered_map>
#include <vector>

struct LayerForgeMidiSignals
{
    const float* gate;
    const float* trigger;
    const float* velocity;
};

class LayerForgeAudioProcessor : public juce::AudioProcessor
{
public:
    struct StoredSample
    {
        std::string key;
        std::vector<float> samples;
        double sampleRate = 44100.0;
    };

    struct TraceFrame
    {
        float left = 0;
        float right = 0;
        float gate = 0;
        std::array<float, 10> lanes {};
        std::uint64_t frame = 0;
        int generation = 0;
    };

    LayerForgeAudioProcessor();
    ~LayerForgeAudioProcessor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 4.1; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    bool setPatchStateJson(const juce::String& json, bool importParameters = true,
                           std::uint64_t expectedRevision = std::numeric_limits<std::uint64_t>::max());
    juce::String getPatchStateJson() const;
    void getPluginStateSnapshot(juce::String& json, std::vector<StoredSample>& samples,
                                std::uint64_t& revision) const;
    std::uint64_t getStateRevision() const { return stateRevision.load(std::memory_order_acquire); }
    void setParameterFromEditor(const juce::String& id, float value,
                                std::uint64_t expectedRevision = std::numeric_limits<std::uint64_t>::max());
    void storeSampleResource(std::string key, std::vector<float> samples, double sampleRate);
    std::vector<StoredSample> getStoredSamples() const;
    void setOutputTrace(bool enabled, int generation);
    int readOutputTrace(TraceFrame* destination, int capacity);
    float takeOutputPeak() { return outputPeak.exchange(0.0f); }
    float takeEffectPeak(size_t index) { return effectPeaks[index].exchange(0.0f); }
    void audition(float velocity);
    int takeMidiTriggerCount() { return midiTriggerCount.exchange(0, std::memory_order_relaxed); }

    elem::Runtime<float>* getRuntime() { return runtime.get(); }
    int applyRenderInstructions(const elem::js::Array& instructions);
    bool addSampleResource(const std::string& key, std::vector<float>& samples);

private:
    class GraphWorker;
    class HostParameter;
    void requestGraphRebuild();
    void importPatchParameters(const juce::var& patch, bool notifyHost,
                               std::uint64_t revision = std::numeric_limits<std::uint64_t>::max());
    juce::var overlayParameters(juce::var patch) const;
    mutable juce::CriticalSection patchStateLock;
    juce::String patchStateJson;
    std::unordered_map<std::string, StoredSample> storedSamples;
    std::unique_ptr<elem::Runtime<float>> runtime;
    juce::CriticalSection graphWriteLock;
    std::unique_ptr<GraphWorker> graphWorker;
    std::atomic<std::uint64_t> graphGeneration { 0 };
    std::atomic<std::uint64_t> runtimeGeneration { 0 };
    std::atomic<std::uint64_t> stateRevision { 0 };
    std::vector<HostParameter*> hostParameters;
    juce::AudioBuffer<float> scratchBuffer;
    juce::AudioBuffer<float> midiSignals;
    int midiGateRemaining = 0;
    float midiVelocity = 1.0f;
    std::atomic<float> auditionVelocity { 0.0f };
    std::atomic<int> midiTriggerCount { 0 };
    static constexpr int traceCapacity = 65536;
    juce::AbstractFifo traceFifo { traceCapacity };
    std::vector<TraceFrame> traceFrames = std::vector<TraceFrame>(traceCapacity);
    std::atomic<int> traceSession { 0 };
    std::atomic<float> outputPeak { 0.0f };
    std::array<std::atomic<float>, 9> effectPeaks {};
    std::uint64_t traceFrameCounter = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(LayerForgeAudioProcessor)
};
