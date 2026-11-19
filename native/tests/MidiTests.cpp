#include "../PluginProcessor.h"
#include "../SampleHash.h"

#include <algorithm>
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

bool testConvolution(double sampleRate, const char* profile)
{
    constexpr int blockSize = 128;
    LayerForgeAudioProcessor processor;
    std::vector<float> sample(4410, 0.5f);
    processor.storeSampleResource("kick", sample, 44100.0);
    const auto patch = juce::String(R"({"layers":[{"loaded":true,"sampleKey":"kick","sampleRate":44100,"sampleCount":4410,"envelopePoints":[{"time":0,"value":1},{"time":1,"value":1}]}],"master":{"convolveEnabled":true,"convolveMix":1,"convolveProfile":")")
        + profile + R"("}})";
    if (!expect(processor.setPatchStateJson(patch), "Convolution patch was rejected"))
        return false;
    processor.setRateAndBufferSizeDetails(sampleRate, blockSize);
    processor.prepareToPlay(sampleRate, blockSize);
    if (!expect(!processor.getStoredSamples().empty(), "Convolution test sample was not stored"))
        return false;
    juce::AudioBuffer<float> audio(2, blockSize);
    juce::MidiBuffer midi;
    float input = 0.0f, output = 0.0f;
    float finalPeak = 0.0f;
    for (int attempt = 0; attempt < 300; ++attempt) {
        input = 0.0f;
        output = 0.0f;
        finalPeak = 0.0f;
        midi.clear();
        midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(127)), 0);
        for (int block = 0; block < 40; ++block) {
            processor.processBlock(audio, midi);
            midi.clear();
            finalPeak = std::max(finalPeak, audio.getMagnitude(0, 0, blockSize));
            input = std::max(input, processor.takeEffectPeak(5));
            output = std::max(output, processor.takeEffectPeak(6));
        }
        if (input > 0.0f && output > 0.0f && std::abs(input - output) > 1e-4f && finalPeak > 0.0f)
            break;
        juce::Thread::sleep(10);
    }
    if (input == 0.0f || output == 0.0f || std::abs(input - output) <= 1e-4f)
        std::cerr << "Convolution profile " << profile << " at " << sampleRate
                  << " Hz: input=" << input << ", output=" << output << ", final=" << finalPeak << '\n';
    if (!expect(input > 0.0f && output > 0.0f && finalPeak > 0.0f && std::abs(input - output) > 1e-4f,
                "Convolution or its meters did not process audio with the editor closed"))
        return false;
    const auto mutedPatch = patch.replace("\"convolveEnabled\":true", "\"convolveEnabled\":true,\"convolveMute\":true");
    if (!expect(processor.setPatchStateJson(mutedPatch), "Convolution mute patch was rejected"))
        return false;
    for (int attempt = 0; attempt < 300; ++attempt) {
        input = 0.0f;
        output = 0.0f;
        midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(127)), 0);
        for (int block = 0; block < 40; ++block) {
            processor.processBlock(audio, midi);
            midi.clear();
            input = std::max(input, processor.takeEffectPeak(5));
            output = std::max(output, processor.takeEffectPeak(6));
        }
        if (input > 0.0f && std::abs(input - output) < 1e-6f)
            return true;
        juce::Thread::sleep(10);
    }
    return expect(false, "Convolution mute did not bypass the effect and match its meter taps");
}

bool testRingModulation()
{
    constexpr int blockSize = 128;
    constexpr double sampleRate = 44100.0;
    LayerForgeAudioProcessor processor;
    processor.storeSampleResource("ring-left", std::vector<float>(4410, 0.5f), sampleRate);
    processor.storeSampleResource("ring-right", std::vector<float>(4410, 0.25f), sampleRate);
    const juce::String patch = R"({"layers":[{"loaded":true,"sampleKey":"ring-left","sampleRightKey":"ring-right","sampleRate":44100,"sampleCount":4410,"envelopePoints":[{"time":0,"value":1},{"time":1,"value":1}]}],"master":{"drive":0,"hardness":1,"ceiling":1,"ringModEnabled":true,"ringModFrequency":10,"ringModMix":1}})";
    if (!expect(processor.setPatchStateJson(patch), "Ring modulation patch was rejected"))
        return false;
    juce::MemoryBlock state;
    processor.getStateInformation(state);
    LayerForgeAudioProcessor restored;
    restored.setStateInformation(state.getData(), static_cast<int>(state.getSize()));
    auto* frequency = findParameter(restored, "master_ringModFrequency");
    const auto master = juce::JSON::parse(restored.getPatchStateJson()).getProperty("master", {});
    if (!expect(frequency != nullptr && std::abs(frequency->convertFrom0to1(frequency->getValue()) - 10.0f) < 0.01f
                    && static_cast<bool>(master.getProperty("ringModEnabled", false)),
                "Ring modulation host state was not restored"))
        return false;
    restored.setParameterFromEditor("master_ringModSpread", 0.4f);
    juce::MemoryBlock editedState;
    restored.getStateInformation(editedState);
    LayerForgeAudioProcessor reopened;
    reopened.setStateInformation(editedState.getData(), static_cast<int>(editedState.getSize()));
    auto* spread = findParameter(reopened, "master_ringModSpread");
    if (!expect(spread != nullptr && std::abs(spread->convertFrom0to1(spread->getValue()) - 0.4f) < 1e-4f,
                "Ring modulation spread automation was not preserved in host state"))
        return false;
    processor.setRateAndBufferSizeDetails(sampleRate, blockSize);
    processor.prepareToPlay(sampleRate, blockSize);
    juce::AudioBuffer<float> audio(2, blockSize);
    juce::MidiBuffer midi;
    bool processed = false;
    for (int attempt = 0; attempt < 300 && !processed; ++attempt) {
        midi.clear();
        midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(127)), 0);
        for (int block = 0; block < 40; ++block) {
            processor.processBlock(audio, midi);
            midi.clear();
            const auto input = processor.takeEffectPeak(7);
            const auto output = processor.takeEffectPeak(8);
            if (input > 0.1f && output > 0.001f && output < input * 0.8f) {
                for (int index = 0; index < blockSize; ++index)
                    if (std::abs(audio.getSample(0, index)) > 0.01f
                        && std::abs(audio.getSample(1, index) - audio.getSample(0, index) * 0.5f) < 1e-4f)
                        processed = true;
            }
        }
        if (!processed)
            juce::Thread::sleep(10);
    }
    if (!expect(processed, "Ring modulation audio, stereo or meter taps failed without an editor"))
        return false;
    const auto shapedPatch = patch.replace("\"ringModEnabled\":true",
        "\"ringModEnabled\":true,\"ringModPhase\":90,\"ringModBias\":0.2,\"ringModRectify\":0.5,\"ringModSpread\":1");
    if (!expect(processor.setPatchStateJson(shapedPatch), "Shaped ring modulation patch was rejected"))
        return false;
    bool spreadAudible = false;
    for (int attempt = 0; attempt < 300 && !spreadAudible; ++attempt) {
        midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(127)), 0);
        for (int block = 0; block < 40; ++block) {
            processor.processBlock(audio, midi);
            midi.clear();
            for (int index = 0; index < blockSize; ++index)
                if (std::abs(audio.getSample(0, index)) > 0.01f
                    && std::abs(audio.getSample(1, index) - audio.getSample(0, index) * 0.5f) > 0.001f)
                    spreadAudible = true;
        }
        if (!spreadAudible)
            juce::Thread::sleep(10);
    }
    if (!expect(spreadAudible, "Ring modulation spread did not affect native stereo audio"))
        return false;
    if (!expect(processor.setPatchStateJson(patch.replace("\"ringModEnabled\":true",
                                                        "\"ringModEnabled\":true,\"ringModMute\":true")),
                "Ring modulation mute patch was rejected"))
        return false;
    for (int attempt = 0; attempt < 300; ++attempt) {
        midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(127)), 0);
        for (int block = 0; block < 40; ++block) {
            processor.processBlock(audio, midi);
            midi.clear();
            const auto input = processor.takeEffectPeak(7);
            const auto output = processor.takeEffectPeak(8);
            if (input > 0.1f && std::abs(input - output) < 1e-6f)
                return true;
        }
        juce::Thread::sleep(10);
    }
    return expect(false, "Ring modulation mute did not bypass the effect and match its meter taps");
}

bool run()
{
    if (!testRingModulation())
        return false;
    for (const auto* profile : { "room", "plate", "chamber" })
        if (!testConvolution(44100.0, profile) || !testConvolution(48000.0, profile))
            return false;
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
            R"({"loadedPreset":"kick.lfpreset","uiTheme":"cyan-volt","uiBorderTrace":{"level":"subtle","speed":"fast"},"uiHelpSettings":{"hover":true,"dspInfo":false},"layers":[{"loaded":true,"sampleKey":"kick","sampleRightKey":"kick-right","sampleRate":44100,"sampleCount":4410,"envelopePoints":[{"time":0,"value":1},{"time":1,"value":1}]}],"noise":{"mute":true,"type":"brown","delayMs":150},"master":{"saturationType":"tube","saturationMute":true,"glueEnabled":true,"glueThreshold":-30,"glueRatio":8,"glueAttack":0.001}})"))
        return false;
    juce::MemoryBlock saved;
    source.getStateInformation(saved);

    LayerForgeAudioProcessor restored;
    restored.setRateAndBufferSizeDetails(sampleRate, blockSize);
    restored.prepareToPlay(sampleRate, blockSize);
    restored.setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
    auto* output = findParameter(restored, "master_outputDb");
    auto* pitch = findParameter(restored, "l0_pitch");
    auto* noiseDelay = findParameter(restored, "noise_delayMs");
    if (!expect(restored.getParameters().size() == 68 && output != nullptr && pitch != nullptr
                    && noiseDelay != nullptr,
                "Host parameter set is incomplete"))
        return false;
    if (!expect(std::abs(noiseDelay->convertFrom0to1(noiseDelay->getValue()) - 150.0f) < 1e-3f,
                "Noise start delay was not restored as a host parameter"))
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
    if (!expect(restoredState.getProperty("noise", {}).getProperty("type", {}).toString() == "brown"
                    && restoredState.getProperty("master", {}).getProperty("saturationType", {}).toString() == "tube",
                "Noise and saturation types were not preserved in host state"))
        return false;
    if (!expect(static_cast<bool>(restoredState.getProperty("master", {}).getProperty("saturationMute", false)),
                "Effect mute states were not preserved in host state"))
        return false;
    LayerForgeAudioProcessor mutedGlue;
    if (!mutedGlue.setPatchStateJson(R"({"master":{"glueEnabled":true,"glueMute":true}})"))
        return false;
    juce::MemoryBlock mutedState;
    mutedGlue.getStateInformation(mutedState);
    LayerForgeAudioProcessor reopenedMutedGlue;
    reopenedMutedGlue.setStateInformation(mutedState.getData(), static_cast<int>(mutedState.getSize()));
    if (!expect(static_cast<bool>(juce::JSON::parse(reopenedMutedGlue.getPatchStateJson())
                    .getProperty("master", {}).getProperty("glueMute", false)),
                "Compressor mute was not preserved in host state"))
        return false;
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
    const auto helpSettings = restoredState.getProperty("uiHelpSettings", {});
    if (!expect(static_cast<bool>(helpSettings.getProperty("hover", false))
                    && !static_cast<bool>(helpSettings.getProperty("dspInfo", true)),
                "Help settings were not preserved in host state"))
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
    if (!expect(std::abs(audio.getSample(0, 0)) > 1e-5f, "Native audition did not trigger"))
        return false;

    LayerForgeAudioProcessor delayedNoise;
    delayedNoise.setRateAndBufferSizeDetails(sampleRate, blockSize);
    if (!delayedNoise.setPatchStateJson(
            R"({"noise":{"enabled":true,"type":"brown","delayMs":80,"gain":1,"decay":0.075},"master":{"saturationEnabled":true,"saturationType":"tube"}})"))
        return false;
    delayedNoise.prepareToPlay(sampleRate, blockSize);
    bool delayedSound = false;
    for (int attempt = 0; attempt < 300 && !delayedSound; ++attempt) {
        for (int block = 0; block < 100; ++block) {
            midi.clear();
            delayedNoise.processBlock(audio, midi);
        }
        float earlyPeak = 0.0f, latePeak = 0.0f;
        for (int block = 0; block < 50; ++block) {
            midi.clear();
            if (block == 0)
                midi.addEvent(juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(127)), 0);
            delayedNoise.processBlock(audio, midi);
            for (int index = 0; index < blockSize; ++index) {
                const auto time = static_cast<double>(block * blockSize + index) / sampleRate;
                const auto value = std::abs(audio.getSample(0, index));
                if (time < 0.079)
                    earlyPeak = std::max(earlyPeak, value);
                else if (time >= 0.085 && time < 0.14)
                    latePeak = std::max(latePeak, value);
            }
        }
        delayedSound = latePeak > 1e-5f;
        if (delayedSound && !expect(earlyPeak < 1e-6f, "Native noise sounded before its delay"))
            return false;
        if (!delayedSound)
            juce::Thread::sleep(10);
    }
    return expect(delayedSound, "Native delayed brown noise with tube saturation produced no sound");
}
}

int main()
{
    return run() ? 0 : 1;
}
