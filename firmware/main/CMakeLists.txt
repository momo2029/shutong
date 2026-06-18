idf_component_register(
    SRCS "main.cpp"
         "boards/shutong-s3/button.cc"
    INCLUDE_DIRS "."
                 "boards/shutong-s3"
    REQUIRES
        nvs_flash
        driver
        json
        mbedtls
        shutong_mqtt
        shutong_proto
        shutong_camera
        shutong_sdcard
        shutong_audio
        shutong_speaker
        shutong_ble
        shutong_detect
        78__esp-wifi-connect
        espressif__button
        esp_http_server
        esp_timer
        esp_https_ota
)

if(CONFIG_SHUTONG_FLAGSHIP)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE CONFIG_SHUTONG_FLAGSHIP=1)
endif()

target_compile_definitions(${COMPONENT_LIB} PRIVATE FW_VERSION="${PROJECT_VER}")
