// Networking + maintenance endpoints for the Cursor display firmware.
// (Same contract as the rescue firmware, so every image stays recoverable.)
//
//   GET  /             plain-text help
//   GET  /info         JSON: chip, flash, partitions, app descriptions, WiFi
//   GET  /flash        raw flash dump (?offset=&len=, defaults to whole chip)
//   POST /ota?confirm=1  raw firmware body -> next OTA slot -> reboot into it
//   POST /boot-other   boot the other OTA slot -> reboot (alias: /boot-stock)
//   POST /reboot
//
// WiFi: always runs a fallback access point "clock-rescue" (pw "clockrescue",
// http://192.168.4.1) and, if credentials were patched in, also joins your
// network as station with hostname "cursor-display".
//
// Credentials are NOT compiled in. The two fields below hold placeholders that
// tools/patch-wifi.py replaces on your Mac, so they never leave your machine.

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_system.h"
#include "esp_log.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_http_server.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_flash.h"
#include "esp_flash_encrypt.h"
#include "esp_secure_boot.h"
#include "esp_chip_info.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "esp_app_desc.h"

#include "net.h"

static const char *TAG = "net";

// ---- Patchable credential fields (see tools/patch-wifi.py) ----------------
// Field sizes are part of the patch contract: SSID 40 bytes, password 72 bytes.
__attribute__((used, aligned(4))) const char g_wifi_ssid[40] = "@@WIFI_SSID@@";
__attribute__((used, aligned(4))) const char g_wifi_pass[72] = "@@WIFI_PASS@@";

// Stop the compiler from constant-folding the placeholder contents.
static const char *launder(const char *p)
{
    __asm__ volatile("" : "+r"(p));
    return p;
}

#define AP_SSID "clock-rescue"
#define AP_PASS "clockrescue"

static esp_netif_t *s_sta_netif;
static volatile bool s_sta_enabled;
static volatile bool s_sta_connected;

// ---------------------------------------------------------------- WiFi ----

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_sta_connected = false;
        vTaskDelay(pdMS_TO_TICKS(2000));
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        s_sta_connected = true;
        ESP_LOGW(TAG, "STA got IP " IPSTR, IP2STR(&e->ip_info.ip));
    }
}

static void wifi_start(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_sta_netif = esp_netif_create_default_wifi_sta();
    esp_netif_create_default_wifi_ap();
    esp_netif_set_hostname(s_sta_netif, "cursor-display");

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    cfg.nvs_enable = 0;  // never touch the stock NVS partition
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));

    const char *ssid = launder(g_wifi_ssid);
    const char *pass = launder(g_wifi_pass);
    s_sta_enabled = ssid[0] != '\0' && strncmp(ssid, "@@", 2) != 0;

    wifi_config_t ap = {0};
    strcpy((char *)ap.ap.ssid, AP_SSID);
    strcpy((char *)ap.ap.password, AP_PASS);
    ap.ap.ssid_len = strlen(AP_SSID);
    ap.ap.channel = 1;
    ap.ap.max_connection = 2;
    ap.ap.authmode = WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_mode(s_sta_enabled ? WIFI_MODE_APSTA : WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));

    if (s_sta_enabled) {
        wifi_config_t sta = {0};
        strncpy((char *)sta.sta.ssid, ssid, sizeof(sta.sta.ssid));
        if (strncmp(pass, "@@", 2) != 0) {
            strncpy((char *)sta.sta.password, pass, sizeof(sta.sta.password));
        }
        sta.sta.threshold.authmode = WIFI_AUTH_OPEN;  // accept whatever the router offers
        sta.sta.pmf_cfg.capable = true;
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
    }
    ESP_ERROR_CHECK(esp_wifi_start());
}

// ------------------------------------------------------------- helpers ----

static void reboot_cb(void *arg) { esp_restart(); }

static void reboot_soon(void)
{
    static esp_timer_handle_t t;
    const esp_timer_create_args_t a = {.callback = reboot_cb, .name = "reboot"};
    if (!t) esp_timer_create(&a, &t);
    esp_timer_start_once(t, 1500 * 1000);
}

static bool query_u32(httpd_req_t *req, const char *key, uint32_t *out)
{
    char q[96], v[24];
    if (httpd_req_get_url_query_str(req, q, sizeof(q)) != ESP_OK) return false;
    if (httpd_query_key_value(q, key, v, sizeof(v)) != ESP_OK) return false;
    *out = strtoul(v, NULL, 0);
    return true;
}

static const esp_partition_t *other_app_slot(void)
{
    return esp_ota_get_next_update_partition(NULL);
}

// ------------------------------------------------------------ handlers ----

static esp_err_t h_root(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_sendstr(req,
        "cursor display firmware\n\n"
        "POST /state  JSON {state,model,effort,mode,ctx_used,ctx_max,tokens,agents,msg}\n"
        "GET  /state\n"
        "GET  /lcd?bl=0-100&madctl=0x00&inv=1&xoff=0&yoff=0\n"
        "GET  /info\n"
        "GET  /flash[?offset=0&len=0x400000]   (whole chip by default)\n"
        "POST /ota?confirm=1  --data-binary @app.bin   (overwrites the OTHER slot)\n"
        "POST /boot-other     (boot the other slot)\n"
        "POST /reboot\n");
}

#define JAPP(...) do { n += snprintf(buf + n, cap > n ? cap - n : 0, __VA_ARGS__); } while (0)

static esp_err_t h_info(httpd_req_t *req)
{
    const size_t cap = 6144;
    char *buf = malloc(cap);
    if (!buf) return httpd_resp_send_500(req);
    size_t n = 0;

    esp_chip_info_t ci;
    esp_chip_info(&ci);
    uint32_t flash_size = 0;
    esp_flash_get_size(NULL, &flash_size);
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    const esp_partition_t *run = esp_ota_get_running_partition();
    const esp_partition_t *boot = esp_ota_get_boot_partition();
    const esp_partition_t *next = other_app_slot();
    esp_netif_ip_info_t ip = {0};
    if (s_sta_netif) esp_netif_get_ip_info(s_sta_netif, &ip);

    JAPP("{\"firmware\":\"%s\",\"idf\":\"%s\",", esp_app_get_description()->version, esp_get_idf_version());
    JAPP("\"chip\":{\"model\":%d,\"revision\":%d,\"cores\":%d,\"features\":%lu},",
         ci.model, ci.revision, ci.cores, (unsigned long)ci.features);
    JAPP("\"flash_size\":%lu,\"flash_encryption\":%s,\"secure_boot\":%s,",
         (unsigned long)flash_size, esp_flash_encryption_enabled() ? "true" : "false",
         esp_secure_boot_enabled() ? "true" : "false");
    JAPP("\"mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\",", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    JAPP("\"wifi\":{\"sta_enabled\":%s,\"sta_connected\":%s,\"sta_ip\":\"" IPSTR "\",\"ap\":\"" AP_SSID "\"},",
         s_sta_enabled ? "true" : "false", s_sta_connected ? "true" : "false", IP2STR(&ip.ip));
    JAPP("\"heap_free\":%lu,\"heap_min\":%lu,\"uptime_s\":%lu,\"reset_reason\":%d,",
         (unsigned long)esp_get_free_heap_size(), (unsigned long)esp_get_minimum_free_heap_size(),
         (unsigned long)(esp_timer_get_time() / 1000000), esp_reset_reason());
    JAPP("\"running\":\"%s\",\"boot\":\"%s\",\"other_slot\":\"%s\",\"partitions\":[",
         run ? run->label : "?", boot ? boot->label : "?", next ? next->label : "none");

    esp_partition_iterator_t it = esp_partition_find(ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, NULL);
    bool first = true;
    for (; it; it = esp_partition_next(it)) {
        const esp_partition_t *p = esp_partition_get(it);
        JAPP("%s{\"label\":\"%s\",\"type\":%d,\"subtype\":%d,\"offset\":\"0x%lx\",\"size\":\"0x%lx\"",
             first ? "" : ",", p->label, p->type, p->subtype, (unsigned long)p->address, (unsigned long)p->size);
        first = false;
        esp_app_desc_t d;
        if (p->type == ESP_PARTITION_TYPE_APP && esp_ota_get_partition_description(p, &d) == ESP_OK) {
            JAPP(",\"app\":{\"project\":\"%s\",\"version\":\"%s\",\"idf\":\"%s\",\"date\":\"%s %s\"}",
                 d.project_name, d.version, d.idf_ver, d.date, d.time);
        }
        JAPP("}");
    }
    esp_partition_iterator_release(it);
    JAPP("]}\n");

    httpd_resp_set_type(req, "application/json");
    esp_err_t r = httpd_resp_send(req, buf, n < cap ? n : cap - 1);
    free(buf);
    return r;
}

static esp_err_t h_flash(httpd_req_t *req)
{
    uint32_t chip = 0;
    esp_flash_get_size(NULL, &chip);
    uint32_t off = 0, len = 0;
    query_u32(req, "offset", &off);
    if (!query_u32(req, "len", &len) || len == 0) len = chip - off;
    if (off >= chip || len > chip - off) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "range outside flash");
        return ESP_FAIL;
    }
    uint8_t *buf = malloc(4096);
    if (!buf) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/octet-stream");
    char cd[80];
    snprintf(cd, sizeof(cd), "attachment; filename=flash_0x%lx_0x%lx.bin", (unsigned long)off, (unsigned long)len);
    httpd_resp_set_hdr(req, "Content-Disposition", cd);

    esp_err_t r = ESP_OK;
    for (uint32_t done = 0; done < len && r == ESP_OK; ) {
        uint32_t n = len - done > 4096 ? 4096 : len - done;
        r = esp_flash_read(NULL, buf, off + done, n);
        if (r == ESP_OK) r = httpd_resp_send_chunk(req, (const char *)buf, n);
        done += n;
    }
    free(buf);
    if (r == ESP_OK) r = httpd_resp_send_chunk(req, NULL, 0);
    return r;
}

static esp_err_t h_ota(httpd_req_t *req)
{
    uint32_t confirm = 0;
    if (!query_u32(req, "confirm", &confirm) || confirm != 1) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST,
                            "add ?confirm=1 (this overwrites the other slot, i.e. the original firmware)");
        return ESP_FAIL;
    }
    const esp_partition_t *part = other_app_slot();
    if (!part) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no OTA slot");
        return ESP_FAIL;
    }
    if (req->content_len == 0 || req->content_len > part->size) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "image empty or larger than the OTA slot");
        return ESP_FAIL;
    }

    esp_ota_handle_t h;
    esp_err_t r = esp_ota_begin(part, OTA_WITH_SEQUENTIAL_WRITES, &h);
    if (r != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, esp_err_to_name(r));
        return ESP_FAIL;
    }
    char *buf = malloc(4096);
    if (!buf) { esp_ota_abort(h); return httpd_resp_send_500(req); }

    size_t left = req->content_len;
    int timeouts = 0;
    while (left > 0) {
        int got = httpd_req_recv(req, buf, left > 4096 ? 4096 : left);
        if (got == HTTPD_SOCK_ERR_TIMEOUT && ++timeouts < 5) continue;
        if (got <= 0) { r = ESP_FAIL; break; }
        timeouts = 0;
        r = esp_ota_write(h, buf, got);
        if (r != ESP_OK) break;
        left -= got;
    }
    free(buf);
    if (r != ESP_OK) {
        esp_ota_abort(h);
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "upload/write failed, nothing changed");
        return ESP_FAIL;
    }
    r = esp_ota_end(h);  // verifies the image (chip id, checksum, hash)
    if (r == ESP_OK) r = esp_ota_set_boot_partition(part);
    if (r != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, esp_err_to_name(r));
        return ESP_FAIL;
    }
    char msg[96];
    snprintf(msg, sizeof(msg), "ok: written to %s, rebooting\n", part->label);
    httpd_resp_sendstr(req, msg);
    reboot_soon();
    return ESP_OK;
}

static esp_err_t h_boot_stock(httpd_req_t *req)
{
    const esp_partition_t *part = other_app_slot();
    esp_app_desc_t d;
    if (!part || esp_ota_get_partition_description(part, &d) != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "other slot has no valid app");
        return ESP_FAIL;
    }
    esp_err_t r = esp_ota_set_boot_partition(part);
    if (r != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, esp_err_to_name(r));
        return ESP_FAIL;
    }
    char msg[160];
    snprintf(msg, sizeof(msg), "ok: booting %s (%s %s), rebooting\n", part->label, d.project_name, d.version);
    httpd_resp_sendstr(req, msg);
    reboot_soon();
    return ESP_OK;
}

static esp_err_t h_reboot(httpd_req_t *req)
{
    httpd_resp_sendstr(req, "rebooting\n");
    reboot_soon();
    return ESP_OK;
}

bool net_sta_connected(void) { return s_sta_connected; }

void net_sta_ip(char *out, size_t n)
{
    esp_netif_ip_info_t ip = {0};
    if (s_sta_netif) esp_netif_get_ip_info(s_sta_netif, &ip);
    snprintf(out, n, IPSTR, IP2STR(&ip.ip));
}

httpd_handle_t net_start(void)
{
    wifi_start();
    httpd_config_t c = HTTPD_DEFAULT_CONFIG();
    c.max_uri_handlers = 14;
    c.stack_size = 6144;
    c.recv_wait_timeout = 20;
    c.send_wait_timeout = 20;
    c.lru_purge_enable = true;
    httpd_handle_t s = NULL;
    ESP_ERROR_CHECK(httpd_start(&s, &c));
    const httpd_uri_t uris[] = {
        {.uri = "/", .method = HTTP_GET, .handler = h_root},
        {.uri = "/info", .method = HTTP_GET, .handler = h_info},
        {.uri = "/flash", .method = HTTP_GET, .handler = h_flash},
        {.uri = "/ota", .method = HTTP_POST, .handler = h_ota},
        {.uri = "/boot-stock", .method = HTTP_POST, .handler = h_boot_stock},
        {.uri = "/boot-other", .method = HTTP_POST, .handler = h_boot_stock},
        {.uri = "/reboot", .method = HTTP_POST, .handler = h_reboot},
    };
    for (size_t i = 0; i < sizeof(uris) / sizeof(uris[0]); i++) httpd_register_uri_handler(s, &uris[i]);
    esp_ota_mark_app_valid_cancel_rollback();
    return s;
}
