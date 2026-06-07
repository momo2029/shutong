idf_component_register(
    SRCS "shutong_sdcard.c"
    INCLUDE_DIRS "."
    REQUIRES fatfs sdmmc esp_driver_sdspi esp_driver_spi driver
)
