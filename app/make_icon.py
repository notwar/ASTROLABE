# Makes icon.ico, icon_256.png and icon_32.png from logo.svg: the logo in light grey on a dark grey
# rounded tile, so it reads on light and dark taskbars. Edge (headless) draws each size; this script
# packs them into the .ico. Plain Python, no libraries. Run: python app/make_icon.py
import base64, os, struct, subprocess, tempfile, re

TILE, INK, SCALE = '#2c2c2a', '#f1efe8', 0.74   # tile colour, logo colour, logo size inside the tile
SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'

here = os.path.dirname(os.path.abspath(__file__))
svg = open(os.path.join(here, 'logo.svg'), encoding='utf8').read()
d = re.search(r' d="([^"]+)"', svg).group(1)
vx, vy, vs = [float(v) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).split()[:3]]

page = '''<!doctype html><body><pre id="out"></pre><script>
async function one(n) {
  const N = n * (n <= 64 ? 4 : 2);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + N + '" height="' + N + '" viewBox="0 0 64 64">'
    + '<rect width="64" height="64" rx="14" fill="%(tile)s"/>'
    + '<g transform="translate(32 32) scale(%(k)s) translate(%(tx)s %(ty)s)"><path fill="%(ink)s" d="%(d)s"/></g></svg>';
  const img = new Image(); img.src = 'data:image/svg+xml;base64,' + btoa(svg); await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = n;
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, n, n);
  return n + ' ' + c.toDataURL('image/png').split(',')[1];
}
(async () => { const r = []; for (const n of %(sizes)s) r.push(await one(n)); document.getElementById('out').textContent = r.join('\\n'); })();
</script></body>''' % dict(tile=TILE, ink=INK, d=d, k=64 * SCALE / vs, tx=-vx - vs / 2, ty=-vy - vs / 2, sizes=SIZES)

with tempfile.TemporaryDirectory() as tmp:
    html = os.path.join(tmp, 'icon.html')
    open(html, 'w', encoding='utf8').write(page)
    dom = subprocess.run([EDGE, '--headless=new', '--disable-gpu', '--virtual-time-budget=5000', '--dump-dom',
                          'file:///' + html.replace('\\', '/')], capture_output=True, text=True, encoding='utf8').stdout

body = dom.split('<pre id="out">')[1].split('</pre>')[0].strip()
pngs = [(int(n), base64.b64decode(b)) for n, b in (line.split(' ') for line in body.splitlines())]
assert [s for s, _ in pngs] == SIZES, 'Edge did not draw every size'

with open(os.path.join(here, 'icon.ico'), 'wb') as f:
    f.write(struct.pack('<HHH', 0, 1, len(pngs)))
    offset = 6 + 16 * len(pngs)
    for s, p in pngs:
        f.write(struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(p), offset))
        offset += len(p)
    for _, p in pngs:
        f.write(p)
open(os.path.join(here, 'icon_256.png'), 'wb').write(dict(pngs)[256])
open(os.path.join(here, 'icon_32.png'), 'wb').write(dict(pngs)[32])
print('wrote icon.ico')
