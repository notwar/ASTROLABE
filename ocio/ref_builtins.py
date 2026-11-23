# Reference values for each OCIO builtin: forward on random inputs, and OCIO's inverse of those outputs.
import PyOpenColorIO as OCIO, json, random, math
rnd = random.Random(3)
cfg = OCIO.Config.CreateRaw()
out = {}
clean = lambda v: [None if (math.isnan(x) or math.isinf(x)) else x for x in v]
for style, desc in OCIO.BuiltinTransformRegistry().getBuiltins():
    if style.startswith('ACES-OUTPUT'):
        ins = [[0.18,0.18,0.18],[1,1,1],[0.001,0.001,0.001],[5,5,5]] + [[math.exp(rnd.uniform(-6,3)) * rnd.uniform(0.2,1) for _ in range(3)] for _ in range(40)]
        ins += [[rnd.uniform(-0.05, 2) for _ in range(3)] for _ in range(10)]
    else:
        ins = [[0.18,0.18,0.18],[0,0,0],[1,1,1]] + [[rnd.uniform(-0.1,1.2) for _ in range(3)] for _ in range(20)]
    t = OCIO.BuiltinTransform(style)
    try:
        f = cfg.getProcessor(t, OCIO.TRANSFORM_DIR_FORWARD).getDefaultCPUProcessor()
        outs = [clean(f.applyRGB(list(i))) for i in ins]
        try:
            b = cfg.getProcessor(t, OCIO.TRANSFORM_DIR_INVERSE).getDefaultCPUProcessor()
            back = [clean(b.applyRGB([x if x is not None else 0 for x in o])) for o in outs]
        except Exception as e:
            back = None
        out[style] = {'in': ins, 'out': outs, 'back': back}
    except Exception as e:
        out[style] = {'error': str(e)}
json.dump(out, open('ref_builtins.json','w'))
print(len(out))
