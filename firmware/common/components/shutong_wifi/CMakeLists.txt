idf_component_register(
    SRCS "shutong_wifi.c"
    INCLUDE_DIRS "."
    REQUIRES nvs_flash esp_wifi esp_event
)
