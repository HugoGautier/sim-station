#include "module_serial.h"
#include "sc16is750.h"

HardwareSerial* hwSerial(int m) {
  switch (MODULES[m].serialType) {
    case PORT_SERIAL1: return &Serial1;
    case PORT_SERIAL2: return &Serial2;
    case PORT_SERIAL3: return &Serial3;
    default:           return nullptr;
  }
}

void moduleSerialBegin(int m) {
  if (MODULES[m].serialType == PORT_I2C) {
    sc16Begin(MODULES[m].i2cAddr, SIM_BAUD, MODULES[m].i2cXtalHz);
  } else {
    hwSerial(m)->begin(SIM_BAUD);
  }
}

int moduleSerialAvailable(int m) {
  if (MODULES[m].serialType == PORT_I2C)
    return sc16Available(MODULES[m].i2cAddr);
  return hwSerial(m)->available();
}

int moduleSerialRead(int m) {
  if (MODULES[m].serialType == PORT_I2C)
    return sc16ReadByte(MODULES[m].i2cAddr);
  return hwSerial(m)->read();
}

void moduleSerialPrint(int m, const char* s) {
  if (MODULES[m].serialType == PORT_I2C)
    sc16Print(MODULES[m].i2cAddr, s);
  else
    hwSerial(m)->print(s);
}
