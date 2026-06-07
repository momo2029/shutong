#pragma once
#include "esp_camera.h"

// Init camera for blackboard capture (UXGA, PSRAM, exposure tuned)
void shutong_camera_init(void);

// Capture a single JPEG frame. Returns NULL on failure.
// Caller MUST call shutong_camera_return() when done with the buffer.
camera_fb_t *shutong_camera_capture(void);

// Return the frame buffer after processing
void shutong_camera_return(camera_fb_t *fb);

void shutong_camera_stream_start(void);
