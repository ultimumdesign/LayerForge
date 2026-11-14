cmake_minimum_required(VERSION 3.22)
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../package.json" LAYERFORGE_PACKAGE_JSON)
string(JSON LAYERFORGE_VERSION GET "${LAYERFORGE_PACKAGE_JSON}" version)
project(LayerForge VERSION "${LAYERFORGE_VERSION}")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(APPLE)
    set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "Build universal macOS binary" FORCE)
endif()

# Add JUCE & Elementary C++ SDK submodules (bootstrapped via scripts/setup.sh)
add_subdirectory(third_party/JUCE)
add_subdirectory(third_party/elementary/runtime)

set(LAYERFORGE_PLUGIN_FORMATS VST3)
set(LAYERFORGE_PLATFORM_PLUGIN_OPTIONS)
set(LAYERFORGE_PLATFORM_COMPILE_DEFINITIONS)
if(APPLE)
    list(APPEND LAYERFORGE_PLUGIN_FORMATS AU)
elseif(WIN32)
    list(APPEND LAYERFORGE_PLATFORM_PLUGIN_OPTIONS NEEDS_WEBVIEW2 TRUE)
    list(APPEND LAYERFORGE_PLATFORM_COMPILE_DEFINITIONS
        JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
    )
endif()

juce_add_plugin(LayerForge
    COMPANY_NAME "LayerForgeAudio"
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE
    PLUGIN_MANUFACTURER_CODE Lfrg
    PLUGIN_CODE Lf01
    FORMATS ${LAYERFORGE_PLUGIN_FORMATS}
    PRODUCT_NAME "LayerForge"
    ${LAYERFORGE_PLATFORM_PLUGIN_OPTIONS}
)

# Bundle the production UI assets into the plug-in.
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

if(APPLE)
    target_sources(LayerForge PRIVATE PluginClipboard_mac.mm PluginClipboard.h)
elseif(WIN32)
    target_sources(LayerForge PRIVATE PluginClipboard_win.cpp PluginClipboard.h)
endif()

target_compile_definitions(LayerForge PUBLIC
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    ${LAYERFORGE_PLATFORM_COMPILE_DEFINITIONS}
)

target_link_libraries(LayerForge PRIVATE
    elem::runtime
    juce::juce_audio_utils
    juce::juce_gui_extra
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)
