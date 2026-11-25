# ASTROLABE

ASTROLABE is a standalone OCIO able color picker, catered towards CGI artists. It helps navigate color between color profiles, so what you see is what you get.

- Built-in ACES 1.0 maths with sRGB and Rec.709 outputs
- Loads any OCIO config, or picks one already on your PC (After Effects, Redshift, Cinema 4D, Houdini, Blender, Nuke)
- Colour picker with a screen eyedropper that works on every monitor
- Remembers your default config
- Windows-wide shortcut to launch the color picker (Shift + Alt + C)

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
| `app/` | User README, icon, and the old Edge-app installer |
| `ref*.py`, `*.json` | Reference values from OCIO itself, used by the tests |

## Build

Needs Node.js. The exe also needs Windows (it uses the C# compiler that ships with Windows).

```
node build.js                  # page only: app/ASTROLABE.html
node native/build_native.js    # page + native/dist/ASTROLABE.exe
node build.js --deploy         # copies exe, html and README to a shared folder
```

`--deploy` reads the folder from the first line of `deploy-path.txt`. That file is yours to create and stays out of git.

## Test

```
node test.js                   # built-in maths vs OCIO
node ocio/test_engine.js       # OCIO engine vs 22 real configs
node ocio/test_builtins.js     # every OCIO builtin transform
node ocio/test_solver.js       # "what to type" solver on random colours
node ae/tests/test_colour.js   # AE panel: picker maths and OCIO on AE's own configs
node ae/tests/test_host.js     # AE panel: host script against a mock of AE
```

The reference files come from PyOpenColorIO 2.5 (in Houdini 22.0.466's Python). Re-make them with `ref.py`, `rec709check.py`, `ocio/ref_configs.py` and `ocio/ref_builtins.py` run through hython.

## Third-party files

`native/lib/` holds Microsoft's WebView2 SDK 1.0.4191.47 DLLs from nuget.org, signed by Microsoft. See `native/lib/SOURCE.txt`.
