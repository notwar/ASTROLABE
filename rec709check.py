# Checks the page's Rec.709 output (ACES 1.0 SDR-video tone map + BT.1886 encoding) against OCIO's built-in transforms.
import PyOpenColorIO as OCIO, json, random
cfg = OCIO.Config.CreateFromFile(r"C:\ProgramData\redshift\Data\OCIO\config.ocio")
def chain(display):
    g = OCIO.GroupTransform()
    g.appendTransform(OCIO.ColorSpaceTransform("ACEScg", "ACES2065-1"))
    g.appendTransform(OCIO.BuiltinTransform("ACES-OUTPUT - ACES2065-1_to_CIE-XYZ-D65 - SDR-VIDEO_1.0"))
    g.appendTransform(OCIO.BuiltinTransform(display))
    return cfg.getProcessor(g).getDefaultCPUProcessor()
rec = chain("DISPLAY - CIE-XYZ-D65_to_REC.1886-REC.709")
srgb = chain("DISPLAY - CIE-XYZ-D65_to_sRGB")
random.seed(3)
cg = [[random.random()**2*4 for _ in range(3)] for _ in range(300)] + [[0.18]*3, [1,1,1], [16,16,16], [0,0,0]]
json.dump({"cg": cg, "rec709": [rec.applyRGB(v) for v in cg], "srgb": [srgb.applyRGB(v) for v in cg]}, open("rec709ref.json", "w"))
print("wrote rec709ref.json")
