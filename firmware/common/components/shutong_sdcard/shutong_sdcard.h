#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// DFR1154 TF card: SPI mode, CS=GPIO10
// SPI: MOSI=11, MISO=12, SCLK=13
#define SD_MOUNT_POINT "/sdcard"

// Initialize SD card and mount FAT filesystem
esp_err_t shutong_sdcard_init(void);

// Unmount and deinitialize
esp_err_t shutong_sdcard_deinit(void);

// Check if SD card is mounted and accessible
bool shutong_sdcard_mounted(void);

// Get total and free space in bytes, returns false if not mounted
bool shutong_sdcard_space(uint64_t *total_bytes, uint64_t *free_bytes);

// Print card info to console
void shutong_sdcard_print_info(void);

// Create a recording file path (allocates string, caller must free)
// Format: /sdcard/rec/{note_id}/{type}_{seq}.dat
// Returns NULL on error
char *shutong_sdcard_path(const char *note_id, const char *type, int seq);

#ifdef __cplusplus
}
#endif
