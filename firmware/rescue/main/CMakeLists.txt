idf_component_register(SRCS "rescue.c"
                       PRIV_REQUIRES esp_wifi esp_netif esp_event esp_http_server
                                     app_update esp_partition spi_flash efuse
                                     bootloader_support esp_timer)
