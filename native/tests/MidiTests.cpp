#include "../PluginProcessor.h"

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

bool run()
{
    constexpr int blockSize = 128;
    constexpr double sampleRate = 44100.0;
    LayerForgeAudioProcessor source;
    std::vector<float> sample(4410, 0.5f);
    sample[1] = -0.5f;
    source.storeSampleResource("kick", sample, sampleRate);
    if (!source.setPatchStateJson(
            R"({"layers":[{"loaded":true,"sampleKey":"kick","sampleRate":44100,"sampleCount":4410,"envelopePoints":[{"time":0,"value":1},{"time":1,"value":1}]}],"noise":{"mute":true}})"))
        return false;
    juce::MemoryBlock saved;
    source.getStateInformation(saved);

    LayerForgeAudioProcessor restored;
    restored.setRateAndBufferSizeDetails(sampleRate, blockSize);
    restored.prepareToPlay(sampleRate, blockSize);
    restored.setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));
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
    const auto fullVelocityOnset = std::abs(audio.getSample(0, 47));

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
