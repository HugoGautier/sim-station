#include "sc16is750.h"
#include <Wire.h>

void sc16Write(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg << 3);
  Wire.write(val);
  Wire.endTransmission();
}

uint8_t sc16Read(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr);
  Wire.write((reg << 3) | 0x80);  // bit 7 = read
  Wire.endTransmission(false);
  Wire.requestFrom(addr, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0;
}

void sc16Begin(uint8_t addr, unsigned long baud, unsigned long xtalHz) {
  uint16_t divisor = xtalHz / (16UL * baud);
  sc16Write(addr, SC16_REG_LCR, 0x80);         // DLAB=1
  sc16Write(addr, SC16_REG_DLL, divisor & 0xFF);
  sc16Write(addr, SC16_REG_DLH, divisor >> 8);
  sc16Write(addr, SC16_REG_LCR, 0x03);         // 8N1, DLAB=0
  sc16Write(addr, SC16_REG_MCR, 0x00);
  sc16Write(addr, SC16_REG_IER, 0x00);
  sc16Write(addr, SC16_REG_FCR, 0x07);         // FIFO enable + reset TX/RX
}

int sc16Available(uint8_t addr) {
  return sc16Read(addr, SC16_REG_RXLVL);
}

uint8_t sc16ReadByte(uint8_t addr) {
  return sc16Read(addr, SC16_REG_RHR);
}

void sc16WriteByte(uint8_t addr, uint8_t b) {
  uint32_t start = millis();
  while (sc16Read(addr, SC16_REG_TXLVL) == 0) {
    if (millis() - start > 100) return;  // timeout 100ms
  }
  sc16Write(addr, SC16_REG_THR, b);
}

void sc16Print(uint8_t addr, const char* s) {
  while (*s) sc16WriteByte(addr, *s++);
}
