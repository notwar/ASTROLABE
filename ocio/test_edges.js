// Edge cases in the OCIO engine that once went wrong: broken configs must stop with an error (not hang),
// and curves with a zero offset or gamma 1 must give numbers at black. Runs in a second, needs no apps.
// node ocio/test_edges.js -> exit code 1 on a failure
const { execFileSync } = require('child_process');
const E = require('../ocio.js');
let failed = 0;
const check = (ok, name) => { if (!ok) failed++; console.log((ok ? 'ok   ' : 'FAIL ') + name); };

// 1. broken flow collections: each runs in its own process, killed after 3 s if it hangs
for (const yaml of ['colorspaces: [}]', 'roles: {a: [}', 'a: {b: c, ]}']) {
  let result;
  try {
    result = execFileSync(process.execPath, ['-e', 'try { require(process.argv[1]).parseYAML(process.argv[2]); console.log("read") } catch (e) { console.log("error") }', require.resolve('../ocio.js'), yaml], { timeout: 3000, encoding: 'utf8' }).trim();
  } catch (e) { result = 'hang'; }
  check(result === 'error', 'broken YAML stops with an error: ' + yaml + ' (' + result + ')');
}
for (const yaml of ['x: [a, b, c]', 'm: {a: 1, b: [2, 3]}', 'x: []', 'y: {}']) {
  let ok = true;
  try { E.parseYAML(yaml); } catch (e) { ok = false; }
  check(ok, 'good YAML still reads: ' + yaml);
}

// 2. ExponentWithLinearTransform edge cases: numbers everywhere, and forward then back gives the input
(async () => {
  for (const [g, o] of [[2.4, 0], [1, 0.055], [1, 0], [2.4, 0.055]]) {
    const yaml = 'ocio_profile_version: 2\nroles: {reference: lin}\ndisplays: {}\ncolorspaces:\n  - !<ColorSpace>\n    name: lin\n' +
      '  - !<ColorSpace>\n    name: c\n    to_scene_reference: !<ExponentWithLinearTransform> {gamma: [' + [g, g, g, 1] + '], offset: [' + [o, o, o, 0] + ']}\n';
    const io = { path: 'edge.ocio', readText: async () => null, getEnv: async () => null };
    const cfg = await E.load(yaml, io);
    const fwd = E.chain(await E.build(cfg, io, () => cfg.cstOps('c', 'lin')));
    const back = E.chain(await E.build(cfg, io, () => cfg.cstOps('lin', 'c')));
    const ins = [-0.1, 0, 0.02, 0.5, 1];
    const finite = ins.every((x) => fwd([x, x, x]).every(Number.isFinite));
    const err = Math.max(...ins.filter((x) => x >= 0).map((x) => Math.abs(back(fwd([x, x, x]))[0] - x)));
    check(finite && err < 1e-9, 'exponent with linear part, gamma ' + g + ' offset ' + o + ': numbers at black, round trip ' + err.toExponential(1));
  }
  console.log(failed ? failed + ' failures' : 'all edge cases pass');
  process.exitCode = failed ? 1 : 0;
})();
