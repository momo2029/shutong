#include "shutong_camera.h"
#include "esp_log.h"
#include "esp_http_server.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "sht-cam-stream";

// HTML: JavaScript auto-refresh <img> every 200ms
static const char INDEX_HTML[] =
"<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
"<title>书童 摄像头</title><style>body{font-family:sans-serif;background:#1e293b;color:#f8fafc;text-align:center;"
"margin:0;padding:0}h2{color:#4f46e5;padding:16px 0 8px}img{max-width:100%;height:auto;border-radius:8px}"
".info{font-size:12px;color:#94a3b8;margin-top:8px}</style></head>"
"<body><h2>书童 旗舰版</h2><img id='cam' src='/snapshot' onload=\"setTimeout(()=>{this.src='/snapshot?'+Date.now()},200)\" onerror=\"setTimeout(()=>{this.src='/snapshot?'+Date.now()},500)\">"
"<p class='info'>OV3660 QVGA ~5fps</p></body></html>";

static esp_err_t index_handler(httpd_req_t *req) {
  httpd_resp_send(req, INDEX_HTML, HTTPD_RESP_USE_STRLEN);
  return ESP_OK;
}

static esp_err_t snapshot_handler(httpd_req_t *req) {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }
  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_send(req, (const char *)fb->buf, fb->len);
  esp_camera_fb_return(fb);
  return ESP_OK;
}

void shutong_camera_stream_start(void) {
  httpd_handle_t server = NULL;
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.server_port = 80;
  cfg.max_uri_handlers = 3;
  httpd_start(&server, &cfg);

  httpd_uri_t index_uri = { .uri = "/", .method = HTTP_GET, .handler = index_handler };
  httpd_uri_t snap_uri = { .uri = "/snapshot", .method = HTTP_GET, .handler = snapshot_handler };
  httpd_register_uri_handler(server, &index_uri);
  httpd_register_uri_handler(server, &snap_uri);
  ESP_LOGI(TAG, "Camera HTTP started on port 80");
}
