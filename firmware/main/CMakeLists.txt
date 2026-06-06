idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES
        nvs_flash
        esp_wifi
        esp_event
        esp_http_server
        esp_https_ota
        app_update
        driver
        json
        mbedtls
        shutong_wifi
        shutong_mqtt
        shutong_audio
        shutong_proto
        shutong_camera
)

if(CONFIG_SHUTONG_FLAGSHIP)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE CONFIG_SHUTONG_FLAGSHIP=1)
endif()
