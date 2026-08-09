#pragma once

// Increase the HardwareSerial RX buffer from the default 64 to 256 bytes.
// Prevents byte loss when a SIM7600 sends a large AT response (e.g. CMGL)
// at full speed while the Arduino is busy writing to USB Serial.
// Must be defined BEFORE <Arduino.h> pulls in HardwareSerial.h.
#define SERIAL_RX_BUFFER_SIZE 256

#include <Arduino.h>

// ============================================================
//  CONFIGURATION — everything is declared here
// ============================================================

#define CHANNELS_PER_MUX 16
#define CEIL_DIV(a, b) (((a) + (b) - 1) / (b))

#define USB_BAUD 115200
#define SIM_BAUD 115200

enum SerialType { PORT_SERIAL1, PORT_SERIAL2, PORT_SERIAL3, PORT_I2C };

struct MuxPins {
  int addr[4];  // address pins S0-S3
  int en;       // ENABLE pin (active LOW, -1 if unused)
};

struct ModuleConfig {
  uint8_t        simCount;     // number of SIM slots on this module
  uint8_t        muxCount;     // derived automatically (do not set by hand)
  const MuxPins* muxes;        // MUX table for this module
  SerialType     serialType;   // serial port wired to the SIM7600
  uint8_t        i2cAddr;      // SC16IS750 I2C address (ignored unless PORT_I2C)
  unsigned long  i2cXtalHz;    // SC16IS750 oscillator frequency
};

// ── MUX definition per module ────────────────────────────────
// Each MUX is { {S0, S1, S2, S3}, EN }. A module with more than
// CHANNELS_PER_MUX (16) SIMs lists several MUXes (see the commented example).

static const MuxPins MUXES_0[] = { { {2, 3, 4, 5}, A9 } };
static const MuxPins MUXES_1[] = { { {6, 7, 8, 9}, A10 } };
// Example — a 32-SIM module driven by two cascaded 16-channel MUXes:
// static const MuxPins MUXES_1[] = { { {10,11,12,13}, 44 }, { {22,23,24,25}, 45 } };

// ── Module table ─────────────────────────────────────────────
//
//  To add a module, add a line to MODULES[].
//  simCount = number of SIM slots (muxCount is computed automatically).
//  MODULE(sims, muxArray, serialType, i2cAddr, i2cXtalHz)
//    - i2cAddr / i2cXtalHz are only used when serialType is PORT_I2C
//      (e.g. an SC16IS750 bridge: PORT_I2C, 0x4B, 14745600).

#define MODULE(sims, muxArr, sType, i2c, xtal) \
  { (sims), CEIL_DIV(sims, CHANNELS_PER_MUX), (muxArr), (sType), (i2c), (xtal) }

const ModuleConfig MODULES[] = {
  MODULE(4, MUXES_0, PORT_SERIAL1, 0x00, 0),
  MODULE(4, MUXES_1, PORT_SERIAL2, 0x00, 0),
};

#define MODULE_COUNT (sizeof(MODULES) / sizeof(MODULES[0]))

inline int simCount(int m)  { return MODULES[m].simCount; }
inline int muxCount(int m)  { return MODULES[m].muxCount; }
