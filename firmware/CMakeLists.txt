cmake_minimum_required(VERSION 3.16)

# Pick components
set(EXTRA_COMPONENT_DIRS
    ${CMAKE_SOURCE_DIR}/common/components/shutong_mqtt
    ${CMAKE_SOURCE_DIR}/common/components/shutong_proto
    ${CMAKE_SOURCE_DIR}/common/components/shutong_camera
    ${CMAKE_SOURCE_DIR}/common/components/shutong_sdcard
    ${CMAKE_SOURCE_DIR}/common/components/shutong_audio
    ${CMAKE_SOURCE_DIR}/common/components/shutong_speaker
    ${CMAKE_SOURCE_DIR}/common/components/shutong_detect
    ${CMAKE_SOURCE_DIR}/external_components/78__esp-wifi-connect
    ${CMAKE_SOURCE_DIR}/external_components/espressif__button
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(shutong)
