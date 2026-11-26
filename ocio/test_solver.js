// Round trips through the app's solver: random target hex -> value to type (rounded like you'd type it)
// -> forward through the config -> same hex? Per config, output and colour profile.
// Fails (exit code 1) when a result isn't a number, when copied float values miss a colour the exact values
// hit (the app copies as many decimals as it takes), or when a config's hit rate drops below its known floor.
// Configs that aren't installed on this PC are skipped.
const fs = require('fs');
const E = require('../ocio.js');
const N = +process.argv[2] || 300;
// [path, [display, view] pairs (null: the first), colour profiles ('INV': the inverted view), lowest share of
// colours that must land exactly (below 1 where the view or its LUTs can't make every colour)]
const CONFIGS = [
  ['C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/OpenColorIO-Configs/AS_STUDIO/AS_STUDIO_RS.ocio', [['sRGB', 'ACES 1.0 SDR-video'], ['Rec709', 'ACES 1.0 SDR-video']], ['Invert ACES 1.0 SDR-video', 'ACEScg', 'scene-linear Rec.709-sRGB'], 0.98],
  ['C:/Program Files/Side Effects Software/Houdini 22.0.466/packages/ocio/cg-config-v3.0.0_aces-v2.0_ocio-v2.5.ocio', [['sRGB - Display', 'ACES 2.0 - SDR 100 nits (Rec.709)'], ['Rec.1886 Rec.709 - Display', 'ACES 2.0 - SDR 100 nits (Rec.709)']], ['ACEScg', 'sRGB Encoded Rec.709 (sRGB)', 'INV'], 0.98],
  ['C:/Program Files/Maxon Redshift 2026/Data/OCIO/maxon-cg-v1.0_ocio-v2.4.ocio', null, ['ACEScg', 'INV'], 0.98],
  ['C:/Program Files/Blender Foundation/Blender 4.1/4.1/datafiles/colormanagement/config.ocio', [['sRGB', 'AgX'], ['sRGB', 'Filmic'], ['sRGB', 'Standard']], ['Linear Rec.709', 'sRGB', 'INV'], 0.6],
  ['C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/OpenColorIO-Configs/ACES 1.2/config.ocio', [['ACES', 'sRGB']], ['ACES - ACEScg', 'Utility - sRGB - Texture', 'INV'], 0.4],
];
const hex = (c) => c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',');
let seed = 5;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
// floats as the app copies them: the fewest decimals (4 to 8) that land on the same hex as the exact values
const asCopied = (P, x) => { const want = hex(P.forward(x)); for (let d = 4; d <= 8; d++) { const r = x.map((q) => +q.toFixed(d)); if (hex(P.forward(r)) === want) return r; } return x.map((q) => +q.toFixed(8)); };
let failed = 0;
const fail = (msg) => { failed++; console.log('  FAIL ' + msg); };
(async () => {
  for (const [path, views0, inputs, floor] of CONFIGS) {
    if (!fs.existsSync(path)) { console.log('== skipped, not installed: ' + path); continue; }
    const io = { path, readText: async (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } } };
    const cfg = await E.load(fs.readFileSync(path, 'utf8'), io);
    const views = views0 || [[cfg.displays[0].name, cfg.displays[0].views[0].name]];
    console.log('== ' + (cfg.name || path));
    for (const [d, v] of views) {
      const fwdRef = await E.build(cfg, io, () => cfg.dvtOps(E.SCENE_REF, d, v));
      for (const inName of inputs) {
        let ops;
        if (inName === 'INV') ops = E.invertOps(fwdRef).concat(fwdRef);
        else ops = await E.build(cfg, io, () => cfg.dvtOps(inName, d, v));
        const P = E.processor(ops);
        const display = inName === 'INV' || /sRGB$|Invert|Texture|^sRGB/.test(inName) && !/Linear|scene-linear|Rec\.709\)/.test(inName);
        let exact = 0, typed = 0, out = 0;
        const t0 = Date.now();
        for (let k = 0; k < N; k++) {
          const t = [rnd(), rnd(), rnd()].map((x) => Math.round(x * 255) / 255);
          const x = P.inverse(t);
          if (!x.every(Number.isFinite)) { fail('not a number for ' + hex(t) + ' in ' + inName); continue; }
          if (hex(P.forward(x)) === hex(t)) exact++; else continue;
          const as255 = display && x.every((q) => q >= 0 && q <= 1);
          const asT = as255 ? x.map((q) => Math.round(q * 255) / 255) : asCopied(P, x);
          if (hex(P.forward(asT)) === hex(t)) typed++;
          else if (!as255) fail('copied floats miss ' + hex(t) + ' in ' + inName);
        }
        if (exact < floor * N) fail((d + ' / ' + v) + ', ' + inName + ': ' + exact + '/' + N + ' exact, expected at least ' + Math.ceil(floor * N));
        console.log('  ' + (d + ' / ' + v).padEnd(58) + (inName === 'INV' ? '(inverted view)' : inName).padEnd(32) + ' exact ' + exact + '/' + N + '  as typed ' + typed + '/' + N + '  ' + ((Date.now() - t0) / N).toFixed(2) + ' ms');
      }
    }
  }
  console.log(failed ? failed + ' failures' : 'solver ok');
  process.exitCode = failed ? 1 : 0;
})();
