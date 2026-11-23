// Rebuilds srgb-aces-converter.html by inlining core.js (the built-in AS_STUDIO ACES 1.0 maths), the OCIO engine
// (ocio.js) and its builtin catalogue (ocio/builtins_ops.json, dumped from OCIO 2.5) into template.html,
// and copies it into app\ as "ASTROLABE.html" (the file the team app opens).
// Run from this folder: node build.js
const fs = require('fs');
const path = require('path');
const here = __dirname;
const t = fs.readFileSync(path.join(here, 'template.html'), 'utf8');
// numbers in the catalogue rounded to 12 significant digits: far below any visible difference, half the size
const builtins = JSON.stringify(JSON.parse(fs.readFileSync(path.join(here, 'ocio', 'builtins_ops.json'), 'utf8')), (k, v) =>
  typeof v === 'number' && !Number.isInteger(v) ? +v.toPrecision(12) : v);
const c = fs.readFileSync(path.join(here, 'core.js'), 'utf8') + '\nconst OCIO_BUILTINS = ' + builtins + ';\n' +
  fs.readFileSync(path.join(here, 'ocio.js'), 'utf8');
const html = t.replace('/*CORE*/', () => c);
fs.writeFileSync(path.join(here, 'srgb-aces-converter.html'), html);
// the published artifact gets its document skeleton from the host; the app file needs its own
const page = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<style>:root{color-scheme:light}body{margin:0}[hidden]{display:none!important}</style>\n</head>\n<body>\n' + html + '\n</body>\n</html>\n';
fs.writeFileSync(path.join(here, 'app', 'ASTROLABE.html'), page);
console.log('built srgb-aces-converter.html and app/ASTROLABE.html');

// node build.js --deploy also copies the app to a shared folder. Build the exe first: node native/build_native.js
// The folder is the first line of deploy-path.txt next to this file. That file stays on this PC (it's in .gitignore).
if (process.argv.includes('--deploy')) {
  const cfg = path.join(here, 'deploy-path.txt');
  const team = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8').split(/\r?\n/)[0].trim() : '';
  if (!team) { console.log('no deploy folder: put its path on the first line of deploy-path.txt'); process.exit(1); }
  fs.mkdirSync(team, { recursive: true });
  for (const f of ['ASTROLABE.html', 'README.md']) fs.copyFileSync(path.join(here, 'app', f), path.join(team, f));
  const exe = path.join(here, 'native', 'dist', 'ASTROLABE.exe'); // the native one
  if (fs.existsSync(exe)) fs.copyFileSync(exe, path.join(team, 'ASTROLABE.exe'));
  else console.log('no exe built yet: run node native/build_native.js first');
  console.log('deployed to ' + team);
}
