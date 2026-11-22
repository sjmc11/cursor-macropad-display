#pragma once
#include <stdint.h>
#include "esp_err.h"

#define LCD_W 240
#define LCD_H 240
#define LCD_BUF_PIXELS (LCD_W * 40)

// RGB888 -> RGB565
#define RGB(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

esp_err_t lcd_init(void);
void lcd_set_backlight(int percent);
// Any argument < 0 is left unchanged.
void lcd_config(int madctl, int invert, int xoff, int yoff);
void lcd_fill(int x, int y, int w, int h, uint16_t color);
// Scratch buffer of LCD_BUF_PIXELS big-endian RGB565 pixels, sent by lcd_blit.
uint16_t *lcd_buf(void);
void lcd_blit(int x, int y, int w, int h);
