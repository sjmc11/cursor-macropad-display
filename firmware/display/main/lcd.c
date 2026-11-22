// ST7789 240x240 driver for the clock's panel, matching the stock firmware:
//   SPI2, SCLK=GPIO1, MOSI=GPIO2, no MISO, no CS, DC=GPIO0, RST=GPIO3,
//   SPI mode 3 @ 40 MHz, backlight GPIO5 active-low PWM.
// The init sequence is the exact one the stock firmware sends (decoded from
// its flash image), including 0x21 INVON.

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "driver/ledc.h"
#include "esp_lcd_panel_io.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "lcd.h"

#define PIN_SCLK 1
#define PIN_MOSI 2
#define PIN_DC   0
#define PIN_RST  3
#define PIN_BL   5

static esp_lcd_panel_io_handle_t s_io;

static SemaphoreHandle_t s_done;
static uint16_t *s_buf;  // LCD_BUF_PIXELS, DMA-capable
static int s_xoff, s_yoff;
static uint8_t s_madctl = 0x00;

typedef struct { uint8_t cmd; uint8_t len; uint8_t data[14]; uint16_t delay_ms; } init_cmd_t;
static const init_cmd_t k_init[] = {
    {0x11, 0, {0}, 500},  // sleep out
    {0x3A, 1, {0x55}, 10},  // 16-bit colour
    {0x36, 1, {0x00}, 0},
    {0x2A, 4, {0x00, 0x00, 0x00, 0xF0}, 0},
    {0x2B, 4, {0x00, 0x00, 0x00, 0xF0}, 0},
    {0xB2, 5, {0x0C, 0x0C, 0x00, 0x33, 0x33}, 0},
    {0xB7, 1, {0x35}, 0},
    {0xBB, 1, {0x1F}, 0},
    {0xC0, 1, {0x2C}, 0},
    {0xC2, 1, {0x01}, 0},
    {0xC3, 1, {0x12}, 0},
    {0xC4, 1, {0x20}, 0},
    {0xC6, 1, {0x0F}, 0},
    {0xD0, 2, {0xA4, 0xA1}, 0},
    {0xE0, 14, {0xD0, 0x08, 0x11, 0x08, 0x0C, 0x15, 0x39, 0x33, 0x50, 0x36, 0x13, 0x14, 0x29, 0x2D}, 0},
    {0xE1, 14, {0xD0, 0x08, 0x10, 0x08, 0x06, 0x06, 0x39, 0x44, 0x51, 0x0B, 0x16, 0x14, 0x2F, 0x31}, 0},
    {0xE4, 3, {0x1D, 0x00, 0x00}, 0},
    {0x21, 0, {0}, 10},  // inversion on (IPS)
    {0x13, 0, {0}, 10},  // normal display
    {0x29, 0, {0}, 100},  // display on
};

static bool on_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *e, void *ctx)
{
    BaseType_t woke = pdFALSE;
    xSemaphoreGiveFromISR(s_done, &woke);
    return woke == pdTRUE;
}

static void cmd(uint8_t c, const uint8_t *d, size_t n)
{
    esp_lcd_panel_io_tx_param(s_io, c, d, n);
}

static void window(int x, int y, int w, int h)
{
    int x0 = x + s_xoff, x1 = x + w - 1 + s_xoff, y0 = y + s_yoff, y1 = y + h - 1 + s_yoff;
    uint8_t ca[4] = {x0 >> 8, x0 & 0xff, x1 >> 8, x1 & 0xff};
    uint8_t ra[4] = {y0 >> 8, y0 & 0xff, y1 >> 8, y1 & 0xff};
    cmd(0x2A, ca, 4);
    cmd(0x2B, ra, 4);
}

static void push(const uint16_t *px, size_t n, bool first)
{
    // 0x2C starts writing at the window origin, 0x3C continues where it left off
    esp_lcd_panel_io_tx_color(s_io, first ? 0x2C : 0x3C, px, n * 2);
    xSemaphoreTake(s_done, portMAX_DELAY);
}

uint16_t *lcd_buf(void) { return s_buf; }

void lcd_blit(int x, int y, int w, int h)
{
    if (w <= 0 || h <= 0) return;
    window(x, y, w, h);
    push(s_buf, (size_t)w * h, true);
}

void lcd_fill(int x, int y, int w, int h, uint16_t color)
{
    if (w <= 0 || h <= 0) return;
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > LCD_W) w = LCD_W - x;
    if (y + h > LCD_H) h = LCD_H - y;
    if (w <= 0 || h <= 0) return;
    uint16_t be = (color >> 8) | (color << 8);
    size_t total = (size_t)w * h;
    size_t chunk = total < LCD_BUF_PIXELS ? total : LCD_BUF_PIXELS;
    for (size_t i = 0; i < chunk; i++) s_buf[i] = be;
    window(x, y, w, h);
    bool first = true;
    while (total) {
        size_t n = total < chunk ? total : chunk;
        push(s_buf, n, first);
        first = false;
        total -= n;
    }
}

void lcd_set_backlight(int percent)
{
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    // active-low: full brightness = duty 0
    uint32_t duty = 1023 - (uint32_t)percent * 1023 / 100;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

void lcd_config(int madctl, int invert, int xoff, int yoff)
{
    if (madctl >= 0) { s_madctl = madctl; cmd(0x36, &s_madctl, 1); }
    if (invert >= 0) cmd(invert ? 0x21 : 0x20, NULL, 0);
    if (xoff >= 0) s_xoff = xoff;
    if (yoff >= 0) s_yoff = yoff;
}

esp_err_t lcd_init(void)
{
    // Backlight off (high) while the panel initialises.
    gpio_set_direction(PIN_BL, GPIO_MODE_OUTPUT);
    gpio_set_level(PIN_BL, 1);

    s_done = xSemaphoreCreateBinary();
    s_buf = heap_caps_malloc(LCD_BUF_PIXELS * 2, MALLOC_CAP_DMA);
    if (!s_done || !s_buf) return ESP_ERR_NO_MEM;

    spi_bus_config_t bus = {
        .sclk_io_num = PIN_SCLK, .mosi_io_num = PIN_MOSI, .miso_io_num = -1,
        .quadwp_io_num = -1, .quadhd_io_num = -1,
        .max_transfer_sz = LCD_BUF_PIXELS * 2 + 16,
    };
    esp_err_t err = spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) return err;

    esp_lcd_panel_io_spi_config_t io = {
        .dc_gpio_num = PIN_DC, .cs_gpio_num = -1,
        .pclk_hz = 40 * 1000 * 1000, .spi_mode = 3,
        .trans_queue_depth = 4, .lcd_cmd_bits = 8, .lcd_param_bits = 8,
        .on_color_trans_done = on_done,
    };
    err = esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &io, &s_io);
    if (err != ESP_OK) return err;

    // Hardware reset, same timing as the stock firmware.
    gpio_set_direction(PIN_RST, GPIO_MODE_OUTPUT);
    gpio_set_level(PIN_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(5));
    gpio_set_level(PIN_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(PIN_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(150));

    for (size_t i = 0; i < sizeof(k_init) / sizeof(k_init[0]); i++) {
        cmd(k_init[i].cmd, k_init[i].len ? k_init[i].data : NULL, k_init[i].len);
        if (k_init[i].delay_ms) vTaskDelay(pdMS_TO_TICKS(k_init[i].delay_ms));
    }

    lcd_fill(0, 0, LCD_W, LCD_H, 0x0000);

    ledc_timer_config_t t = {
        .speed_mode = LEDC_LOW_SPEED_MODE, .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = LEDC_TIMER_0, .freq_hz = 5000, .clk_cfg = LEDC_AUTO_CLK,
    };
    ledc_timer_config(&t);
    ledc_channel_config_t ch = {
        .gpio_num = PIN_BL, .speed_mode = LEDC_LOW_SPEED_MODE, .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0, .duty = 1023, .hpoint = 0,
    };
    ledc_channel_config(&ch);
    return ESP_OK;
}
