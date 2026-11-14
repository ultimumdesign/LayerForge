#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <elem/Runtime.h>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

class LayerForgeAudioProcessor : public juce::AudioProcessor
{
public:
    struct StoredSample
    {
        std::string key;
        std::vector<float> samples;
        double sampleRate = 44100.0;
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

    bool setPatchStateJson(const juce::String& json);
    juce::String getPatchStateJson() const;
    void storeSampleResource(std::string key, std::vector<float> samples, double sampleRate);
    std::vector<StoredSample> getStoredSamples() const;

    elem::Runtime<float>* getRuntime() { return runtime.get(); }
    std::function<void(int note, int velocity)> onMidiNoteOn;

private:
    mutable juce::CriticalSection patchStateLock;
    juce::String patchStateJson;
    std::unordered_map<std::string, StoredSample> storedSamples;
    std::unique_ptr<elem::Runtime<float>> runtime;
    juce::AudioBuffer<float> scratchBuffer;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(LayerForgeAudioProcessor)
};
