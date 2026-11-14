#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

class LayerForgeAudioProcessorEditor : public juce::AudioProcessorEditor
{
public:
    explicit LayerForgeAudioProcessorEditor(LayerForgeAudioProcessor&);
    ~LayerForgeAudioProcessorEditor() override;

    void resized() override;

private:
    struct PendingSampleTransfer
    {
        size_t expectedSampleCount = 0;
        std::vector<float> samples;
    };

    struct PendingWavTransfer
    {
        size_t expectedByteCount = 0;
        juce::String filename;
        std::vector<std::uint8_t> bytes;
    };

    LayerForgeAudioProcessor& audioProcessor;
    std::unique_ptr<juce::WebBrowserComponent> webView;
    std::unordered_map<std::string, PendingSampleTransfer> pendingSampleTransfers;
    std::unordered_map<std::string, PendingWavTransfer> pendingWavTransfers;
    std::unordered_map<std::string, juce::File> stagedWavFiles;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(LayerForgeAudioProcessorEditor)
};
