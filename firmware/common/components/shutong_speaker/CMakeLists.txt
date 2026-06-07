idf_component_register(
  SRCS "shutong_speaker.c"
  INCLUDE_DIRS "."
  REQUIRES driver esp_driver_i2s
  EMBED_FILES
    "audio_src/boot.pcm"
    "audio_src/ap_mode.pcm"
    "audio_src/wifi_connected.pcm"
)
