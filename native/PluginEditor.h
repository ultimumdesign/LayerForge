#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginClipboard.h"
#include "PluginProcessor.h"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

class LayerForgeAudioProcessorEditor : public juce::AudioProcessorEditor,
                                      private juce::Timer
{
public:
    explicit LayerForgeAudioProcessorEditor(LayerForgeAudioProcessor&);
    ~LayerForgeAudioProcessorEditor() override;

    void resized() override;

private:
    void timerCallback() override;
    struct PendingSampleTransfer
    {
        size_t expectedSampleCount = 0;
        double sampleRate = 44100.0;
        std::vector<float> samples;
    };

    struct PendingWavTransfer
    {
        size_t expectedByteCount = 0;
        juce::String filename;
        std::vector<std::uint8_t> bytes;
    };

    void saveStagedWav(const std::string& key);
    void chooseSample(const juce::String& requestId, bool locationOnly);
    void sendSampleFile(const juce::String& requestId, const juce::File& file);
    void exportPreset(const juce::String& payloadJson);
    void listPresets(const juce::String& requestId);
    void loadPreset(const juce::String& requestId, const juce::String& filename, std::uint64_t revision);
    void applyReferencePreset(const juce::String& requestId, const juce::String& filename,
                              std::uint64_t revision, const juce::Array<juce::var>& samples);
    void deletePreset(const juce::String& filename);
    void writePresetFile(const juce::File& destination,
                         const juce::String& stateJson,
                         const std::vector<LayerForgeAudioProcessor::StoredSample>& samples,
                         const juce::Array<juce::var>& references,
                         const juce::String& requestId);

    LayerForgeAudioProcessor& audioProcessor;
    std::unique_ptr<juce::WebBrowserComponent> webView;
    bool editorReady = false;
    bool autoHeightEnabled = true;
    bool applyingAutomaticHeight = false;
    int traceGeneration = 0;
    bool traceEnabled = false;
    std::uint64_t lastStateRevision = 0;
    std::vector<float> lastParameterValues;
    std::vector<std::uint64_t> lastEditorParameterSequences;
    std::unique_ptr<juce::FileChooser> fileChooser;
    bool fileChooserActive = false;
    std::unordered_map<std::string, PendingSampleTransfer> pendingSampleTransfers;
    std::unordered_map<std::string, PendingWavTransfer> pendingWavTransfers;
    std::unordered_map<std::string, layerforge::WavDataPtr> stagedWavs;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(LayerForgeAudioProcessorEditor)
};
