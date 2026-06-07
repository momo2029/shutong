#include "shutong_sdcard.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"
#include "driver/sdspi_host.h"
#include "driver/spi_common.h"
#include "ff.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>

static const char *TAG = "sht-sdcard";

// DFR1154 TF card SPI pins
#define PIN_CS      GPIO_NUM_10
#define PIN_MOSI    GPIO_NUM_11
#define PIN_MISO    GPIO_NUM_13
#define PIN_SCLK    GPIO_NUM_12

static sdmmc_card_t *s_card = NULL;
static bool s_mounted = false;

esp_err_t shutong_sdcard_init(void) {
  if (s_mounted) {
    ESP_LOGW(TAG, "SD card already mounted");
    return ESP_OK;
  }

  esp_err_t ret;

  // Mount config: no auto-format, max 5 open files
  esp_vfs_fat_sdmmc_mount_config_t mount_config = {
    .format_if_mount_failed = false,
    .max_files = 5,
    .allocation_unit_size = 16 * 1024,
  };

  // SDSPI host default (SPI2_HOST = VSPI)
  sdmmc_host_t host = SDSPI_HOST_DEFAULT();
  host.slot = SPI2_HOST;  // explicit

  // SPI bus config
  spi_bus_config_t bus_cfg = {
    .mosi_io_num = PIN_MOSI,
    .miso_io_num = PIN_MISO,
    .sclk_io_num = PIN_SCLK,
    .quadwp_io_num = -1,
    .quadhd_io_num = -1,
    .max_transfer_sz = 4000,
  };

  ret = spi_bus_initialize(host.slot, &bus_cfg, SDSPI_DEFAULT_DMA);
  if (ret != ESP_OK) {
    ESP_LOGE(TAG, "SPI bus init failed: %s", esp_err_to_name(ret));
    return ret;
  }

  // SDSPI slot config
  sdspi_device_config_t slot_config = SDSPI_DEVICE_CONFIG_DEFAULT();
  slot_config.gpio_cs = PIN_CS;
  slot_config.host_id = host.slot;

  // Mount
  ret = esp_vfs_fat_sdspi_mount(SD_MOUNT_POINT, &host, &slot_config,
                                &mount_config, &s_card);
  if (ret != ESP_OK) {
    ESP_LOGE(TAG, "Mount failed: %s", esp_err_to_name(ret));
    spi_bus_free(host.slot);
    return ret;
  }

  s_mounted = true;
  shutong_sdcard_print_info();

  // Ensure rec/ directory exists
  char dir[64];
  snprintf(dir, sizeof(dir), SD_MOUNT_POINT "/rec");
  mkdir(dir, 0777);

  ESP_LOGI(TAG, "SD card ready at " SD_MOUNT_POINT);
  return ESP_OK;
}

esp_err_t shutong_sdcard_deinit(void) {
  if (!s_mounted) return ESP_OK;

  esp_err_t ret = esp_vfs_fat_sdcard_unmount(SD_MOUNT_POINT, s_card);
  if (ret != ESP_OK) {
    ESP_LOGE(TAG, "Unmount failed: %s", esp_err_to_name(ret));
    return ret;
  }

  spi_bus_free(SPI2_HOST);
  s_card = NULL;
  s_mounted = false;
  ESP_LOGI(TAG, "SD card unmounted");
  return ESP_OK;
}

bool shutong_sdcard_mounted(void) {
  return s_mounted;
}

bool shutong_sdcard_space(uint64_t *total_bytes, uint64_t *free_bytes) {
  if (!s_mounted || !s_card) return false;

  FATFS *fs;
  DWORD free_clusters;
  char drv[3] = {SD_MOUNT_POINT[1], ':', 0}; // "/sdcard" → "0:"
  f_getfree(drv, &free_clusters, &fs);

  uint64_t sector_size = s_card->csd.sector_size;
  uint64_t total_sectors = s_card->csd.capacity;
  *total_bytes = total_sectors * sector_size;

  uint64_t free_sectors = free_clusters * fs->csize;
  *free_bytes = free_sectors * sector_size;

  return true;
}

void shutong_sdcard_print_info(void) {
  if (s_card) {
    sdmmc_card_print_info(stdout, s_card);
  }
}

char *shutong_sdcard_path(const char *note_id, const char *type, int seq) {
  // Format: /sdcard/rec/{note_id}/{type}_{seq}.dat
  // Max: len("/sdcard/rec/") + 36 + len("/") + 10 + len("_") + 10 + len(".dat") + 1
  //    ≈ 12 + 36 + 1 + 10 + 1 + 10 + 4 + 1 = 75
  char *path = malloc(128);
  if (!path) return NULL;

  // Ensure rec/{note_id} directory exists
  char dir[96];
  snprintf(dir, sizeof(dir), SD_MOUNT_POINT "/rec/%s", note_id);
  mkdir(dir, 0777);

  snprintf(path, 128, SD_MOUNT_POINT "/rec/%s/%s_%d.dat", note_id, type, seq);
  return path;
}
