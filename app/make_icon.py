# Draws icon.ico for ASTROLABE: a line-drawn astrolabe (shackle ring, outer ring, inner ring,
# alidade with sights, centre pin) in light grey on a dark grey rounded tile, so it reads on both
# light and dark taskbars. Plain Python, no libraries. ICO entries are 32-bit PNGs.
# Geometry is in a 64x64 space, the same as the logo in the app's header.
import math, os, struct, zlib

TILE = (44, 44, 42)       # dark grey tile
INK = (241, 239, 232)     # light grey lines
W = 4.5                   # line width
SCALE = 0.74              # drawing inside the tile

RINGS = [((32, 9), 4), ((32, 37), 22), ((32, 37), 12)]
SEGMENTS = [((32, 13), (32, 15)), ((14, 51), (50, 23)), ((17, 45), (21, 50)), ((43, 24), (47, 29))]
DOT = ((32, 37), 3.2)
Y_SHIFT = -3  # centre the drawing (it runs from y 2.8 to 61) in the tile

def seg_dist(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def ink_at(x, y):
    # map tile space back into drawing space
    p = ((x - 32) / SCALE + 32, (y - 32) / SCALE + 32 - Y_SHIFT)
    for c, r in RINGS:
        if abs(math.hypot(p[0] - c[0], p[1] - c[1]) - r) <= W / 2:
            return True
    for a, b in SEGMENTS:
        if seg_dist(p, a, b) <= W / 2:
            return True
    c, r = DOT
    return math.hypot(p[0] - c[0], p[1] - c[1]) <= r

def in_tile(x, y, radius=14):
    qx = max(abs(x - 32) - (32 - radius), 0)
    qy = max(abs(y - 32) - (32 - radius), 0)
    return math.hypot(qx, qy) <= radius

def render(size, ss):
    k = 64 / size
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) * k
                    y = (py + (sy + 0.5) / ss) * k
                    if not in_tile(x, y):
                        continue
                    col = INK if ink_at(x, y) else TILE
                    r += col[0]; g += col[1]; b += col[2]; a += 255
            if a:
                f = 255 / a
                row += bytes((round(r * f), round(g * f), round(b * f), round(a / (ss * ss))))
            else:
                row += b'\0\0\0\0'
        rows.append(bytes(row))
    raw = b''.join(b'\0' + r for r in rows)
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

sizes = [16, 20, 24, 32, 40, 48, 64, 256]
pngs = [render(s, 4 if s <= 64 else 2) for s in sizes]
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, 'icon.ico'), 'wb') as f:
    f.write(struct.pack('<HHH', 0, 1, len(sizes)))
    offset = 6 + 16 * len(sizes)
    for s, p in zip(sizes, pngs):
        f.write(struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(p), offset))
        offset += len(p)
    for p in pngs:
        f.write(p)
with open(os.path.join(here, 'icon_256.png'), 'wb') as f:
    f.write(pngs[-1])
with open(os.path.join(here, 'icon_32.png'), 'wb') as f:
    f.write(pngs[sizes.index(32)])
print('wrote icon.ico')
