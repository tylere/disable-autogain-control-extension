#!/usr/bin/env python3
"""Generate placeholder extension icons (no third-party deps).

Draws a microphone with a diagonal slash on a rounded blue square,
rasterized with 4x supersampling for smooth edges. Replace with a
properly designed icon before any Chrome Web Store submission.
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "images")
SIZES = (16, 32, 48, 128)

BG = (26, 115, 232)      # Google blue
FG = (255, 255, 255)     # microphone
SLASH = (234, 67, 53)    # red "disabled" slash


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(size):
    ss = 4
    n = size * ss
    px = [[(0, 0, 0, 0) for _ in range(n)] for _ in range(n)]

    radius = n * 0.22          # rounded-corner radius
    cx = n / 2.0

    # mic body capsule
    body_w = n * 0.34
    body_top = n * 0.16
    body_bot = n * 0.58
    body_r = body_w / 2.0
    # stand
    stand_top = body_bot
    stand_bot = n * 0.78
    base_y = n * 0.82
    base_half = n * 0.20
    bar_h = n * 0.05

    def in_rounded_square(x, y):
        # distance into the rounded-rect mask
        dx = max(radius - x, x - (n - radius), 0.0)
        dy = max(radius - y, y - (n - radius), 0.0)
        return dx * dx + dy * dy <= radius * radius

    def in_mic(x, y):
        # capsule body
        if body_top + body_r <= y <= body_bot - body_r and abs(x - cx) <= body_r:
            return True
        if (x - cx) ** 2 + (y - (body_top + body_r)) ** 2 <= body_r ** 2 and y < body_top + body_r:
            return True
        if (x - cx) ** 2 + (y - (body_bot - body_r)) ** 2 <= body_r ** 2 and y > body_bot - body_r:
            return True
        # stand stem
        if stand_top <= y <= stand_bot and abs(x - cx) <= n * 0.035:
            return True
        # base bar
        if base_y - bar_h <= y <= base_y + bar_h and abs(x - cx) <= base_half:
            return True
        return False

    def on_slash(x, y):
        # thick diagonal line from top-left to bottom-right of glyph area
        d = abs((y - n * 0.12) - (x - n * 0.12))
        return d <= n * 0.055 and n * 0.10 <= x <= n * 0.90

    for y in range(n):
        for x in range(n):
            if not in_rounded_square(x + 0.5, y + 0.5):
                continue
            color = BG
            if in_mic(x + 0.5, y + 0.5):
                color = FG
            if on_slash(x + 0.5, y + 0.5):
                color = SLASH
            px[y][x] = (color[0], color[1], color[2], 255)

    # downsample (box filter) to target size
    out = bytearray()
    for oy in range(size):
        out.append(0)  # PNG filter type 0 per scanline
        for ox in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    pr, pg, pb, pa = px[oy * ss + sy][ox * ss + sx]
                    af = pa / 255.0
                    r += pr * af
                    g += pg * af
                    b += pb * af
                    a += pa
            cnt = ss * ss
            aa = a / cnt
            if aa > 0:
                norm = (a / 255.0)
                out += bytes((round(r / norm), round(g / norm),
                              round(b / norm), round(aa)))
            else:
                out += bytes((0, 0, 0, 0))
    return bytes(out)


def write_png(path, size, raw):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr)
                + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def main():
    for s in SIZES:
        path = os.path.join(OUT_DIR, f"icon{s}.png")
        write_png(path, s, render(s))
        print("wrote", os.path.relpath(path))


if __name__ == "__main__":
    main()
