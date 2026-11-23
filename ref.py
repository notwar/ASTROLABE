import PyOpenColorIO as OCIO, json, random
cfg = OCIO.Config.CreateFromFile(r"C:\ProgramData\redshift\Data\OCIO\config.ocio")
P = lambda s,d: cfg.getProcessor(s,d).getDefaultCPUProcessor()
out = {}
def cols(p):
    return [p.applyRGB(v) for v in ([1,0,0],[0,1,0],[0,0,1])]
out["srgb_to_cg_cols"] = cols(P("sRGB","ACEScg"))
out["srgb_to_ap0_cols"] = cols(P("sRGB","ACES2065-1"))
out["cg_to_ap0_cols"] = cols(P("ACEScg","ACES2065-1"))
random.seed(1)
srgb = [[random.random() for _ in range(3)] for _ in range(300)] + [[0,0,0],[1,1,1],[1,0,0],[0,1,0],[0,0,1],[0.5,0.5,0.5],[0.02,0.01,0.0],[0.99,0.98,0.97]]
out["srgb"] = srgb
out["tex_cg"] = [P("sRGB","ACEScg").applyRGB(v) for v in srgb]
out["tex_cct"] = [P("sRGB","ACEScct").applyRGB(v) for v in srgb]
inv = P("sRGB","Invert ACES 1.0 SDR-video"); i2 = P("Invert ACES 1.0 SDR-video","ACEScg")
out["inv_cg"] = [i2.applyRGB(v) for v in srgb]
dp = cfg.getProcessor("ACEScg","sRGB","ACES 1.0 SDR-video",OCIO.TRANSFORM_DIR_FORWARD).getDefaultCPUProcessor()
cg = [[random.random()**2*4 for _ in range(3)] for _ in range(300)] + [[0.18,0.18,0.18],[1,1,1],[16,16,16],[100,1,0.1],[0,0,0],[-0.01,0.2,0.3],[1,0,0],[0,0,1]]
out["cg"] = cg
out["view_srgb"] = [dp.applyRGB(v) for v in cg]
json.dump(out, open("ref.json","w"))
print(out["srgb_to_cg_cols"]); print(out["srgb_to_ap0_cols"]); print(out["cg_to_ap0_cols"])
