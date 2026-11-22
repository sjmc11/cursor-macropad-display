#pragma once
#include <stdbool.h>
#include <stddef.h>
#include "esp_http_server.h"

// Starts WiFi (STA + fallback AP "clock-rescue") and the HTTP server with the
// maintenance endpoints (/info /flash /ota /boot-other /reboot). Returns the
// server so callers can register more handlers.
httpd_handle_t net_start(void);
bool net_sta_connected(void);
void net_sta_ip(char *out, size_t n);
