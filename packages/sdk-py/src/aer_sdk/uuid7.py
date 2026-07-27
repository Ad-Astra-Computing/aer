"""UUIDv7 (time-ordered) generation, stdlib only.

Mirrors the TypeScript SDK's ids: 48-bit millisecond timestamp, version 7,
RFC 4122 variant, remaining bits random. Time-ordered ids keep event rows
naturally clustered by insertion time.
"""

import os
import time

def uuid7() -> str:
    ts = int(time.time() * 1000) & ((1 << 48) - 1)
    rand = os.urandom(10)

    b = bytearray(16)
    b[0] = (ts >> 40) & 0xFF
    b[1] = (ts >> 32) & 0xFF
    b[2] = (ts >> 24) & 0xFF
    b[3] = (ts >> 16) & 0xFF
    b[4] = (ts >> 8) & 0xFF
    b[5] = ts & 0xFF
    b[6] = 0x70 | (rand[0] & 0x0F)  # version 7
    b[7] = rand[1]
    b[8] = 0x80 | (rand[2] & 0x3F)  # RFC 4122 variant
    b[9:16] = rand[3:10]

    h = b.hex()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"
