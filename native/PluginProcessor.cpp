#include "PluginProcessor.h"
#include "PluginEditor.h"

LayerForgeAudioProcessor::LayerForgeAudioProcessor()
    : AudioProcessor(BusesProperties()
          .withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
}

LayerForgeAudioProcessor::~LayerForgeAudioProcessor() = default;

void LayerForgeAudioProcessor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    runtime = std::make_unique<elem::Runtime<float>>(sampleRate, samplesPerBlock);
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
    // Serialize active patch JSON state for Ableton Live project recall
    juce::ignoreUnused(destData);
}

void LayerForgeAudioProcessor::setStateInformation(const void* data, int sizeInBytes)
{
    juce::ignoreUnused(data, sizeInBytes);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new LayerForgeAudioProcessor();
}
