#!/usr/bin/env python3
"""Check serial output from ESP32"""
import serial, time, sys

s = serial.Serial("/dev/cu.usbmodem2101", 115200, timeout=0.5)
# Reset
s.dtr = False
s.rts = True
time.sleep(0.05)
s.dtr = True
s.rts = False
time.sleep(0.05)

# Read for 8 seconds
buf = b""
for i in range(80):
    try:
        d = s.read(512)
        if d:
            buf += d
    except:
        pass
    time.sleep(0.1)

s.close()
if buf:
    print(buf.decode("utf-8", errors="replace")[-3000:])
else:
    print("NO DATA")
