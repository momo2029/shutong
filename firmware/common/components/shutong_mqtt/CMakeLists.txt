idf_component_register(
    SRCS "shutong_mqtt.c" "hmac_util.c"
    INCLUDE_DIRS "."
    REQUIRES mqtt json mbedtls nvs_flash
)
