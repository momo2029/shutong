idf_component_register(
    SRCS "shutong_camera.c" "shutong_camera_stream.c"
    INCLUDE_DIRS "."
    REQUIRES esp32-camera esp_http_server driver freertos
)
