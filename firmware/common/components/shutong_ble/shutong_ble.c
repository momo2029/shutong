#include "shutong_ble.h"

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_gap_ble_api.h"

static const char *TAG = "sht-ble";

// ─── Eddystone-URL 编码 ─────────────────────────────────
#define EDDYSTONE_URL_SCHEME 0x03  // https://
#define ADV_MAX 31

// ─── 全局状态 ───────────────────────────────────────────
static char     g_url_buf[128];
static uint8_t  g_adv_data[ADV_MAX];
static uint8_t  g_adv_data_len = 0;
static bool     g_initialized = false;
static bool     g_advertising = false;

// ─── Eddystone-URL 编码 ────────────────────────────────

static int eddystone_encode_url(const char *url, uint8_t *adv_data) {
    // 帧: [len][0x16][0xAA 0xFE][0x10][tx_power][scheme][url…]
    if (!url || !adv_data) return 0;

    const uint8_t *p = (const uint8_t *)url;
    int out = 7;

    adv_data[1] = 0x16;
    adv_data[2] = 0xAA;
    adv_data[3] = 0xFE;
    adv_data[4] = 0x10;  // URL frame
    adv_data[5] = 0xEE;  // TX power
    adv_data[6] = EDDYSTONE_URL_SCHEME;

    if (strncmp((const char *)p, "https://", 8) == 0) {
        p += 8;
    } else if (strncmp((const char *)p, "http://", 7) == 0) {
        p += 7;
        adv_data[6] = 0x02;
    }

    while (*p && out < ADV_MAX) {
        if      (strncmp((const char *)p, ".com/", 5) == 0) { adv_data[out++] = 0x00; p += 5; }
        else if (strncmp((const char *)p, ".org/", 5) == 0) { adv_data[out++] = 0x01; p += 5; }
        else if (strncmp((const char *)p, ".edu/", 5) == 0) { adv_data[out++] = 0x02; p += 5; }
        else if (strncmp((const char *)p, ".net/", 5) == 0) { adv_data[out++] = 0x03; p += 5; }
        else if (strncmp((const char *)p, ".info/",6) == 0) { adv_data[out++] = 0x04; p += 6; }
        else if (strncmp((const char *)p, ".com",  4) == 0 && p[4] != '/') { adv_data[out++] = 0x07; p += 4; }
        else if (strncmp((const char *)p, ".net",  4) == 0 && p[4] != '/') { adv_data[out++] = 0x09; p += 4; }
        else if (strncmp((const char *)p, ".org",  4) == 0 && p[4] != '/') { adv_data[out++] = 0x08; p += 4; }
        else { adv_data[out++] = *p++; }
    }

    if (*p != '\0') {
        ESP_LOGW(TAG, "URL too long: %s", url);
        return 0;
    }

    adv_data[0] = out - 1;
    return out;
}

// ─── GAP 回调 ──────────────────────────────────────────

static void gap_event_handler(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t *param) {
    switch (event) {
        case ESP_GAP_BLE_ADV_DATA_SET_COMPLETE_EVT:
            ESP_LOGI(TAG, "Advertising data set");
            esp_ble_gap_start_advertising(&(esp_ble_adv_params_t){
                .adv_int_min  = 0x320,
                .adv_int_max  = 0x400,
                .adv_type     = ADV_TYPE_NONCONN_IND,
                .channel_map  = ADV_CHNL_ALL,
                .own_addr_type = BLE_ADDR_TYPE_PUBLIC,
            });
            break;

        case ESP_GAP_BLE_ADV_START_COMPLETE_EVT:
            if (param->adv_start_cmpl.status == ESP_BT_STATUS_SUCCESS) {
                g_advertising = true;
                ESP_LOGI(TAG, "Advertising started — %s", g_url_buf);
            } else {
                ESP_LOGE(TAG, "Advertising start failed: %d", param->adv_start_cmpl.status);
            }
            break;

        case ESP_GAP_BLE_ADV_STOP_COMPLETE_EVT:
            g_advertising = false;
            ESP_LOGI(TAG, "Advertising stopped");
            break;

        default:
            break;
    }
}

// ─── 内部开始广播 ──────────────────────────────────────

static void start_advertising(void) {
    if (!g_initialized || g_advertising) return;
    if (g_adv_data_len == 0) return;
    esp_ble_gap_config_adv_data_raw(g_adv_data, g_adv_data_len);
}

// ─── 公共 API ─────────────────────────────────────────

void shutong_ble_init(void) {
    if (g_initialized) return;

    ESP_ERROR_CHECK(esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT));
    esp_bt_controller_config_t bt_cfg = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_bt_controller_init(&bt_cfg));
    ESP_ERROR_CHECK(esp_bt_controller_enable(ESP_BT_MODE_BLE));
    ESP_ERROR_CHECK(esp_bluedroid_init());
    ESP_ERROR_CHECK(esp_bluedroid_enable());
    ESP_ERROR_CHECK(esp_ble_gap_register_callback(gap_event_handler));
    ESP_ERROR_CHECK(esp_ble_gap_set_device_name("shutong"));

    g_initialized = true;
    ESP_LOGI(TAG, "BLE init OK, waiting for URL from server");
}

void shutong_ble_set_url(const char *url) {
    if (!url || !url[0]) return;
    if (!g_initialized) return;

    int len = eddystone_encode_url(url, g_adv_data);
    if (len == 0) {
        ESP_LOGE(TAG, "BLE URL encode failed: %s", url);
        return;
    }

    g_adv_data_len = len;
    strncpy(g_url_buf, url, sizeof(g_url_buf) - 1);
    g_url_buf[sizeof(g_url_buf) - 1] = '\0';

    ESP_LOGI(TAG, "BLE URL: %s (%d bytes)", url, len);

    if (g_advertising) {
        esp_ble_gap_stop_advertising();
        vTaskDelay(pdMS_TO_TICKS(100));
        esp_ble_gap_config_adv_data_raw(g_adv_data, g_adv_data_len);
    } else {
        start_advertising();
    }
}

void shutong_ble_stop(void) {
    if (!g_initialized || !g_advertising) return;
    esp_ble_gap_stop_advertising();
}

int shutong_ble_is_advertising(void) {
    return g_advertising;
}
