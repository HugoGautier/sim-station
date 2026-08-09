// ============================================================
//  SIM MUX Passthrough — Elegoo Mega
// ============================================================

#include <Wire.h>
#include "config.h"
#include "sc16is750.h"
#include "module_serial.h"

// ── Global state ─────────────────────────────────────────────

static char usbBuffer[1100];
static uint8_t usbBufferLen = 0;
static int currentModule = 0;       // last module targeted by a MUX command

// Per-module line buffers for AT response tagging.
// 1024 bytes to handle long UCS2-encoded SMS bodies (160 chars = 640 hex digits).
static char modBuffer[MODULE_COUNT][1024];
static uint16_t modBufferLen[MODULE_COUNT] = {};
static int currentSim[MODULE_COUNT] = {};

// Temp buffer for atomic Serial.println (avoids interleaving)
static char outBuf[1040];

// ── MUX ──────────────────────────────────────────────────────

void setMux(int moduleId, int simIndex) {
  int muxIndex = simIndex / CHANNELS_PER_MUX;
  int channel  = simIndex % CHANNELS_PER_MUX;

  // 1. Disable every MUX on this module
  for (int i = 0; i < muxCount(moduleId); i++) {
    if (MODULES[moduleId].muxes[i].en >= 0)
      digitalWrite(MODULES[moduleId].muxes[i].en, HIGH);
  }

  // 2. Set the address lines on the target MUX
  const int* pins = MODULES[moduleId].muxes[muxIndex].addr;
  for (int b = 0; b < 4; b++)
    digitalWrite(pins[b], (channel >> b) & 1 ? HIGH : LOW);

  // 3. Enable only the target MUX
  if (MODULES[moduleId].muxes[muxIndex].en >= 0)
    digitalWrite(MODULES[moduleId].muxes[muxIndex].en, LOW);

  currentSim[moduleId] = simIndex;
  delay(50);
}

// ── Module AT response forwarding ────────────────────────────

// Flush a complete line from module m with [m] prefix
static void flushModLine(int m) {
  modBuffer[m][modBufferLen[m]] = '\0';
  snprintf(outBuf, sizeof(outBuf), "[%d]%s", m, modBuffer[m]);
  Serial.println(outBuf);
  modBufferLen[m] = 0;
}

// Read available bytes from module m, buffer lines, emit tagged
static void readModuleLines(int m) {
  while (moduleSerialAvailable(m)) {
    char c = (char)moduleSerialRead(m);
    if (c == '\n') {
      flushModLine(m);
    } else if (c != '\r') {
      modBuffer[m][modBufferLen[m]++] = c;
      // Overflow protection: flush partial line
      if (modBufferLen[m] >= sizeof(modBuffer[0]) - 1) {
        flushModLine(m);
      }
    }
  }
}

// ── USB protocol ─────────────────────────────────────────────

void sendTopology() {
  Serial.print("TOPOLOGY:{\"modules\":[");
  for (int i = 0; i < (int)MODULE_COUNT; i++) {
    if (i > 0) Serial.print(',');
    Serial.print("{\"id\":");
    Serial.print(i);
    Serial.print(",\"simCount\":");
    Serial.print(simCount(i));
    Serial.print('}');
  }
  Serial.println("]}");
}

void handleMuxCommand(const char* params) {
  int moduleId, simIndex;
  if (sscanf(params, "%d:%d", &moduleId, &simIndex) != 2) return;
  if (moduleId < 0 || moduleId >= (int)MODULE_COUNT) return;
  if (simIndex < 0 || simIndex >= simCount(moduleId)) return;

  setMux(moduleId, simIndex);
  currentModule = moduleId;

  Serial.print("MUX_OK:");
  Serial.print(moduleId);
  Serial.print(':');
  Serial.println(simIndex);
}

void handleATCommand(const char* params) {
  // Format: AT:moduleId:command
  int moduleId;
  if (sscanf(params, "%d:", &moduleId) != 1) return;
  if (moduleId < 0 || moduleId >= (int)MODULE_COUNT) return;

  // Find the command after "moduleId:"
  const char* cmd = strchr(params, ':');
  if (!cmd) return;
  cmd++; // skip colon after moduleId

  moduleSerialPrint(moduleId, cmd);
  moduleSerialPrint(moduleId, "\r\n");
}

void handleUsbLine(const char* line) {
  if (strcmp(line, "TOPOLOGY_REQUEST") == 0) {
    sendTopology();
    return;
  }
  if (strncmp(line, "MUX:", 4) == 0) {
    handleMuxCommand(line + 4);
    return;
  }
  if (strncmp(line, "AT:", 3) == 0) {
    handleATCommand(line + 3);
    return;
  }

  // Raw AT fallback → current module (backward compat)
  if (MODULES[currentModule].serialType == PORT_I2C) {
    sc16Print(MODULES[currentModule].i2cAddr, line);
    sc16Print(MODULES[currentModule].i2cAddr, "\r\n");
  } else {
    HardwareSerial* s = hwSerial(currentModule);
    if (s) { s->print(line); s->print("\r\n"); }
  }
}

// ── Setup & Loop ─────────────────────────────────────────────

void setup() {
  Serial.begin(USB_BAUD);
  Wire.begin();

  for (int m = 0; m < (int)MODULE_COUNT; m++)
    moduleSerialBegin(m);

  // Configure the MUX pins
  for (int m = 0; m < (int)MODULE_COUNT; m++) {
    for (int mx = 0; mx < muxCount(m); mx++) {
      for (int p = 0; p < 4; p++)
        pinMode(MODULES[m].muxes[mx].addr[p], OUTPUT);
      if (MODULES[m].muxes[mx].en >= 0) {
        pinMode(MODULES[m].muxes[mx].en, OUTPUT);
        digitalWrite(MODULES[m].muxes[mx].en, HIGH);
      }
    }
  }

  for (int m = 0; m < (int)MODULE_COUNT; m++)
    setMux(m, 0);
}

void loop() {
  // USB → commands
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      usbBuffer[usbBufferLen] = '\0';
      handleUsbLine(usbBuffer);
      usbBufferLen = 0;
    } else if (c != '\r' && usbBufferLen < sizeof(usbBuffer) - 1) {
      usbBuffer[usbBufferLen++] = c;
    }
  }

  // Module AT output → USB (line-buffered with [moduleId] prefix)
  for (int m = 0; m < (int)MODULE_COUNT; m++) {
    readModuleLines(m);
  }
}
