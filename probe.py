import PyOpenColorIO as OCIO
print(OCIO.__version__)
cfg = OCIO.Config.CreateFromFile(r"C:\ProgramData\redshift\Data\OCIO\config.ocio")
def proc(src, dst):
    return cfg.getProcessor(src, dst).getDefaultCPUProcessor()
p = proc("sRGB", "ACEScg")
for v in ([1,0,0],[0,1,0],[0,0,1],[0.5,0.5,0.5],[1,1,1]):
    print("sRGB->ACEScg", v, p.applyRGB(v))
p = proc("sRGB", "ACES2065-1")
for v in ([1,0,0],[0,1,0],[0,0,1]):
    print("sRGB->AP0", v, p.applyRGB(v))
p = proc("scene-linear Rec.709-sRGB", "ACEScg")
for v in ([1,0,0],[0,1,0],[0,0,1]):
    print("lin709->ACEScg", v, p.applyRGB(v))
dp = cfg.getProcessor("ACEScg", "sRGB", "ACES 1.0 SDR-video", OCIO.TRANSFORM_DIR_FORWARD).getDefaultCPUProcessor()
for v in ([0.18,0.18,0.18],[1,1,1],[1,0,0],[16,16,16],[0.01,0.02,0.5]):
    print("view", v, dp.applyRGB(v))
ip = proc("sRGB", "Invert ACES 1.0 SDR-video")
p = proc("Invert ACES 1.0 SDR-video", "ACEScg")
for v in ([0.5,0.5,0.5],[1,1,1],[1,0,0],[0.9,0.2,0.1]):
    print("inv", v, p.applyRGB(v))
