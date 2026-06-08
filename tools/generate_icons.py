#!/usr/bin/env python3
# Only Refresh — icon generator.
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright (C) 2026 Only Refresh contributors.
#
# Renders the dark, rounded-square app icon with a teal circular-arrow "reload"
# glyph at 16/32/48/128 px. Pure standard library only (zlib + struct + math):
# the scene is drawn with hard edges at 4x resolution, then box-downsampled with
# premultiplied alpha for clean anti-aliasing, and written as RGBA PNG.
#
# Usage:  python tools/generate_icons.py
# Output: icons/icon16.png, icon32.png, icon48.png, icon128.png

import math
import os
import struct
import zlib

SS = 4  # supersampling factor

# Palette
BG = (27, 30, 37)        # dark slate, opaque
ACCENT = (45, 212, 191)  # teal #2dd4bf

# Glyph geometry, as fractions of the final icon size.
MARGIN_F = 0.06
CORNER_F = 0.24      # corner radius as fraction of the inner square
RING_R_F = 0.300     # ring radius
RING_TH_F = 0.115    # ring stroke thickness
GAP_CENTER = -math.pi / 2.0   # gap at the top (screen coords: y points down)
GAP_HALF = math.radians(40)   # half-width of the gap
ARROW_AT = -math.pi / 2.0 + math.radians(40)  # right edge of the gap
ARROW_DIR = -1.0     # tip points toward the gap (decreasing angle)
ARROW_LEN_F = 0.135  # tip extension beyond the ring centerline
ARROW_W_F = 0.105    # half base width (radial)


def ang_diff(a, b):
    d = a - b
    while d > math.pi:
        d -= 2 * math.pi
    while d < -math.pi:
        d += 2 * math.pi
    return d


def in_triangle(px, py, ax, ay, bx, by, cx, cy):
    d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
    d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
    d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def render(size):
    hi = size * SS
    s = float(hi)

    margin = MARGIN_F * s
    x0, y0 = margin, margin
    x1, y1 = s - margin, s - margin
    cx_r, cy_r = s / 2.0, s / 2.0
    hx = (x1 - x0) / 2.0
    hy = (y1 - y0) / 2.0
    rad = CORNER_F * min(x1 - x0, y1 - y0)

    cc = s / 2.0                     # glyph center
    Rr = RING_R_F * s
    th = RING_TH_F * s
    half_th = th / 2.0

    # Arrowhead points (tip + two radial base corners on the ring centerline).
    pex = cc + Rr * math.cos(ARROW_AT)
    pey = cc + Rr * math.sin(ARROW_AT)
    tx = -math.sin(ARROW_AT)         # tangent
    ty = math.cos(ARROW_AT)
    nx = math.cos(ARROW_AT)          # radial
    ny = math.sin(ARROW_AT)
    L = ARROW_LEN_F * s
    w = ARROW_W_F * s
    tip_x = pex + ARROW_DIR * tx * L
    tip_y = pey + ARROW_DIR * ty * L
    b1x, b1y = pex + nx * w, pey + ny * w
    b2x, b2y = pex - nx * w, pey - ny * w

    hi_px = bytearray(hi * hi * 4)
    for y in range(hi):
        py = y + 0.5
        row = y * hi * 4
        for x in range(hi):
            px = x + 0.5

            # Rounded-rectangle background (SDF, inside if d < 0).
            qx = abs(px - cx_r) - hx + rad
            qy = abs(py - cy_r) - hy + rad
            ox = qx if qx > 0 else 0.0
            oy = qy if qy > 0 else 0.0
            d = math.hypot(ox, oy) - rad + min(max(qx, qy), 0.0)
            inside_rect = d < 0.0

            i = row + x * 4
            if not inside_rect:
                continue  # transparent

            # Glyph: ring arc (minus the top gap) OR arrowhead triangle.
            dxp = px - cc
            dyp = py - cc
            dist = math.hypot(dxp, dyp)
            is_glyph = False
            if abs(dist - Rr) <= half_th:
                ang = math.atan2(dyp, dxp)
                if abs(ang_diff(ang, GAP_CENTER)) > GAP_HALF:
                    is_glyph = True
            if not is_glyph and in_triangle(px, py, tip_x, tip_y, b1x, b1y, b2x, b2y):
                is_glyph = True

            col = ACCENT if is_glyph else BG
            hi_px[i] = col[0]
            hi_px[i + 1] = col[1]
            hi_px[i + 2] = col[2]
            hi_px[i + 3] = 255

    return downsample(hi_px, hi, size)


def downsample(hi_px, hi, size):
    out = bytearray(size * size * 4)
    n = float(SS * SS)
    for oy in range(size):
        for ox in range(size):
            sa = sr = sg = sb = 0.0
            for dy in range(SS):
                sy = oy * SS + dy
                base = (sy * hi + ox * SS) * 4
                for dx in range(SS):
                    i = base + dx * 4
                    a = hi_px[i + 3] / 255.0
                    sa += a
                    sr += hi_px[i] * a
                    sg += hi_px[i + 1] * a
                    sb += hi_px[i + 2] * a
            o = (oy * size + ox) * 4
            if sa > 0:
                out[o] = int(round(sr / sa))
                out[o + 1] = int(round(sg / sa))
                out[o + 2] = int(round(sb / sa))
            out[o + 3] = int(round(sa / n * 255.0))
    return out


def write_png(path, width, height, rgba):
    def chunk(typ, data):
        return (struct.pack('>I', len(data)) + typ + data +
                struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff))

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # RGBA, 8-bit
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw.extend(rgba[y * stride:(y + 1) * stride])
    idat = zlib.compress(bytes(raw), 9)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', idat))
        f.write(chunk(b'IEND', b''))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(os.path.dirname(here), 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        rgba = render(size)
        path = os.path.join(out_dir, 'icon%d.png' % size)
        write_png(path, size, size, rgba)
        print('wrote', path)


if __name__ == '__main__':
    main()
