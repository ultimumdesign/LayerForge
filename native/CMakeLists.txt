cmake_minimum_required(VERSION 3.22)
project(LayerForge VERSION 0.1.0)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "Build universal macOS binary" FORCE)

# Add JUCE & Elementary C++ SDK submodules (bootstrapped via scripts/setup.sh)
add_subdirectory(third_party/JUCE)
add_subdirectory(third_party/elementary/runtime)

juce_add_plugin(LayerForge
    COMPANY_NAME "LayerForgeAudio"
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE
    PLUGIN_MANUFACTURER_CODE Lfrg
    PLUGIN_CODE Lf01
    FORMATS AU VST3
    PRODUCT_NAME "LayerForge"
)

# Bundle built Vite web UI assets into the plugin binary for commercial distribution
file(GLOB_RECURSE UI_DIST_FILES "${CMAKE_CURRENT_SOURCE_DIR}/../dist/*")
if(UI_DIST_FILES)
    juce_add_binary_data(LayerForgeUIAssets SOURCES ${UI_DIST_FILES})
    target_link_libraries(LayerForge PRIVATE LayerForgeUIAssets)
    target_compile_definitions(LayerForge PRIVATE HAS_EMBEDDED_UI=1)
endif()

target_sources(LayerForge PRIVATE
    PluginProcessor.cpp
    PluginProcessor.h
    PluginEditor.cpp
    PluginEditor.h
)

target_compile_definitions(LayerForge PUBLIC
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
)

target_link_libraries(LayerForge PRIVATE
    elem::runtime
    juce::juce_audio_utils
    juce::juce_gui_extra
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)
