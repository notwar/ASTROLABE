# ASTROLABE

Tells you what to type so a colour comes out right in the final film.

Give it the colour the final file must have (the brand colour). Pick the colour profile your app reads the value in. You get the numbers to type, as hex, RGB, HSL, HSV and float.

Works for After Effects, Resolve, Cinema 4D, Houdini or anything else that uses OCIO.

## Run it (Windows)

Double-click `ASTROLABE.exe`. Nothing to install, and it opens straight away. It's one small file (about 1 MB) that uses the Edge engine already built into Windows.

To keep it in the taskbar: while it's open, right-click its taskbar icon and choose **Pin to taskbar**.

Run it straight from this folder or copy the exe anywhere you like.

Closing the window hides it to the tray (the ASTROLABE icon by the clock). It starts there when Windows starts, so the shortcut below always works. To stop it, right-click the tray icon and choose **Quit**. Untick **Start with Windows** in that menu or in the gear menu if you don't want it at login.

### Shortcut

Press **Win+Shift+C** in any app to pick a colour from the screen. ASTROLABE opens with that colour as the Output. Esc cancels and leaves it in the tray.

To use other keys, open the gear menu, click the keys under **Shortcut** and press the new ones (Win, Ctrl or Alt, plus a letter, number or F key). If another app already uses them, it says so and keeps the old keys. PowerToys Color Picker uses Win+Shift+C too: turn that off in PowerToys, or give ASTROLABE other keys.

`ASTROLABE.exe --pick` starts straight in the picker, for a desktop shortcut or a mouse button.

## Colour config

Out of the box it uses its built-in config, **AS_STUDIO ACES 1.0**: the ACES 1.0 SDR-video view with sRGB and Rec.709 outputs, the same maths as the studio's AS_STUDIO_RS config.

To use another OCIO config, click the gear (or the config name next to it):

- **On this PC** lists the configs that come with After Effects, Redshift, Cinema 4D, Houdini, Blender and Nuke, plus `$OCIO` if it's set. Click one to use it.
- **Load config…** opens any `.ocio` file, such as the studio's AS_STUDIO_RS config.
- **Built in** goes back to AS_STUDIO ACES 1.0.

The app opens with the last config you used. To always open with one config, pick it and click **Make this the default** at the bottom of the menu (it gets a DEFAULT tag; **Clear default** goes back to the last one used). With a config loaded, the left dropdown lists its displays and views, and the right one lists its colour spaces. Entries marked **(inverted)** undo a view: with that same view as the output, you type the final colour as is.

It runs ACES 1.x and ACES 2.0 configs, LUT-based ones (ACES 1.2, Blender, Nuke) and most others. A few things it can't calculate (film-scan ADX spaces, CLF/CSP LUT files). If you pick one of those, a note says so.

## Mac

Open `ASTROLABE.html` in Chrome or Safari and bookmark it. **Load config…** asks for the `.ocio` file. If the config uses LUT files, pick its folder when asked.

## Using it

- **Output** (left): the colour space of the final file and the colour it must have. **Input** (right): the colour space your app works in, and the values to type there.
- Each side has its hex, three sliders (switch between RGB, HSL and HSV) and the Float values. The slider colours show what each position gives in the final file.
- The eyedropper next to the Output hex takes the colour from anything on screen (a PDF, a website, a frame). The screen freezes, the cursor becomes a pipette with a chip of the colour under it, and a magnifier shows the pixels around it: click a pixel to pick it. Arrow keys move one pixel, Esc cancels. Works on every monitor. On a Mac, Chrome and Edge have this too; Safari doesn't.
- The row at the bottom keeps your last 8 Output colours, newest first. Click one to use it again.
- **Always on top** (right-click anywhere in the window, the gear menu, or the tray menu) keeps the window above other apps, handy next to a full-screen After Effects. It stays on until you untick it.
- Change either side. The side you changed last drives the other.
- Drag any number box left or right to change it. Shift is faster, Ctrl is finer.
- The note with a tick checks the numbers as you'd type them. Notes with a ! warn when a value falls outside its colour space or would clip.
- Hover the **?** for the full explanation.

## Licences

ASTROLABE is ANTI STUDIO's own tool. It contains or is based on the following third-party work. Their licences ask for these notices to travel with the app, so keep this section with any copy you share.

- **OpenColorIO** (BSD-3-Clause). ASTROLABE's colour engine reproduces OpenColorIO 2.5 behaviour: the ACES 2.0 output transform and the ACES fixed functions are ported from its source, and its builtin transforms are stored as numbers taken from OCIO 2.5.
- **Academy Color Encoding System (ACES)**. The built-in AS_STUDIO ACES 1.0 maths follow the ACES 1.0.3 reference (CTL) transforms.
- **Microsoft WebView2 SDK** (BSD-style). The Windows app packs three Microsoft DLLs (Microsoft.Web.WebView2.Core, .WinForms and WebView2Loader) from the WebView2 SDK 1.0.4191.47.

The fonts (Instrument Sans, JetBrains Mono) load from Google Fonts under the SIL Open Font License and aren't packed into the app.

### OpenColorIO

```
Copyright Contributors to the OpenColorIO Project.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Academy Color Encoding System (ACES)

```
License Terms for Academy Color Encoding System Components

Academy Color Encoding System (ACES) software and tools are provided by the
Academy under the following terms and conditions: A worldwide, royalty-free,
non-exclusive right to copy, modify, create derivatives, and use, in source and
binary forms, is hereby granted, subject to acceptance of this license.

Copyright © 2015 Academy of Motion Picture Arts and Sciences (A.M.P.A.S.).
Portions contributed by others as indicated. All rights reserved.

Performance of any of the aforementioned acts indicates acceptance to be bound
by the following terms and conditions:

* Copies of source code, in whole or in part, must retain the above copyright
notice, this list of conditions and the Disclaimer of Warranty.

* Use in binary form must retain the above copyright notice, this list of
conditions and the Disclaimer of Warranty in the documentation and/or other
materials provided with the distribution.

* Nothing in this license shall be deemed to grant any rights to trademarks,
copyrights, patents, trade secrets or any other intellectual property of
A.M.P.A.S. or any contributors, except as expressly stated herein.

* Neither the name "A.M.P.A.S." nor the name of any other contributors to this
software may be used to endorse or promote products derivative of or based on
this software without express prior written permission of A.M.P.A.S. or the
contributors, as appropriate.

This license shall be construed pursuant to the laws of the State of
California, and any disputes related thereto shall be subject to the
jurisdiction of the courts therein.

Disclaimer of Warranty: THIS SOFTWARE IS PROVIDED BY A.M.P.A.S. AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
NON-INFRINGEMENT ARE DISCLAIMED. IN NO EVENT SHALL A.M.P.A.S., OR ANY
CONTRIBUTORS OR DISTRIBUTORS, BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, RESITUTIONARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE
OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

WITHOUT LIMITING THE GENERALITY OF THE FOREGOING, THE ACADEMY SPECIFICALLY
DISCLAIMS ANY REPRESENTATIONS OR WARRANTIES WHATSOEVER RELATED TO PATENT OR
OTHER INTELLECTUAL PROPERTY RIGHTS IN THE ACADEMY COLOR ENCODING SYSTEM, OR
APPLICATIONS THEREOF, HELD BY PARTIES OTHER THAN A.M.P.A.S.,WHETHER DISCLOSED OR
UNDISCLOSED.
```

### Microsoft WebView2 SDK

```
Copyright (C) Microsoft Corporation. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * The name of Microsoft Corporation, or the names of its contributors
may not be used to endorse or promote products derived from this
software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
