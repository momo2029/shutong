#pragma once
#include "esp_camera.h"

void shutong_camera_init(void);
camera_fb_t *shutong_camera_capture(void);
