#pragma once

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void shutong_speaker_init(void);
void shutong_speaker_play_boot(void);
void shutong_speaker_play_ap_mode(void);
void shutong_speaker_play_wifi_connected(void);
void shutong_speaker_play_short_prompt(void);
void shutong_speaker_play_shutter(void);
void shutong_speaker_play_pcm(const uint8_t *pcm_data, uint32_t pcm_size);

// Set volume: 0.0 (mute) ~ 1.0 (full). Default 0.25.
void shutong_speaker_set_volume(float vol);

void shutong_speaker_deinit(void);

#ifdef __cplusplus
}
#endif
