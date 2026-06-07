#include "shutong_detect.h"
#include "esp_log.h"
#include "jpeg_decoder.h"
#include "esp_heap_caps.h"
#include <stdlib.h>
#include <string.h>
#include <cstdlib>

static const char *TAG = "sht-detect";

// 检测分辨率：VGA(640×480) → scale 1/4 → 160×120
#define DETECT_W  160
#define DETECT_H  120
#define DETECT_PX (DETECT_W * DETECT_H)

// 帧差阈值
#define DIFF_PIXEL_RATIO  0.04f   // 差异像素比例超过 4% 算变化
#define DIFF_THRESHOLD    40      // 单像素灰度差值阈值

// 上一帧灰度图缓冲区
static uint8_t *s_prev_gray = nullptr;

// RGB888 缓冲区
static uint8_t *s_rgb_buf = nullptr;

// ─── 初始化 ─────────────────────────────────────────────
void shutong_detect_init(void) {
    s_prev_gray = (uint8_t*)heap_caps_calloc(1, DETECT_PX, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_prev_gray) {
        s_prev_gray = (uint8_t*)calloc(1, DETECT_PX);
    }

    s_rgb_buf = (uint8_t*)heap_caps_calloc(1, DETECT_PX * 3, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_rgb_buf) {
        s_rgb_buf = (uint8_t*)calloc(1, DETECT_PX * 3);
    }

    ESP_LOGI(TAG, "Detect init OK (%dx%d)", DETECT_W, DETECT_H);
}

// ─── 解码 JPEG 到 160×120 RGB888 ────────────────────────
static bool decode_to_rgb(const uint8_t *jpeg, size_t jpeg_len) {
    if (!s_rgb_buf) return false;

    esp_jpeg_image_cfg_t cfg = {
        .indata   = (uint8_t*)jpeg,
        .indata_size = jpeg_len,
        .outbuf   = s_rgb_buf,
        .outbuf_size = DETECT_PX * 3,
        .out_format  = JPEG_IMAGE_FORMAT_RGB888,
        .out_scale   = JPEG_IMAGE_SCALE_1_4,  // VGA 640×480 → 160×120
    };

    esp_jpeg_image_output_t out;
    esp_err_t err = esp_jpeg_decode(&cfg, &out);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "JPEG decode failed: %d", err);
        return false;
    }

    return true;
}

// ─── 帧差检测 ────────────────────────────────────────────
bool shutong_detect_frame_diff(const uint8_t *jpeg, size_t jpeg_len) {
    if (!s_prev_gray || !s_rgb_buf) return false;

    if (!decode_to_rgb(jpeg, jpeg_len)) return true; // 解码失败放行

    int diff_count = 0;
    int total = DETECT_PX;

    for (int i = 0; i < total; i++) {
        int idx = i * 3;
        uint8_t gray = s_rgb_buf[idx + 1]; // G 通道近似灰度
        int diff = abs((int)gray - (int)s_prev_gray[i]);
        if (diff > DIFF_THRESHOLD) {
            diff_count++;
        }
        s_prev_gray[i] = gray;
    }

    float ratio = (float)diff_count / (float)total;
    bool changed = (ratio > DIFF_PIXEL_RATIO);

    if (changed) {
        ESP_LOGD(TAG, "Frame changed: %.1f%% pixels diff", ratio * 100);
    }

    return changed;
}

// ─── 人脸检测 ────────────────────────────────────────────
// 当前未接入 ESP-WHO，始终返回 true（只做帧差过滤）
bool shutong_detect_has_face(const uint8_t *jpeg, size_t jpeg_len) {
    (void)jpeg;
    (void)jpeg_len;
    return true;
}

// ─── 重置参考帧 ──────────────────────────────────────────
void shutong_detect_reset(void) {
    if (s_prev_gray) {
        memset(s_prev_gray, 0, DETECT_PX);
    }
    ESP_LOGD(TAG, "Frame diff reference reset");
}
