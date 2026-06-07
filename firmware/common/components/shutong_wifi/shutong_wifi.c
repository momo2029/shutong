#include "shutong_wifi.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "nvs_flash.h"
#include "freertos/event_groups.h"
#include "lwip/sockets.h"
#include "cJSON.h"
#include <string.h>

static const char *TAG = "sht-wifi";
static EventGroupHandle_t s_evt;
static bool s_connected = false;
static char s_ip[16] = {0};
static int s_rssi = 0;
static int s_dns_fd = -1;

// Global scan cache populated by shutong_wifi_start_ap() before switching to AP mode
cJSON *s_prov_scan_cache = NULL;

// Pending connect pattern (producer-consumer, avoids event loop deadlock)
static volatile bool s_connect_pending = false;
static char s_pending_ssid[33];
static char s_pending_pass[65];

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1

static void event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
  if (base == WIFI_EVENT) {
    if (id == WIFI_EVENT_STA_START) {
      esp_wifi_connect();
    } else if (id == WIFI_EVENT_STA_DISCONNECTED) {
      s_connected = false;
      s_ip[0] = '\0';
      xEventGroupSetBits(s_evt, WIFI_FAIL_BIT);
    }
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
    snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&ev->ip_info.ip));
    s_connected = true;
    esp_wifi_set_ps(WIFI_PS_NONE);
    ESP_LOGI(TAG, "STA IP: %s", s_ip);
    xEventGroupSetBits(s_evt, WIFI_CONNECTED_BIT);
  }
}

static void nvs_save_creds(const char *ssid, const char *pass) {
  nvs_handle_t h;
  if (nvs_open("wifi", NVS_READWRITE, &h) == ESP_OK) {
    nvs_set_str(h, "ssid", ssid);
    nvs_set_str(h, "pass", pass);
    nvs_commit(h);
    nvs_close(h);
  }
}

void shutong_wifi_init(void) {
  nvs_flash_init();
  s_evt = xEventGroupCreate();

  esp_netif_init();
  esp_event_loop_create_default();
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  esp_wifi_init(&cfg);

  esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, event_handler, NULL, NULL);
  esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, event_handler, NULL, NULL);

  esp_wifi_set_mode(WIFI_MODE_STA);

  // Try NVS saved credentials
  nvs_handle_t h;
  char ssid[33] = {0}, pass[65] = {0};
  size_t len = sizeof(ssid);
  if (nvs_open("wifi", NVS_READONLY, &h) == ESP_OK) {
    nvs_get_str(h, "ssid", ssid, &len);
    len = sizeof(pass);
    nvs_get_str(h, "pass", pass, &len);
    nvs_close(h);
  }

  if (ssid[0]) {
    ESP_LOGI(TAG, "Trying saved: %s", ssid);
    if (shutong_wifi_connect(ssid, pass)) return;
  }

  // Fallback: default credentials
  ESP_LOGI(TAG, "Trying default credentials...");
  if (shutong_wifi_connect("13", "333666999")) return;

  // AP mode fallback
  ESP_LOGI(TAG, "Starting AP provisioning mode");
  shutong_wifi_start_ap();
}

bool shutong_wifi_connect(const char *ssid, const char *pass) {
  s_evt = s_evt ? s_evt : xEventGroupCreate();
  xEventGroupClearBits(s_evt, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);

  wifi_config_t cfg = {0};
  strncpy((char *)cfg.sta.ssid, ssid, 32);
  strncpy((char *)cfg.sta.password, pass, 64);
  cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

  esp_wifi_set_config(WIFI_IF_STA, &cfg);
  esp_wifi_start();

  EventBits_t bits = xEventGroupWaitBits(s_evt, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
                                          pdFALSE, pdFALSE, pdMS_TO_TICKS(15000));
  if (bits & WIFI_CONNECTED_BIT) {
    nvs_save_creds(ssid, pass);
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    esp_netif_set_hostname(netif, "shutong");
    return true;
  }
  esp_wifi_stop();
  return false;
}

void shutong_wifi_request_connect(const char *ssid, const char *pass) {
  strncpy(s_pending_ssid, ssid, 32);
  strncpy(s_pending_pass, pass, 64);
  s_connect_pending = true;
}

bool shutong_wifi_has_pending(void) { return s_connect_pending; }

void shutong_wifi_process_pending(void) {
  if (!s_connect_pending) return;
  s_connect_pending = false;
  ESP_LOGI(TAG, "Processing pending connect: %s", s_pending_ssid);
  if (shutong_wifi_connect(s_pending_ssid, s_pending_pass)) {
    ESP_LOGI(TAG, "Connected, restarting app...");
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
  }
}

// DNS server task for captive portal
static void dns_server_task(void *arg) {
  uint32_t gateway_ip = (uint32_t)(uintptr_t)arg;
  char buf[512];

  s_dns_fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (s_dns_fd < 0) {
    ESP_LOGE(TAG, "DNS socket failed");
    vTaskDelete(NULL);
    return;
  }

  struct sockaddr_in srv = {0};
  srv.sin_family = AF_INET;
  srv.sin_port = htons(53);
  srv.sin_addr.s_addr = htonl(INADDR_ANY);

  if (bind(s_dns_fd, (struct sockaddr *)&srv, sizeof(srv)) < 0) {
    ESP_LOGE(TAG, "DNS bind failed");
    close(s_dns_fd);
    s_dns_fd = -1;
    vTaskDelete(NULL);
    return;
  }

  ESP_LOGI(TAG, "DNS server started");

  while (1) {
    struct sockaddr_in client;
    socklen_t len = sizeof(client);
    int n = recvfrom(s_dns_fd, buf, sizeof(buf), 0, (struct sockaddr *)&client, &len);
    if (n < 12) continue;

    // Build DNS response: all queries return gateway IP
    buf[2] |= 0x80; // Response flag
    buf[3] |= 0x80; // Recursion available
    buf[7] = 1;     // 1 answer

    // Answer section
    memcpy(&buf[n], "\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x1c\x00\x04", 12);
    n += 12;
    memcpy(&buf[n], &gateway_ip, 4);
    n += 4;

    sendto(s_dns_fd, buf, n, 0, (struct sockaddr *)&client, len);
  }
}

void shutong_wifi_start_ap(void) {
  // Scan nearby APs while WiFi is still stopped (mode preserved as STA)
  wifi_ap_record_t s_scan_aps[32];
  uint16_t s_scan_count = 32;

  esp_wifi_set_mode(WIFI_MODE_STA);
  esp_wifi_start();
  // Will stop and restart in AP mode below, so just scan briefly
  wifi_scan_config_t scan_cfg = { .show_hidden = false, .scan_type = WIFI_SCAN_TYPE_ACTIVE };
  esp_wifi_scan_start(&scan_cfg, true);
  esp_wifi_scan_get_ap_records(&s_scan_count, s_scan_aps);
  esp_wifi_stop();

  // Build cached scan results for provisioning server
  extern cJSON *s_prov_scan_cache;
  if (s_prov_scan_cache) cJSON_Delete(s_prov_scan_cache);
  s_prov_scan_cache = cJSON_CreateArray();
  for (int i = 0; i < s_scan_count; i++) {
    if (strlen((char *)s_scan_aps[i].ssid) == 0) continue;
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "ssid", (char *)s_scan_aps[i].ssid);
    cJSON_AddNumberToObject(o, "rssi", s_scan_aps[i].rssi);
    cJSON_AddBoolToObject(o, "secure", s_scan_aps[i].authmode != WIFI_AUTH_OPEN);
    cJSON_AddItemToArray(s_prov_scan_cache, o);
  }

  // Now switch to pure AP mode
  esp_netif_t *ap_netif = esp_netif_create_default_wifi_ap();
  esp_wifi_set_mode(WIFI_MODE_AP);
  wifi_config_t ap_cfg = {
    .ap = {
      .ssid = "shutong-Setup",
      .ssid_len = 0,
      .password = "",
      .channel = 1,
      .authmode = WIFI_AUTH_OPEN,
      .max_connection = 4,
    },
  };
  esp_wifi_set_config(WIFI_IF_AP, &ap_cfg);
  esp_wifi_start();
  ESP_LOGI(TAG, "AP: shutong-Setup (open)");


  // Start DNS server for captive portal (192.168.4.1)
  esp_netif_t *ap_nf = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
  uint32_t gw_ip = 0;
  if (ap_nf) {
    esp_netif_ip_info_t ip;
    esp_netif_get_ip_info(ap_nf, &ip);
    gw_ip = ip.gw.addr;
  }
  xTaskCreate(dns_server_task, "dns", 4096, (void *)(uintptr_t)gw_ip, 5, NULL);
}

bool shutong_wifi_is_connected(void) { return s_connected; }
int  shutong_wifi_rssi(void) {
  wifi_ap_record_t ap;
  if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) s_rssi = ap.rssi;
  return s_rssi;
}
char *shutong_wifi_get_ip(void) { return s_ip; }
