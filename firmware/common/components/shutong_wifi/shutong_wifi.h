#pragma once
#include "esp_wifi.h"
#include "esp_event.h"
#include <stdbool.h>

// Init WiFi: try NVS credentials -> default -> AP fallback
void shutong_wifi_init(void);

// Blocking connect with 15s timeout, saves to NVS on success
bool shutong_wifi_connect(const char *ssid, const char *pass);

// Non-blocking: store credentials, set pending flag for main loop
void shutong_wifi_request_connect(const char *ssid, const char *pass);

// Check if pending connect request exists
bool shutong_wifi_has_pending(void);

// Process pending connect (call from main loop, NOT from HTTP handler)
void shutong_wifi_process_pending(void);

// Getters
bool shutong_wifi_is_connected(void);
int  shutong_wifi_rssi(void);
char *shutong_wifi_get_ip(void);

// Start AP mode for provisioning
void shutong_wifi_start_ap(void);
