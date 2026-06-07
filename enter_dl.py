#!/usr/bin/env python3
"""Enter download mode on ESP32-S3"""
import serial, time
s = serial.Serial("/dev/cu.usbmodem2101", 115200, timeout=1)
s.dtr = False; s.rts = False; time.sleep(0.05)
s.dtr = True; time.sleep(0.05)   # EN low (reset)
s.rts = True; time.sleep(0.05)   # GPIO0 low (BOOT)
s.dtr = False; time.sleep(0.5)   # EN high (release reset, BOOT held)
s.close()
print("Download mode!")
