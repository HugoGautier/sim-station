#pragma once
#include <Arduino.h>

// SC16IS750 I2C UART bridge — registers and a minimal driver

#define SC16_REG_RHR   0x00
#define SC16_REG_THR   0x00
#define SC16_REG_IER   0x01
#define SC16_REG_FCR   0x02
#define SC16_REG_LCR   0x03
#define SC16_REG_MCR   0x04
#define SC16_REG_LSR   0x05
#define SC16_REG_TXLVL 0x08
#define SC16_REG_RXLVL 0x09
#define SC16_REG_DLL   0x00  // LCR[7]=1
#define SC16_REG_DLH   0x01  // LCR[7]=1

void    sc16Write(uint8_t addr, uint8_t reg, uint8_t val);
uint8_t sc16Read(uint8_t addr, uint8_t reg);
void    sc16Begin(uint8_t addr, unsigned long baud, unsigned long xtalHz);
int     sc16Available(uint8_t addr);
uint8_t sc16ReadByte(uint8_t addr);
void    sc16WriteByte(uint8_t addr, uint8_t b);
void    sc16Print(uint8_t addr, const char* s);
