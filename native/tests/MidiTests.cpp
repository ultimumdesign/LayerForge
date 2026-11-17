#include "../PluginProcessor.h"
#include "../SampleHash.h"

#include <cmath>
#include <iostream>

namespace
{
bool expect(bool condition, const char* message)
{
    if (!condition)
        std::cerr << message << '\n';
    return condition;
}

juce::RangedAudioParameter* findParameter(LayerForgeAudioProcessor& processor, const juce::String& id)
{
    for (auto* candidate : processor.getParameters())
        if (auto* parameter = dynamic_cast<juce::RangedAudioParameter*>(candidate))
            if (parameter->paramID == id)
                return parameter;
    return nullptr;
}

struct ParameterListener : juce::AudioProcessorParameter::Listener
{
    int values = 0, begins = 0, ends = 0;
    void parameterValueChanged(int, float) override { ++values; }
    void parameterGestureChanged(int, bool starting) override { starting ? ++begins : ++ends; }
};

struct CountingInputStream : juce::MemoryInputStream
{
    explicit CountingInputStream(const juce::MemoryBlock& data)
        : juce::MemoryInputStream(data, false) {}

    int read(void* destination, int size) override
    {
        ++reads;
        return MemoryInputStream::read(destination, size);
    }

    int reads = 0;
};

bool run()
{
    juce::MemoryBlock hashData(1024 * 1024);
    auto* bytes = static_cast<std::uint8_t*>(hashData.getData());
    for (size_t i = 0; i < hashData.getSize(); ++i)
        bytes[i] = static_cast<std::uint8_t>(i % 251);
    CountingInputStream hashInput(hashData);
    if (!expect(hashSampleStream(hashInput) == juce::SHA256(hashData).toHexString()
                    && hashInput.reads <= 32,
                "Sample hashing changed the hash or performed excessive source reads"))
        return false;

    constexpr int blockSize = 128;
    constexpr double sampleRate = 44100.0;
    LayerForgeAudioProcessor source;
    std::vector<float> sample(4410, 0.5f);
    sample[1] = -0.5f;
    source.storeSampleResource("kick", sample, sampleRate);
    std::vector<float> rightSample(4410, 0.25f);
    source.storeSampleResource("kick-right", rightSample, sampleRate);
    if (!source.setPatchStateJson(
            R"({"loadedPreset":"kick.lfpreset","uiTheme":"cyan-volt","uiBorderTrace":{"level":"subtle","speed":"fast"},"layers":[{"loaded":true,"sampleKey":"kick","sampleRightKey":"kick-right","sampleRate":44100,"sampleCount":4410,"envelopePoints":[{"time":0,"value":1},{"time":1,"value":1}]}],"noise":{"mute":true},"master":{"glueEnabled":true,"glueThreshold":-30,"glueRatio":8,"glueAttack":0.001}})"))
        return false;
    juce::MemoryBlock saved;
    source.getStateInformation(saved);

    LayerForgeAudioProcessor restored;
    restored.setRateAndBufferSizeDetails(sampleRate, blockSize);
    restored.prepareToPlay(sampleRate, blockSize);
    restored.setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
    auto* output = findParameter(restored, "master_outputDb");
    auto* pitch = findParameter(restored, "l0_pitch");
    if (!expect(restored.getParameters().size() == 55 && output != nullptr && pitch != nullptr,
                "Host parameter set is incomplete"))
        return false;
    if (!expect(std::abs(output->convertFrom0to1(output->getValue())) < 1e-4f,
                "Legacy patch did not use parameter defaults"))
        return false;
    ParameterListener listener;
    pitch->addListener(&listener);
    restored.setParameterFromEditor("l0_pitch", 5.0f);
    if (!expect(listener.values == 1 && listener.begins == 1 && listener.ends == 1
                    && std::abs(pitch->convertFrom0to1(pitch->getValue()) - 5.0f) < 1e-4f,
                "Editor parameter edit did not notify the host with a gesture"))
        return false;
    restored.setParameterFromEditor("l0_pitch", std::numeric_limits<float>::quiet_NaN());
    if (!expect(listener.values == 1, "Invalid editor parameter value was accepted"))
        return false;
    pitch->removeListener(&listener);
    restored.setParameterFromEditor("l0_pitch", 0.0f);
    LayerForgeAudioProcessor legacy;
    if (!expect(legacy.setPatchStateJson(
                    R"({"noise":{"saturationDrive":17,"saturationMix":0.4},"layers":[{"pitch":100}]})")
                    && std::abs(findParameter(legacy, "master_saturationDrive")->convertFrom0to1(
                        findParameter(legacy, "master_saturationDrive")->getValue()) - 17.0f) < 1e-4f
                    && std::abs(findParameter(legacy, "master_saturationMix")->convertFrom0to1(
                        findParameter(legacy, "master_saturationMix")->getValue()) - 0.4f) < 1e-4f
                    && std::abs(findParameter(legacy, "l0_pitch")->convertFrom0to1(
                        findParameter(legacy, "l0_pitch")->getValue()) - 24.0f) < 1e-4f,
                "Legacy parameter migration or clamping failed"))
        return false;
    const auto restoredState = juce::JSON::parse(restored.getPatchStateJson());
    if (!expect(restoredState.getProperty("loadedPreset", {}).toString() == "kick.lfpreset",
                "Loaded preset selection was not preserved in host state"))
        return false;
    if (!expect(restoredState.getProperty("uiTheme", {}).toString() == "cyan-volt",
                "Color theme was not preserved in host state"))
        return false;
    const auto borderTrace = restoredState.getProperty("uiBorderTrace", {});
    if (!expect(borderTrace.getProperty("level", {}).toString() == "subtle"
                    && borderTrace.getProperty("speed", {}).toString() == "fast",
                "Border tracing settings were not preserved in host state"))
        return false;
    const auto restoredSamples = restored.getStoredSamples();
    bool foundRightSample = false;
    for (const auto& stored : restoredSamples)
        if (stored.key == "kick-right" && stored.samples == rightSample && stored.sampleRate == sampleRate)
            foundRightSample = true;
    if (!expect(foundRightSample, "Right-channel sample was not preserved in host state"))
        return false;
    juce::AudioBuffer<float> audio(2, blockSize);
    juce::MidiBuffer midi;
    bool graphReady = false;
    for (int attempt = 0; attempt < 300 && !graphReady; ++attempt) {
        for (int block = 0; block < 16; ++block) {
            midi.clear();
            restored.processBlock(audio, midi);
        }
        midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(127)), 47);
        restored.processBlock(audio, midi);
        graphReady = std::abs(audio.getSample(0, 47)) > 1e-5f;
        if (!graphReady)
            juce::Thread::sleep(10);
    }
    if (!expect(graphReady, "Restored graph did not produce audio without an editor"))
        return false;
    if (!expect(restored.takeEffectPeak(2) > 0.0f && restored.takeEffectPeak(3) > 0.0f,
                "Compressor input/output meters did not receive audio"))
        return false;
    if (!expect(restored.takeEffectPeak(4) > 0.0f, "Compressor gain reduction meter did not receive data"))
        return false;

    for (int block = 0; block < 50; ++block) {
        midi.clear();
        restored.processBlock(audio, midi);
    }
    midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(127)), 47);
    restored.processBlock(audio, midi);
    for (int index = 0; index < 47; ++index)
        if (!expect(std::abs(audio.getSample(0, index)) < 1e-6f, "MIDI note sounded before its sample offset"))
            return false;
    if (!expect(std::abs(audio.getSample(0, 47)) > 1e-5f, "MIDI note did not start at its sample offset"))
        return false;
    if (!expect(audio.getSample(1, 47) > 1e-5f && audio.getSample(0, 47) > audio.getSample(1, 47),
                "Restored stereo sample did not preserve its distinct channels"))
        return false;
    const auto fullVelocityOnset = std::abs(audio.getSample(0, 47));

    output->setValueNotifyingHost(output->convertTo0to1(-60.0f));
    bool automationApplied = false;
    for (int attempt = 0; attempt < 300 && !automationApplied; ++attempt) {
        for (int block = 0; block < 50; ++block) {
            midi.clear();
            restored.processBlock(audio, midi);
        }
        midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(127)), 47);
        restored.processBlock(audio, midi);
        automationApplied = std::abs(audio.getSample(0, 47)) < fullVelocityOnset * 0.01f;
        if (!automationApplied)
            juce::Thread::sleep(10);
    }
    if (!expect(automationApplied, "Host automation did not affect audio with the editor closed"))
        return false;
    pitch->setValueNotifyingHost(pitch->convertTo0to1(12.0f));
    pitch->setValueNotifyingHost(pitch->convertTo0to1(0.0f));
    const auto revision = restored.getStateRevision();
    if (!expect(restored.setPatchStateJson(
                    R"({"layers":[{"loaded":true,"sampleKey":"kick","sampleRightKey":"kick-right","sampleRate":44100,"sampleCount":4410}],"master":{"outputDb":12}})",
                    false, revision), "UI patch update was rejected"))
        return false;
    if (!expect(std::abs(static_cast<double>(juce::JSON::parse(restored.getPatchStateJson())
                    .getProperty("master", {}).getProperty("outputDb", {})) + 60.0) < 1e-3,
                "Stale UI snapshot overwrote host automation"))
        return false;
    juce::MemoryBlock automatedState;
    restored.getStateInformation(automatedState);
    LayerForgeAudioProcessor reopened;
    reopened.setStateInformation(automatedState.getData(), static_cast<int>(automatedState.getSize()));
    if (!expect(std::abs(findParameter(reopened, "master_outputDb")->convertFrom0to1(
                        findParameter(reopened, "master_outputDb")->getValue()) + 60.0f) < 1e-3f,
                "Automated value was not restored from host state"))
        return false;
    juce::String reopenedJson;
    std::vector<LayerForgeAudioProcessor::StoredSample> reopenedSamples;
    std::uint64_t reopenedRevision = 0;
    reopened.getPluginStateSnapshot(reopenedJson, reopenedSamples, reopenedRevision);
    if (!expect(reopenedSamples.size() == 2
                    && std::abs(static_cast<double>(juce::JSON::parse(reopenedJson)
                           .getProperty("master", {}).getProperty("outputDb", {})) + 60.0) < 1e-3,
                "Reopened editor snapshot did not include automated values and stereo samples"))
        return false;
    restored.setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
    if (!expect(!restored.setPatchStateJson(R"({"master":{"outputDb":12}})", false, revision),
                "A UI write from before host state restore was accepted"))
        return false;
    restored.setParameterFromEditor("master_outputDb", 12.0f, revision);
    if (!expect(std::abs(output->convertFrom0to1(output->getValue())) < 1e-4f,
                "A parameter edit from before host state restore was accepted"))
        return false;
    output->setValueNotifyingHost(output->convertTo0to1(0.0f));
    bool outputRestored = false;
    for (int attempt = 0; attempt < 300 && !outputRestored; ++attempt) {
        for (int block = 0; block < 50; ++block) {
            midi.clear();
            restored.processBlock(audio, midi);
        }
        midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(127)), 47);
        restored.processBlock(audio, midi);
        outputRestored = std::abs(audio.getSample(0, 47)) > fullVelocityOnset * 0.5f;
        if (!outputRestored)
            juce::Thread::sleep(10);
    }
    if (!expect(outputRestored, "Audio did not recover after restoring host state"))
        return false;

    for (int block = 0; block < 50; ++block) {
        midi.clear();
        restored.processBlock(audio, midi);
    }
    midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(127)), 47);
    midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(127)), 48);
    restored.processBlock(audio, midi);
    if (!expect(audio.getSample(0, 47) > 1e-5f && audio.getSample(0, 48) > 1e-5f,
                "Consecutive MIDI notes did not retrigger independently"))
        return false;

    for (int block = 0; block < 50; ++block) {
        midi.clear();
        restored.processBlock(audio, midi);
    }
    midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(32)), 47);
    restored.processBlock(audio, midi);
    if (!expect(std::abs(audio.getSample(0, 47)) > 1e-5f
                    && std::abs(audio.getSample(0, 47)) < fullVelocityOnset * 0.4f,
                "MIDI velocity was not applied at note onset"))
        return false;

    for (int block = 0; block < 50; ++block) {
        midi.clear();
        restored.processBlock(audio, midi);
    }
    restored.audition(1.0f);
    restored.processBlock(audio, midi);
    return expect(std::abs(audio.getSample(0, 0)) > 1e-5f, "Native audition did not trigger");
}
}

int main()
{
    return run() ? 0 : 1;
}
