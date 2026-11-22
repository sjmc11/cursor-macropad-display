idf_component_register(SRCS "main.c" "net.c" "lcd.c"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES esp_wifi esp_netif esp_event esp_http_server
                                     app_update esp_partition spi_flash efuse
                                     bootloader_support esp_timer esp_lcd esp_driver_spi
                                     esp_driver_gpio esp_driver_ledc json lwip)
