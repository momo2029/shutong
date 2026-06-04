cmake_minimum_required(VERSION 3.16)

# Pick components from common/ directory
set(EXTRA_COMPONENT_DIRS
    ${CMAKE_SOURCE_DIR}/../common/components/shutong_wifi
    ${CMAKE_SOURCE_DIR}/../common/components/shutong_mqtt
    ${CMAKE_SOURCE_DIR}/../common/components/shutong_audio
    ${CMAKE_SOURCE_DIR}/../common/components/shutong_proto
)

if(CONFIG_SHUTONG_FLAGSHIP)
    list(APPEND EXTRA_COMPONENT_DIRS
        ${CMAKE_SOURCE_DIR}/../common/components/shutong_camera
    )
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(shutong)
