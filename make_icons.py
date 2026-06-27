#!/usr/bin/env python3
"""Generate the extension's PNG icons with no third-party deps (zlib + struct only).

A brass rounded square on transparent — a neutral, general-purpose mark. Re-run after
editing to regenerate icon-16/48/128.png.
"""
import os
import struct
import zlib

BRASS = (199, 154, 91, 255)   # --accent
DARK = (21, 18, 12, 255)      # inner notch


def rounded(x, y, size, margin, radius):
    lo, hi = margin, size - margin - 1
    if x < lo or x > hi or y < lo or y > hi:
        return False
    # round the corners
    for cx, cy in ((lo + radius, lo + radius), (hi - radius, lo + radius),
                   (lo + radius, hi - radius), (hi - radius, hi - radius)):
        in_corner_x = x < lo + radius if cx < size / 2 else x > hi - radius
        in_corner_y = y < lo + radius if cy < size / 2 else y > hi - radius
        if in_corner_x and in_corner_y:
            if (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2:
                return False
    return True


def pixel(x, y, size):
    margin = max(1, size // 8)
    radius = max(1, (size - 2 * margin) // 4)
    if not rounded(x, y, size, margin, radius):
        return (0, 0, 0, 0)
    # a thin dark horizontal bar across the middle for a bit of character
    bar = size // 12 + 1
    if abs(y - size // 2) < bar and margin + radius // 2 < x < size - margin - radius // 2:
        return DARK
    return BRASS


def write_png(path, size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0 (none)
        for x in range(size):
            raw.extend(pixel(x, y, size))

    def chunk(typ, data):
        return (struct.pack('>I', len(data)) + typ + data
                + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff))

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # RGBA, 8-bit
    idat = zlib.compress(bytes(raw), 9)
    with open(path, 'wb') as f:
        f.write(sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b''))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    for s in (16, 48, 128):
        write_png(os.path.join(here, f'icon-{s}.png'), s)
    print('wrote icon-16.png, icon-48.png, icon-128.png')


if __name__ == '__main__':
    main()
