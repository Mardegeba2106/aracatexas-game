from pathlib import Path
from PIL import Image, ImageDraw, ImageOps, ImageChops, ImageFilter
import numpy as np, json, math
SRC=Path(r"C:\Users\guilh\Desktop\python\exemplos texturas")
ROOT=Path(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets\residencial-v2")
def crop_ref(im,b):
    k=min(720/im.width,720/im.height)
    return im.crop(tuple(round(v/k) for v in b))
def make_tile(src,feather=10):
    im=ImageChops.offset(src,src.width//2,src.height//2)
    a=np.asarray(im.convert("RGB")).astype(np.float32).copy(); h,w=a.shape[:2]
    for d in range(1,min(feather,w//8)+1):
        t=(min(feather,w//8)-d+1)/(min(feather,w//8)+1); x1=w//2-d; x2=w//2+d-1
        avg=(a[:,x1].copy()+a[:,x2].copy())/2
        a[:,x1]=a[:,x1]*(1-t)+avg*t; a[:,x2]=a[:,x2]*(1-t)+avg*t
    for d in range(1,min(feather,h//8)+1):
        t=(min(feather,h//8)-d+1)/(min(feather,h//8)+1); y1=h//2-d; y2=h//2+d-1
        avg=(a[y1].copy()+a[y2].copy())/2
        a[y1]=a[y1]*(1-t)+avg*t; a[y2]=a[y2]*(1-t)+avg*t
    return Image.fromarray(np.clip(a,0,255).astype(np.uint8))
# Grass patch chosen from a clean, unbroken lawn area in the original modern reference.
light=Image.open(SRC/"Gemini_Generated_Image_am03u7am03u7am03.jpg").convert("RGB")
grass=ImageOps.fit(crop_ref(light,(150,460,200,510)),(128,128),method=Image.Resampling.LANCZOS)
grass.save(ROOT/"textures/samples/grass.png",optimize=True)
make_tile(grass).save(ROOT/"textures/tiles/grass_tileable.png",optimize=True)
# Use the more interior water sample, away from the pool coping.
water=ImageOps.fit(crop_ref(light,(140,225,205,275)),(128,128),method=Image.Resampling.LANCZOS)
water.save(ROOT/"textures/samples/pool_water.png",optimize=True)
make_tile(water,12).save(ROOT/"textures/tiles/pool_water_tileable.png",optimize=True)
# Extract a garden-corner cluster with a chroma silhouette; checkerboard pixels are neutral and excluded.
crop=crop_ref(light,(8,25,92,175))
a=np.asarray(crop).astype(np.int16); sat=a.max(2)-a.min(2); mx=a.max(2)
mask=Image.fromarray((((sat>28)&(mx>55))*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9))
palm=crop.convert("RGBA"); palm.putalpha(mask); palm.save(ROOT/"objects/palm_corner_garden.png",optimize=True)
old=ROOT/"objects/palm_pair_garden_cluster.png"
if old.exists(): old.unlink()
# Rebuild catalogue and index for all PNG outputs.
files=sorted((ROOT/"properties").rglob("*.png"))+sorted((ROOT/"roofs").rglob("*.png"))+sorted((ROOT/"objects").glob("*.png"))+sorted((ROOT/"textures"/"samples").glob("*.png"))+sorted((ROOT/"textures"/"tiles").glob("*.png"))
cols=4; cw=260; ch=245; sh=Image.new("RGB",(cols*cw,math.ceil(len(files)/cols)*ch),(42,44,47)); d=ImageDraw.Draw(sh); idx=[]
for i,p in enumerate(files):
    im=Image.open(p).convert("RGBA"); t=im.copy(); t.thumbnail((240,210),Image.Resampling.LANCZOS); x=(i%cols)*cw+10; y=(i//cols)*ch+8
    bg=Image.new("RGBA",t.size,(75,78,82,255)); bg.alpha_composite(t); sh.paste(bg.convert("RGB"),(x,y)); d.text((x,y+214),p.stem[:38],fill=(245,245,240))
    al=np.asarray(im.getchannel("A")); tr=int((al<255).sum()); rel=p.relative_to(ROOT).as_posix()
    if rel.startswith("properties/"): cat="property-composition"; view="angled-front" if "angled_front" in rel else "top-down"
    elif rel.startswith("roofs/"): cat="roof-sprite"; view="top-down/roof-plane"
    elif rel.startswith("objects/"): cat="object-or-structural-module"; view="top-down/source-view"
    elif "/tiles/" in rel: cat="repeatable-surface"; view="tile"
    else: cat="material-sample"; view="sample"
    idx.append({"id":p.stem,"path":rel,"category":cat,"view":view,"width":im.width,"height":im.height,"mode":im.mode,"transparent_pixels":tr,"alpha_fraction":round(tr/(im.width*im.height),4),"tileable":cat=="repeatable-surface"})
sh.save(ROOT/"preview/catalogo_assets.jpg",quality=92,optimize=True)
(ROOT/"asset-index.json").write_text(json.dumps(idx,ensure_ascii=False,indent=2),encoding="utf-8")
# Repeatability previews and edge tests.
tile_qa={}
for p in sorted((ROOT/"textures"/"tiles").glob("*.png")):
    im=Image.open(p).convert("RGB"); a=np.asarray(im).astype(np.int16)
    tile_qa[p.stem]={"size":list(im.size),"edge_mean_abs_diff_x":round(float(np.abs(a[:,0]-a[:,-1]).mean()),2),"edge_mean_abs_diff_y":round(float(np.abs(a[0]-a[-1]).mean()),2)}
    if p.stem in ("grass_tileable","pool_water_tileable"):
        small=im.resize((64,64),Image.Resampling.NEAREST); rep=Image.new("RGB",(192,192))
        for yy in range(3):
            for xx in range(3): rep.paste(small,(xx*64,yy*64))
        rep.resize((384,384),Image.Resampling.NEAREST).save(ROOT/"preview"/(p.stem+"_repeat_test.png"))
qa=json.loads((ROOT/"reports/qa_v2.json").read_text(encoding="utf-8"))
qa["tile_edge_checks"]=tile_qa
qa["refinements"]={"grass_sample_crop_720px":[150,460,200,510],"pool_water_sample_crop_720px":[140,225,205,275],"palm_mask":"high-chroma plant/grass silhouette with 9px dilation; checkboard low-chroma pixels excluded","palm_asset":"palm_corner_garden.png"}
(ROOT/"reports/qa_v2.json").write_text(json.dumps(qa,ensure_ascii=False,indent=2),encoding="utf-8")
print("REFINED_2",len(files),"pngs")
