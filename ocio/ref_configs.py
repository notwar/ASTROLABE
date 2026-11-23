# Reference values from real OCIO 2.5 for test_engine.js: for every config, a sample of
# (input colour space, display, view) pairs, each with a few inputs and OCIO's outputs.
import PyOpenColorIO as OCIO, json, random, sys, math
CONFIGS = [
  r"C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\OpenColorIO-Configs\AS_STUDIO\AS_STUDIO_RS.ocio",
  r"C:\ProgramData\redshift\Data\OCIO\config.ocio",
  r"C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\OpenColorIO-Configs\ACES 1.2\config.ocio",
  r"C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\OpenColorIO-Configs\ACES 1.3 CG v1.0\cg-config-v1.0.0_aces-v1.3_ocio-v2.1.ocio",
  r"C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\OpenColorIO-Configs\ACES 1.3 Studio v1.0\studio-config-v1.0.0_aces-v1.3_ocio-v2.1.ocio",
  r"C:\Program Files\Blackmagic Design\DaVinci Resolve\Fusion\LUTs\DefaultConfig.ocio",
  r"C:\Program Files\Blender Foundation\Blender 4.1\4.1\datafiles\colormanagement\config.ocio",
  r"C:\Program Files\DJV2\etc\Color\nuke-default\config.ocio",
  r"C:\Program Files\DJV2\etc\Color\spi-anim\config.ocio",
  r"C:\Program Files\DJV2\etc\Color\spi-vfx\config.ocio",
  r"C:\Program Files\Maxon Cinema 4D 2026\resource\modules\c4d_base\ocio\config.ocio",
  r"C:\Program Files\Maxon Redshift 2026\Data\OCIO\maxon-cg-v1.0_ocio-v2.4.ocio",
  r"C:\Program Files\Maxon Redshift 2026\bin\cineware\resource\modules\c4d_base\ocio\maxon-cg-v1.1_ocio-v2.4.ocio",
  r"C:\Program Files\Maxon Redshift 2026\Plugins\Katana\9.0v1\OCIO\config.ocio",
  r"C:\Program Files\Nuke16.0v2\plugins\OCIOConfigs\configs\fn-nuke_studio-config-v1.0.0_aces-v1.3_ocio-v2.1.ocio",
  r"C:\Program Files\Nuke16.0v2\plugins\OCIOConfigs\configs\nuke-default\config.ocio",
  r"C:\Program Files\Side Effects Software\Houdini 21.0.559\packages\ocio\houdini-config-v2.1.0_aces-v1.3_ocio-v2.3.ocio",
  r"C:\Program Files\Side Effects Software\Houdini 22.0.466\packages\ocio\cg-config-v3.0.0_aces-v2.0_ocio-v2.5.ocio",
  r"C:\Program Files\Side Effects Software\Houdini 22.0.466\packages\ocio\houdini-config-v3.0.0_aces-v2.0_ocio-v2.5.ocio",
  r"C:\Program Files\Side Effects Software\Houdini 22.0.466\packages\ocio\reference-config-v3.0.0_aces-v2.0_ocio-v2.5.ocio",
  r"C:\Program Files\Side Effects Software\sidefx_packages\SideFXLabs22.0\optional\labs_ocio\aces_config.ocio",
  r"C:\Program Files\Adobe\Adobe After Effects 2026\Plug-ins\Effects\mochaAE\Resources\mochaui\resources\ocio\default\config.ocio",
  r"C:\Program Files (x86)\cineSync Play\ocioProfiles\config.ocio",
]
rnd = random.Random(7)
out = []
MAXPAIRS = int(sys.argv[1]) if len(sys.argv) > 1 else 120
for path in CONFIGS:
    entry = {'path': path, 'pairs': [], 'error': None}
    try:
        cfg = OCIO.Config.CreateFromFile(path)
    except Exception as e:
        entry['error'] = str(e); out.append(entry); continue
    spaces = [cs for cs in cfg.getColorSpaces(OCIO.SEARCH_REFERENCE_SPACE_ALL, OCIO.COLORSPACE_ACTIVE) if not cs.isData()]
    pairs = []
    for d in cfg.getDisplays():
        for v in cfg.getViews(d):
            for cs in spaces:
                pairs.append((cs, d, v))
    rnd.shuffle(pairs)
    for cs, d, v in pairs[:MAXPAIRS]:
        enc = cs.getEncoding()
        lin = enc in ('scene-linear', 'display-linear') or (not enc and cs.getReferenceSpaceType() == OCIO.REFERENCE_SPACE_SCENE and 'lin' in cs.getName().lower())
        ins = [[0.18, 0.18, 0.18], [0.0, 0.0, 0.0]] + [[rnd.uniform(0, 1.5 if lin else 1.0) for _ in range(3)] for _ in range(5)]
        p = {'cs': cs.getName(), 'display': d, 'view': v, 'in': ins}
        try:
            proc = cfg.getProcessor(cs.getName(), d, v, OCIO.TRANSFORM_DIR_FORWARD).getDefaultCPUProcessor()
            p['out'] = [[None if (math.isnan(x) or math.isinf(x)) else x for x in proc.applyRGB(list(i))] for i in ins]
        except Exception as e:
            p['error'] = str(e)
        entry['pairs'].append(p)
    out.append(entry)
    print(len(entry['pairs']), path, flush=True)
json.dump(out, open('ref_configs.json', 'w'))
