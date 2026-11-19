#pragma once

#include "Convolve.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

namespace layerforge
{
inline std::vector<float> makeImpulse(double duration, double decay, std::uint32_t seed)
{
    constexpr double rate = 44100.0;
    std::vector<float> samples(static_cast<size_t>(std::lround(duration * rate)));
    double total = 0.0;
    for (size_t i = 0; i < samples.size(); ++i) {
        seed = seed * 1664525u + 1013904223u;
        const auto noise = static_cast<double>(seed) / 2147483648.0 - 1.0;
        samples[i] = static_cast<float>(noise * std::exp(-decay * static_cast<double>(i) / rate));
        total += static_cast<double>(samples[i]) * samples[i];
    }
    const auto gain = 0.65 / std::sqrt(total);
    for (auto& sample : samples)
        sample = static_cast<float>(sample * gain);
    samples[0] += 0.25f;
    return samples;
}

class ConvolutionNode : public elem::ConvolutionNode<float>
{
public:
    using elem::ConvolutionNode<float>::ConvolutionNode;

    int setProperty(const std::string& key, const elem::js::Value& value,
                    elem::SharedResourceMap& resources) override
    {
        if (key != "path")
            return elem::GraphNode<float>::setProperty(key, value);
        if (!value.isString())
            return elem::ReturnCode::InvalidPropertyType();
        const auto path = static_cast<elem::js::String>(value);
        if (!preparedPath.empty())
            return path == preparedPath
                ? elem::GraphNode<float>::setProperty(key, value)
                : elem::ReturnCode::InvalidPropertyValue();
        if (path.rfind("lf_ir_", 0) != 0 || !resources.has(path))
            return elem::ReturnCode::InvalidPropertyValue();
        const auto separator = path.find('_', 6);
        if (separator == std::string::npos)
            return elem::ReturnCode::InvalidPropertyValue();
        const auto rateText = path.substr(6, separator - 6);
        if (rateText.empty() || rateText.find_first_not_of("0123456789") != std::string::npos)
            return elem::ReturnCode::InvalidPropertyValue();
        const auto sourceRate = std::strtod(rateText.c_str(), nullptr);
        if (sourceRate <= 0.0 || sourceRate > 768000.0)
            return elem::ReturnCode::InvalidPropertyValue();
        const auto resource = resources.get(path);
        if (!resource)
            return elem::ReturnCode::InvalidPropertyValue();
        auto input = resource->getChannelData(0);
        if (input.size() == 0)
            return elem::ReturnCode::InvalidPropertyValue();
        const auto targetRate = getSampleRate();
        const auto ratio = sourceRate / targetRate;
        const auto cutoff = std::min(1.0, targetRate / sourceRate);
        const auto length = static_cast<size_t>(std::ceil(static_cast<double>(input.size()) / ratio));
        std::vector<float> impulse(length);
        constexpr int radius = 16;
        constexpr double pi = 3.14159265358979323846;
        for (size_t i = 0; i < length; ++i) {
            const auto position = static_cast<double>(i) * ratio;
            const auto center = static_cast<long long>(std::floor(position));
            double sum = 0.0;
            double weightSum = 0.0;
            for (auto tap = center - radius + 1; tap <= center + radius; ++tap) {
                const auto distance = position - static_cast<double>(tap);
                const auto x = pi * cutoff * distance;
                const auto sinc = x == 0.0 ? 1.0 : std::sin(x) / x;
                const auto weight = cutoff * sinc * (0.5 + 0.5 * std::cos(pi * distance / radius));
                if (tap >= 0 && static_cast<size_t>(tap) < input.size())
                    sum += input[static_cast<size_t>(tap)] * weight;
                weightSum += weight;
            }
            impulse[i] = static_cast<float>(weightSum != 0.0 ? ratio * sum / weightSum : 0.0);
        }
        auto convolver = std::make_shared<fftconvolver::TwoStageFFTConvolver>();
        if (!convolver->init(512, 4096, impulse.data(), impulse.size()))
            return elem::ReturnCode::InvalidPropertyValue();
        if (!convolverQueue.push(std::move(convolver)))
            return elem::ReturnCode::InvalidPropertyValue();
        preparedPath = path;
        return elem::GraphNode<float>::setProperty(key, value);
    }

private:
    std::string preparedPath;
};
}
