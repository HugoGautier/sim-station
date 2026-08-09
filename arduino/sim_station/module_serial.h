#pragma once
#include <Arduino.h>
#include "config.h"

// Per-module serial routing (HardwareSerial or SC16IS750)

HardwareSerial* hwSerial(int m);
void moduleSerialBegin(int m);
int  moduleSerialAvailable(int m);
int  moduleSerialRead(int m);
void moduleSerialPrint(int m, const char* s);
