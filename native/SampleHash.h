#pragma once

#include <juce_cryptography/juce_cryptography.h>

inline juce::String hashSampleStream(juce::InputStream& input)
{
    juce::BufferedInputStream buffered(input, 65536);
    return juce::SHA256(buffered).toHexString();
}

inline bool hashSampleFile(const juce::File& file, juce::String& hash)
{
    juce::FileInputStream input(file);
    if (!input.openedOk())
        return false;
    hash = hashSampleStream(input);
    return input.getStatus().wasOk();
}
