from pathlib import Path
from PIL import Image
import numpy as np, json
root=Path(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets\residencial-v2")
files=list(root.rglob("*.png"))
groups={}
issues=[]
for p in files:
    im=Image.open(p)
    rel=p.relative_to(root).as_posix()
    if rel.startswith("properties/"): group="properties"
    elif rel.startswith("roofs/"): group="roofs"
    elif rel.startswith("objects/"): group="objects"
    elif "textures/samples/" in rel: group="samples"
    elif "textures/tiles/" in rel: group="tiles"
    else: group="other"
    groups[group]=groups.get(group,0)+1
    if "A" in im.getbands():
        a=np.asarray(im.getchannel("A"))
        transparent=int((a<255).sum())
    else: transparent=0
    if group in ("properties","roofs") and transparent==0:
        issues.append((rel,"no_transparency"))
    if group=="objects" and transparent==0:
        issues.append((rel,"opaque_structural_or_cutout_review"))
print("PNG_TOTAL",len(files),"GROUPS",groups)
print("ISSUES",issues)
for rel in ["objects/palm_corner_garden.png","properties/angled_front/traditional_pink.png","properties/top_down/traditional_red_roof.png","roofs/shapes/roof_gable_terracotta_red.png"]:
    p=root/rel; im=Image.open(p).convert("RGBA"); a=np.asarray(im.getchannel("A"))
    print("ALPHA",rel,im.size,round(100*(a<255).mean(),2),"corner_alpha",list(a[0,0:5]))
print("DIR_SIZE_MB",round(sum(p.stat().st_size for p in files)/1024/1024,2))
