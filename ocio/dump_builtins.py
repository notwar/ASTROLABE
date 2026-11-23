# Dumps every OCIO builtin transform as a list of primitive ops (exact numbers from OCIO itself).
# LUT1D data is left out (those curves are written out as formulas in the engine).
import PyOpenColorIO as OCIO, json, math
reg = OCIO.BuiltinTransformRegistry()
cfg = OCIO.Config.CreateRaw()
TT = OCIO.TransformType
F = lambda v: None if (v is None or math.isinf(v) or math.isnan(v)) else v
L = lambda a: [F(x) for x in a]
D = lambda t: 1 if t.getDirection() == OCIO.TRANSFORM_DIR_INVERSE else 0
def dump(t):
    tt = t.getTransformType()
    if tt == TT.TRANSFORM_TYPE_MATRIX:
        return ['M', D(t), L(t.getMatrix()), L(t.getOffset())]
    if tt == TT.TRANSFORM_TYPE_RANGE:
        g = lambda k: F(getattr(t,'get'+k)()) if getattr(t,'has'+k)() else None
        return ['R', D(t), [g('MinInValue'), g('MaxInValue'), g('MinOutValue'), g('MaxOutValue')], 0 if t.getStyle()==OCIO.RANGE_CLAMP else 1]
    if tt == TT.TRANSFORM_TYPE_LOG_AFFINE:
        return ['LA', D(t), t.getBase(), L(t.getLogSideSlopeValue()), L(t.getLogSideOffsetValue()), L(t.getLinSideSlopeValue()), L(t.getLinSideOffsetValue())]
    if tt == TT.TRANSFORM_TYPE_LOG_CAMERA:
        ls = None
        try:
            if t.isLinearSlopeValueSet(): ls = L(t.getLinearSlopeValue())
        except Exception: pass
        return ['LC', D(t), t.getBase(), L(t.getLogSideSlopeValue()), L(t.getLogSideOffsetValue()), L(t.getLinSideSlopeValue()), L(t.getLinSideOffsetValue()), L(t.getLinSideBreakValue()), ls]
    if tt == TT.TRANSFORM_TYPE_LOG:
        return ['L', D(t), t.getBase()]
    if tt == TT.TRANSFORM_TYPE_EXPONENT_WITH_LINEAR:
        return ['EL', D(t), L(t.getGamma()), L(t.getOffset()), str(t.getNegativeStyle()).split('_')[-1].lower()]
    if tt == TT.TRANSFORM_TYPE_EXPONENT:
        return ['E', D(t), L(t.getValue()), str(t.getNegativeStyle()).split('_')[-1].lower()]
    if tt == TT.TRANSFORM_TYPE_FIXED_FUNCTION:
        return ['FF', D(t), str(t.getStyle()).replace('FixedFunctionStyle.FIXED_FUNCTION_',''), L(t.getParams())]
    if tt == TT.TRANSFORM_TYPE_LUT1D:
        return ['LUT1D', D(t), t.getLength()]
    if tt == TT.TRANSFORM_TYPE_GRADING_RGB_CURVE:
        v = t.getValue()
        cv = v.master
        for nm in ('red','green','blue'):
            c = getattr(v, nm)
            assert [(p.x,p.y) for p in c.getControlPoints()] == [(0.0,0.0),(1.0,1.0)], 'non-identity channel curve'
        return ['CURVE', D(t), [[p.x, p.y] for p in cv.getControlPoints()], list(cv.getSlopes())]
    raise Exception('unknown ' + str(tt))
out = {}
for style, desc in reg.getBuiltins():
    g = cfg.getProcessor(OCIO.BuiltinTransform(style)).createGroupTransform()
    out[style] = [dump(c) for c in g]
json.dump(out, open('builtins_ops.json','w'), separators=(',',':'))
for k, v in out.items():
    s = [o for o in v if o[0] in ('E','EL','L','LUT1D')]
    if s: print(k, s)
