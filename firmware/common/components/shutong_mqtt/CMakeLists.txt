idf_component_register(
    SRCS "shutong_mqtt.c"
    INCLUDE_DIRS "."
    REQUIRES mqtt json mbedtls nvs_flash
)
