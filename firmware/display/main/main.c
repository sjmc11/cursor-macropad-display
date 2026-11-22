// Cursor status display: renders agent state pushed from the Mac.
//
//   POST /state   JSON, all fields optional:
//     {"state":"idle|thinking|working|waiting|error", "model":"...", "effort":"...",
//      "mode":"...", "ctx_used":84000, "ctx_max":200000, "tokens":1234567,
//      "agents":2, "msg":"..."}
//   GET  /state   current state as JSON
//   GET  /lcd?bl=0-100&madctl=0x00&inv=1&xoff=0&yoff=0   panel tuning

#include <stdio.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_sntp.h"
#include "esp_system.h"
#include "cJSON.h"
#include "lcd.h"
#include "net.h"
#include "fonts.h"
#include "startup_anim.h"

// ------------------------------------------------------------- palette ----
#define C_BG      RGB(11, 13, 16)
#define C_PANEL   RGB(24, 28, 34)
#define C_TEXT    RGB(236, 239, 244)
#define C_DIM     RGB(139, 148, 158)
#define C_FAINT   RGB(72, 80, 90)
#define C_IDLE    RGB(107, 114, 128)
#define C_THINK   RGB(167, 139, 250)
#define C_WORK    RGB(96, 165, 250)
#define C_WAIT    RGB(251, 191, 36)
#define C_ERR     RGB(248, 113, 113)
#define C_OK      RGB(52, 211, 153)

// Context categories, in the order the bridge sends ctx_parts (Cursor's popup order).
#define CTX_PARTS 8
static const uint16_t k_part_col[CTX_PARTS] = {
    RGB(158, 158, 158),  // system prompt
    RGB(179, 136, 235),  // tool definitions
    RGB(134, 217, 147),  // rules
    RGB(212, 177, 6),    // skills
    RGB(201, 79, 201),   // MCP & dynamic tools
    RGB(47, 123, 216),   // subagent definitions
    RGB(45, 180, 170),   // summarized conversation
    RGB(224, 123, 42),   // conversation
};
static const char *const k_part_name[CTX_PARTS] = {
    "System", "Tools", "Rules", "Skills", "MCP", "Agents", "Summary", "Chat",
};

// --------------------------------------------------------------- state ----
typedef struct {
    char state[16], model[48], effort[32], mode[32], msg[48];
    char project[40], branch[48];
    uint32_t ctx_used, ctx_max;
    uint32_t ctx_parts[CTX_PARTS];
    int ctx_nparts;  // 0 = no breakdown, draw a single bar
    double tokens;
    int agents;
    int64_t updated_us;  // 0 = never
    uint32_t version;
} cstate_t;

static cstate_t s_st = {.state = "idle"};
static SemaphoreHandle_t s_lock;

// ------------------------------------------------------------ drawing -----
enum { AL_LEFT, AL_RIGHT, AL_CENTER };

static int text_width(const font_t *f, const char *s)
{
    int w = 0;
    for (; *s; s++) {
        unsigned c = (unsigned char)*s;
        if (c < 32 || c > 126) c = '?';
        w += f->glyphs[c - 32].adv;
    }
    return w;
}

static uint16_t blend(uint16_t fg, uint16_t bg, uint8_t a /*0..15*/)
{
    if (a == 0) return bg;
    if (a == 15) return fg;
    int r = (((fg >> 11) & 31) * a + ((bg >> 11) & 31) * (15 - a)) / 15;
    int g = (((fg >> 5) & 63) * a + ((bg >> 5) & 63) * (15 - a)) / 15;
    int b = ((fg & 31) * a + (bg & 31) * (15 - a)) / 15;
    return (r << 11) | (g << 5) | b;
}

// Draws text into a w-wide box (background-filled, so no flicker), truncating with "..."
static void draw_text(int x, int y, int w, const font_t *f, const char *str, uint16_t fg, uint16_t bg, int align)
{
    char s[64];
    strncpy(s, str, sizeof(s) - 1);
    s[sizeof(s) - 1] = 0;
    int tw = text_width(f, s);
    while (tw > w && strlen(s) > 1) {  // truncate
        size_t n = strlen(s);
        s[n - 1] = 0;
        if (n > 4) memcpy(&s[n - 4], "...", 4);
        tw = text_width(f, s);
    }
    int h = f->height;
    uint16_t *buf = lcd_buf();
    uint16_t bgbe = (bg >> 8) | (bg << 8);
    for (int i = 0; i < w * h; i++) buf[i] = bgbe;
    int pen = align == AL_RIGHT ? w - tw : align == AL_CENTER ? (w - tw) / 2 : 0;
    for (const char *p = s; *p; p++) {
        unsigned c = (unsigned char)*p;
        if (c < 32 || c > 126) c = '?';
        const glyph_t *g = &f->glyphs[c - 32];
        for (int gy = 0; gy < g->h; gy++) {
            int py = g->y + gy;
            if (py < 0 || py >= h) continue;
            for (int gx = 0; gx < g->w; gx++) {
                int px = pen + g->x + gx;
                if (px < 0 || px >= w) continue;
                int idx = gy * g->w + gx;
                uint8_t byte = f->bits[g->offset + idx / 2];
                uint8_t a = (idx & 1) ? (byte & 0x0f) : (byte >> 4);
                if (!a) continue;
                uint16_t c16 = blend(fg, bg, a);
                buf[py * w + px] = (c16 >> 8) | (c16 << 8);
            }
        }
        pen += g->adv;
    }
    lcd_blit(x, y, w, h);
}

static void fmt_tokens(char *out, size_t n, double v)
{
    if (v >= 1e9) snprintf(out, n, "%.1fB", v / 1e9);
    else if (v >= 1e6) snprintf(out, n, "%.1fM", v / 1e6);
    else if (v >= 1e3) snprintf(out, n, "%.0fk", v / 1e3);
    else snprintf(out, n, "%.0f", v);
}

static uint16_t state_color(const char *st)
{
    if (!strcmp(st, "thinking")) return C_THINK;
    if (!strcmp(st, "working")) return C_WORK;
    if (!strcmp(st, "waiting")) return C_WAIT;
    if (!strcmp(st, "error")) return C_ERR;
    if (!strcmp(st, "offline")) return C_FAINT;
    return C_IDLE;
}

static bool state_busy(const char *st) { return !strcmp(st, "thinking") || !strcmp(st, "working"); }

// Layout (y positions)
#define Y_HEAD   10
#define Y_ANIM   40
#define Y_MODEL  56
#define Y_EFFORT 96
#define Y_CTXLBL 128
#define Y_CTXBAR 155
#define Y_CTXNUM 168
#define Y_TOK    191
#define Y_FOOT   218

static void draw_static_frame(void)
{
    lcd_fill(0, 0, LCD_W, LCD_H, C_BG);
    lcd_fill(12, Y_FOOT - 5, LCD_W - 24, 1, C_PANEL);
}

static void draw_header(const cstate_t *st, const char *label)
{
    uint16_t col = state_color(label);
    // status dot
    lcd_fill(14, Y_HEAD + 6, 8, 8, col);
    char up[16];
    size_t i = 0;
    for (; label[i] && i < sizeof(up) - 1; i++) up[i] = (label[i] >= 'a' && label[i] <= 'z') ? label[i] - 32 : label[i];
    up[i] = 0;
    draw_text(30, Y_HEAD, 110, &font_s, up, col, C_BG, AL_LEFT);
    char ag[24];
    if (st->agents == 1) snprintf(ag, sizeof(ag), "1 agent");
    else snprintf(ag, sizeof(ag), "%d agents", st->agents);
    draw_text(140, Y_HEAD, 86, &font_s, st->updated_us ? ag : "", C_DIM, C_BG, AL_RIGHT);
}

// The largest context categories, as colour swatches with labels, on one row.
static void draw_ctx_legend(const cstate_t *st)
{
    lcd_fill(12, Y_TOK, 216, font_s.height, C_BG);
    bool shown[CTX_PARTS] = {0};
    int x = 12;
    for (int k = 0; k < 3; k++) {
        int best = -1;
        for (int i = 0; i < st->ctx_nparts; i++) {
            if (!shown[i] && st->ctx_parts[i] && (best < 0 || st->ctx_parts[i] > st->ctx_parts[best])) best = i;
        }
        if (best < 0) break;
        shown[best] = true;
        char num[12], label[24];
        fmt_tokens(num, sizeof(num), st->ctx_parts[best]);
        snprintf(label, sizeof(label), "%s %s", k_part_name[best], num);
        int tw = text_width(&font_s, label);
        if (x + 12 + tw > 228) break;
        lcd_fill(x, Y_TOK + 6, 8, 8, k_part_col[best]);
        draw_text(x + 12, Y_TOK, tw, &font_s, label, C_DIM, C_BG, AL_LEFT);
        x += 12 + tw + 10;
    }
}

static void draw_body(const cstate_t *st)
{
    const char *model = st->model[0] ? st->model : (st->updated_us ? "-" : "Waiting for Cursor");
    const font_t *mf = text_width(&font_l, model) <= 216 ? &font_l : &font_m;
    if (mf == &font_m) lcd_fill(12, Y_MODEL, 216, font_l.height, C_BG);
    draw_text(12, Y_MODEL + (mf == &font_m ? 6 : 0), 216, mf, model, C_TEXT, C_BG, AL_LEFT);

    char line[96];
    if (st->effort[0] && st->mode[0]) snprintf(line, sizeof(line), "%s  -  %s", st->effort, st->mode);
    else snprintf(line, sizeof(line), "%s", st->effort[0] ? st->effort : st->mode);
    if (!st->updated_us) {
        char ip[20];
        net_sta_ip(ip, sizeof(ip));
        snprintf(line, sizeof(line), "POST http://%s/state", ip);
    }
    if (st->msg[0]) snprintf(line, sizeof(line), "%s", st->msg);
    draw_text(12, Y_EFFORT, 216, &font_s, line, C_DIM, C_BG, AL_LEFT);

    // Context
    int pct = st->ctx_max ? (int)((uint64_t)st->ctx_used * 100 / st->ctx_max) : 0;
    if (pct > 100) pct = 100;
    uint16_t bar = pct < 60 ? C_OK : pct < 85 ? C_WAIT : C_ERR;
    draw_text(12, Y_CTXLBL, 120, &font_m, "Context", C_TEXT, C_BG, AL_LEFT);
    char ps[12];
    snprintf(ps, sizeof(ps), st->ctx_max ? "%d%%" : "--", pct);
    draw_text(132, Y_CTXLBL, 96, &font_m, ps, st->ctx_max ? bar : C_DIM, C_BG, AL_RIGHT);
    if (st->ctx_nparts && st->ctx_max) {
        // Segmented bar like Cursor's Context Usage popup; every non-empty part gets at least 1 px.
        uint64_t cum = 0;
        int x = 0;
        for (int i = 0; i < st->ctx_nparts; i++) {
            cum += st->ctx_parts[i];
            int end = (int)(cum * 216 / st->ctx_max);
            if (st->ctx_parts[i] && end <= x) end = x + 1;
            if (end > 216) end = 216;
            if (end > x) { lcd_fill(12 + x, Y_CTXBAR, end - x, 10, k_part_col[i]); x = end; }
        }
        lcd_fill(12 + x, Y_CTXBAR, 216 - x, 10, C_PANEL);
    } else {
        int fillw = 216 * pct / 100;
        lcd_fill(12, Y_CTXBAR, fillw, 10, bar);
        lcd_fill(12 + fillw, Y_CTXBAR, 216 - fillw, 10, C_PANEL);
    }
    char a[16], b[16];
    fmt_tokens(a, sizeof(a), st->ctx_used);
    fmt_tokens(b, sizeof(b), st->ctx_max);
    snprintf(line, sizeof(line), st->ctx_max ? "%s / %s tokens" : "", a, b);
    draw_text(12, Y_CTXNUM, 216, &font_s, line, C_DIM, C_BG, AL_LEFT);

    if (st->ctx_nparts && st->ctx_max) {
        draw_ctx_legend(st);
        return;
    }
    // Session tokens
    fmt_tokens(a, sizeof(a), st->tokens);
    draw_text(12, Y_TOK, 110, &font_s, "Tokens used", C_DIM, C_BG, AL_LEFT);
    draw_text(122, Y_TOK, 106, &font_s, st->updated_us ? a : "--", C_TEXT, C_BG, AL_RIGHT);
}

// Time on the left; project and git branch (or WiFi status) on the right.
static void draw_footer(const cstate_t *st)
{
    char t[16] = "--:--";
    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    if (tm.tm_year > 120) strftime(t, sizeof(t), "%H:%M", &tm);
    draw_text(12, Y_FOOT, 48, &font_s, t, C_DIM, C_BG, AL_LEFT);

    const int x0 = 64, w = LCD_W - 12 - x0;
    if (!net_sta_connected()) {
        draw_text(x0, Y_FOOT, w, &font_s, "No WiFi", C_ERR, C_BG, AL_RIGHT);
        return;
    }
    if (!st->project[0] && !st->branch[0]) {
        draw_text(x0, Y_FOOT, w, &font_s, "WiFi", C_FAINT, C_BG, AL_RIGHT);
        return;
    }
    int bw = st->branch[0] ? text_width(&font_s, st->branch) : 0;
    if (bw > 100) bw = 100;  // long branch names truncate; the project gets the rest
    int gap = bw && st->project[0] ? 8 : 0;
    int pw = w - bw - gap;
    draw_text(x0, Y_FOOT, pw, &font_s, st->project, C_DIM, C_BG, AL_RIGHT);
    if (gap) lcd_fill(x0 + pw, Y_FOOT, gap, font_s.height, C_BG);
    if (bw) draw_text(x0 + w - bw, Y_FOOT, bw, &font_s, st->branch, C_THINK, C_BG, AL_RIGHT);
}

// Indeterminate progress bar under the header while busy.
static void draw_anim(uint16_t col, bool busy, int frame)
{
    const int x0 = 12, w = 216, seg = 60;
    if (!busy) { lcd_fill(x0, Y_ANIM, w, 3, C_BG); return; }
    int pos = (frame * 6) % (w + seg) - seg;
    for (int x = 0; x < w; x += 24) {
        int ww = x + 24 > w ? w - x : 24;
        bool on = x + ww > pos && x < pos + seg;
        lcd_fill(x0 + x, Y_ANIM, ww, 3, on ? col : C_PANEL);
    }
}

static void color_bars(void)
{
    // Quick visual check of colour order: red, green, blue, white.
    const uint16_t c[4] = {RGB(255, 0, 0), RGB(0, 255, 0), RGB(0, 0, 255), RGB(255, 255, 255)};
    for (int i = 0; i < 4; i++) lcd_fill(i * 60, 0, 60, LCD_H, c[i]);
}

// Decode and display one RLE frame (count, color_hi, color_lo).
static void draw_startup_frame(int f)
{
    const int ROWS_PER_BLIT = LCD_BUF_PIXELS / LCD_W;  // 40 rows fit in buffer
    uint16_t *buf = lcd_buf();
    
    const uint8_t *data = startup_frames[f];
    const uint8_t *end = data + startup_frame_sizes[f];
    int px = 0;
    int strip_y = 0;
    
    while (data < end) {
        uint8_t count = data[0];
        uint16_t color = (data[1] << 8) | data[2];
        data += 3;
        uint16_t be = (color >> 8) | (color << 8);
        
        for (int i = 0; i < count; i++) {
            buf[px++] = be;
            if (px >= ROWS_PER_BLIT * LCD_W) {
                lcd_blit(0, strip_y, LCD_W, ROWS_PER_BLIT);
                strip_y += ROWS_PER_BLIT;
                px = 0;
            }
        }
    }
    if (px > 0) {
        int remaining_rows = (px + LCD_W - 1) / LCD_W;
        lcd_blit(0, strip_y, LCD_W, remaining_rows);
    }
}

// Play the startup animation once (no loop), freeze on final frame.
static void play_startup_anim(void)
{
    for (int f = 0; f < STARTUP_FRAMES; f++) {
        draw_startup_frame(f);
        uint32_t ms = startup_frame_ms[f];
        if (ms > 0) {
            vTaskDelay(pdMS_TO_TICKS(ms));
        }
    }
    // Final frame stays on screen until UI task starts
}

static volatile bool s_force_redraw;

static void ui_task(void *arg)
{
    uint32_t drawn_version = UINT32_MAX;
    char drawn_label[16] = "";
    int frame = 0, last_min = -1;
    bool was_busy = false;
    for (;;) {
        cstate_t st;
        xSemaphoreTake(s_lock, portMAX_DELAY);
        st = s_st;
        xSemaphoreGive(s_lock);

        // Mac stopped talking to us -> offline
        const char *label = st.state;
        if (st.updated_us && esp_timer_get_time() - st.updated_us > 90LL * 1000000) label = "offline";
        if (!st.updated_us) label = "idle";

        if (s_force_redraw) {
            s_force_redraw = false;
            draw_static_frame();
            drawn_version = UINT32_MAX;
            drawn_label[0] = 0;
            last_min = -1;
        }
        if (st.version != drawn_version || strcmp(label, drawn_label)) {
            draw_header(&st, label);
            draw_body(&st);
            drawn_version = st.version;
            strncpy(drawn_label, label, sizeof(drawn_label) - 1);
            last_min = -1;  // footer shows project / branch too
        }
        bool busy = state_busy(label);
        if (busy || was_busy) draw_anim(state_color(label), busy, frame);
        was_busy = busy;

        time_t now = time(NULL);
        if (now / 60 != last_min) { draw_footer(&st); last_min = now / 60; }
        frame++;
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

// ----------------------------------------------------------- handlers -----

static void copy_str(cJSON *o, const char *k, char *dst, size_t n)
{
    cJSON *v = cJSON_GetObjectItem(o, k);
    if (cJSON_IsString(v)) { strncpy(dst, v->valuestring, n - 1); dst[n - 1] = 0; }
}

static esp_err_t h_state_post(httpd_req_t *req)
{
    if (req->content_len > 1024) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "too large");
    char body[1025];
    int got = 0;
    while (got < (int)req->content_len) {
        int r = httpd_req_recv(req, body + got, req->content_len - got);
        if (r <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "read failed");
        got += r;
    }
    body[got] = 0;
    cJSON *o = cJSON_Parse(body);
    if (!o) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad json");

    xSemaphoreTake(s_lock, portMAX_DELAY);
    copy_str(o, "state", s_st.state, sizeof(s_st.state));
    copy_str(o, "model", s_st.model, sizeof(s_st.model));
    copy_str(o, "effort", s_st.effort, sizeof(s_st.effort));
    copy_str(o, "mode", s_st.mode, sizeof(s_st.mode));
    copy_str(o, "msg", s_st.msg, sizeof(s_st.msg));
    copy_str(o, "project", s_st.project, sizeof(s_st.project));
    copy_str(o, "branch", s_st.branch, sizeof(s_st.branch));
    cJSON *v;
    if (cJSON_IsNumber(v = cJSON_GetObjectItem(o, "ctx_used"))) s_st.ctx_used = v->valuedouble;
    if (cJSON_IsNumber(v = cJSON_GetObjectItem(o, "ctx_max"))) s_st.ctx_max = v->valuedouble;
    if (cJSON_IsNumber(v = cJSON_GetObjectItem(o, "tokens"))) s_st.tokens = v->valuedouble;
    if (cJSON_IsNumber(v = cJSON_GetObjectItem(o, "agents"))) s_st.agents = v->valueint;
    if (cJSON_IsArray(v = cJSON_GetObjectItem(o, "ctx_parts"))) {
        int n = 0;
        cJSON *it;
        cJSON_ArrayForEach(it, v) {
            if (n >= CTX_PARTS) break;
            s_st.ctx_parts[n++] = cJSON_IsNumber(it) && it->valuedouble > 0 ? (uint32_t)it->valuedouble : 0;
        }
        s_st.ctx_nparts = n;
    }
    s_st.updated_us = esp_timer_get_time();
    s_st.version++;
    xSemaphoreGive(s_lock);
    cJSON_Delete(o);
    return httpd_resp_sendstr(req, "ok\n");
}

static esp_err_t h_state_get(httpd_req_t *req)
{
    char out[512];
    xSemaphoreTake(s_lock, portMAX_DELAY);
    snprintf(out, sizeof(out),
             "{\"state\":\"%s\",\"model\":\"%s\",\"effort\":\"%s\",\"mode\":\"%s\",\"msg\":\"%s\","
             "\"project\":\"%s\",\"branch\":\"%s\","
             "\"ctx_used\":%lu,\"ctx_max\":%lu,\"tokens\":%.0f,\"agents\":%d,\"age_s\":%lu}\n",
             s_st.state, s_st.model, s_st.effort, s_st.mode, s_st.msg, s_st.project, s_st.branch,
             (unsigned long)s_st.ctx_used, (unsigned long)s_st.ctx_max, s_st.tokens, s_st.agents,
             s_st.updated_us ? (unsigned long)((esp_timer_get_time() - s_st.updated_us) / 1000000) : 0UL);
    xSemaphoreGive(s_lock);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, out);
}

static int qint(const char *q, const char *k, int def)
{
    char v[16];
    if (httpd_query_key_value(q, k, v, sizeof(v)) != ESP_OK) return def;
    return (int)strtol(v, NULL, 0);
}

static esp_err_t h_lcd(httpd_req_t *req)
{
    char q[128] = "";
    httpd_req_get_url_query_str(req, q, sizeof(q));
    int bl = qint(q, "bl", -1);
    if (bl >= 0) lcd_set_backlight(bl);
    lcd_config(qint(q, "madctl", -1), qint(q, "inv", -1), qint(q, "xoff", -1), qint(q, "yoff", -1));
    if (qint(q, "bars", 0)) { color_bars(); vTaskDelay(pdMS_TO_TICKS(3000)); }
    s_force_redraw = true;
    return httpd_resp_sendstr(req, "ok\n");
}

static esp_err_t h_reboot(httpd_req_t *req)
{
    httpd_resp_sendstr(req, "ok: rebooting\n");
    vTaskDelay(pdMS_TO_TICKS(100));  // Let response flush
    esp_restart();
    return ESP_OK;  // Never reached
}

static bool s_lcd_ok;

void app_main(void)
{
    s_lock = xSemaphoreCreateMutex();

    // Network first: whatever happens to the display, OTA stays reachable.
    httpd_handle_t srv = net_start();

    // Safe mode: if the last reset was a crash or watchdog, don't touch the
    // display at all, so a display bug can't cause a reboot loop. Power-cycle
    // the device to try the display again.
    esp_reset_reason_t rr = esp_reset_reason();
    if (rr == ESP_RST_PANIC || rr == ESP_RST_INT_WDT || rr == ESP_RST_TASK_WDT || rr == ESP_RST_WDT) {
        ESP_LOGE("main", "safe mode after reset reason %d: display disabled", rr);
        return;
    }

    s_lcd_ok = lcd_init() == ESP_OK;
    if (!s_lcd_ok) return;
    lcd_set_backlight(80);
    play_startup_anim();   // purple stars animation (plays once, freezes on final frame)

    const httpd_uri_t uris[] = {
        {.uri = "/state", .method = HTTP_POST, .handler = h_state_post},
        {.uri = "/state", .method = HTTP_GET, .handler = h_state_get},
        {.uri = "/lcd", .method = HTTP_GET, .handler = h_lcd},
        {.uri = "/reboot", .method = HTTP_POST, .handler = h_reboot},
    };
    for (size_t i = 0; i < sizeof(uris) / sizeof(uris[0]); i++) httpd_register_uri_handler(srv, &uris[i]);

    setenv("TZ", "GMT0BST,M3.5.0/1,M10.5.0", 1);
    tzset();
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "pool.ntp.org");
    esp_sntp_init();

    // Animation already finished (1 second), just a brief pause before UI starts
    vTaskDelay(pdMS_TO_TICKS(500));
    s_force_redraw = true;
    xTaskCreate(ui_task, "ui", 4096, NULL, 4, NULL);
}
