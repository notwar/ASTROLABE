# ASTROLABE

ASTROLABE is a standalone OCIO able color picker, catered towards CGI artists. It helps navigate color between color profiles, so what you see is what you get.

- Built-in ACES 1.0 maths with sRGB and Rec.709 outputs
- Loads any OCIO config, or picks one already on your PC (After Effects, Redshift, Cinema 4D, Houdini, Blender, Nuke)
- Colour picker with a screen eyedropper that works on every monitor
- Remembers your default config
- Windows-wide shortcut to launch the color picker (Win + Shift + C by default, changeable in the app)

The user guide is [app/README.md](app/README.md). This page is for building it.

## What's where

| Path | What it is |
|---|---|
| `template.html` | The page: layout, styles, UI code |
| `core.js` | Built-in maths (AS_STUDIO ACES 1.0) |
| `ocio.js` | Our own OCIO engine: reads any `.ocio` config and its LUTs |
| `ocio/` | OCIO builtin transforms (`builtins_ops.json`) and the engine tests |
| `build.js` | Puts it all into one HTML file |
| `native/` | The Windows exe: C# + WebView2, about 1 MB |
| `app/` | User README, logo and icon (`make_icon.py` makes the icon from the logo) |
| `ref*.py`, `*.json` | Reference values from OCIO itself, used by the tests |

## Build

Needs Node.js. The exe also needs Windows (it uses the C# compiler that ships with Windows).

```
node build.js                  # page only: app/ASTROLABE.html
node native/build_native.js    # page + native/dist/ASTROLABE.exe
node build.js --deploy         # quick tests, then page + exe, then copies exe, html and README to a shared folder
```

`--deploy` reads the folder from the first line of `deploy-path.txt`. That file is yours to create and stays out of git. It runs `test.js`, `ocio/test_edges.js` and `ocio/test_builtins.js` first and builds the page and the exe together, so the exe always holds the current page. If a test or the build fails, nothing is copied.

## Test

```
node test.js                   # built-in maths vs OCIO
node ocio/test_engine.js       # OCIO engine vs 22 real configs
node ocio/test_builtins.js     # every OCIO builtin transform
node ocio/test_solver.js       # "what to type" solver on random colours
node ocio/test_edges.js        # broken configs and curve edge cases (no apps needed)
```

Each test ends with exit code 1 when something is wrong. `test_engine.js` and `test_solver.js` use the configs installed on this PC and skip the ones that aren't there. `test_engine.js` counts two kinds of differences from OCIO apart, not as failures: samples where our answer runs back through the config exactly and OCIO's doesn't (OCIO approximates LUTs run backwards), and samples with no exact answer at all. Its `KNOWN` list holds the one accepted difference (Blender's False Color view).

`ocio/ref_configs.json` is made from the OCIO configs of other apps (Adobe, Maxon, SideFX and so on), so it stays on the PC that made it and is not in git; without it `test_engine.js` skips. ASTROLABE bundles no configs or LUTs: people load their own.

The reference files come from PyOpenColorIO 2.5 (in Houdini 22.0.466's Python). Re-make them with `ref.py`, `ocio/ref_configs.py` and `ocio/ref_builtins.py` run through hython.

## Third-party files

`native/lib/` holds Microsoft's WebView2 SDK 1.0.4191.47 DLLs from nuget.org, signed by Microsoft. See `native/lib/SOURCE.txt`.
