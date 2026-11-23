// Builds native\dist\ASTROLABE.exe: one small exe, no install.
// Uses the C# compiler that ships with Windows (.NET Framework 4.x). Run from the project folder:
//   node native/build_native.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const here = __dirname;
const root = path.join(here, '..');

execFileSync(process.execPath, [path.join(root, 'build.js')], { stdio: 'inherit' }); // fresh page
const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const lib = (f) => path.join(here, 'lib', f);
const dist = path.join(here, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, 'ASTROLABE.exe');
const args = [
  '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
  '/out:' + out,
  '/win32icon:' + path.join(root, 'app', 'icon.ico'),
  '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  '/r:' + lib('Microsoft.Web.WebView2.Core.dll'), '/r:' + lib('Microsoft.Web.WebView2.WinForms.dll'),
  '/resource:' + lib('Microsoft.Web.WebView2.Core.dll') + ',Microsoft.Web.WebView2.Core.dll',
  '/resource:' + lib('Microsoft.Web.WebView2.WinForms.dll') + ',Microsoft.Web.WebView2.WinForms.dll',
  '/resource:' + lib('WebView2Loader.dll') + ',WebView2Loader.dll',
  '/resource:' + path.join(root, 'app', 'ASTROLABE.html') + ',app.html',
  path.join(here, 'Program.cs'),
];
execFileSync(csc, args, { stdio: 'inherit' });
console.log('built ' + out + ' (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
