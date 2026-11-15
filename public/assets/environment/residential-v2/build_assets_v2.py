from pathlib import Path
from PIL import Image, ImageDraw, ImageOps, ImageChops
import numpy as np, json, math

SRC = Path(r"C:\Users\guilh\Desktop\python\exemplos texturas")
BASE = Path(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets")
V1 = BASE / "residencial-v1"
ROOT = BASE / "residencial-v2"
for d in ["properties/top_down","properties/angled_front","roofs/shapes","textures/samples","textures/tiles","objects","preview","reports","tools"]:
    (ROOT/d).mkdir(parents=True, exist_ok=True)

FILES = {
 "traditional_pink":"Gemini_Generated_Image_397pfo397pfo397p.jpg",
 "traditional_yellow":"Gemini_Generated_Image_4gs3u44gs3u44gs3.jpg",
 "modern_pool_light":"Gemini_Generated_Image_am03u7am03u7am03.jpg",
 "modern_compact":"Gemini_Generated_Image_cmea5icmea5icmea.jpg",
 "traditional_teal":"Gemini_Generated_Image_dwtzxzdwtzxzdwtz.jpg",
 "modern_pool_dark":"Gemini_Generated_Image_kh6d0okh6d0okh6d.jpg",
 "modern_narrow_flat":"Gemini_Generated_Image_md8es9md8es9md8e.jpg",
 "modern_long_pool":"Gemini_Generated_Image_qu0dviqu0dviqu0d.jpg",
 "traditional_red_roof":"Gemini_Generated_Image_u7qjq2u7qjq2u7qj.jpg",
 "modern_gray":"Gemini_Generated_Image_z9u8ljz9u8ljz9u8.jpg"
}
FRONT={"traditional_pink","traditional_yellow","traditional_teal"}
PROPERTY_POLYS={
 "traditional_pink":[(52,128),(126,128),(165,105),(347,66),(505,103),(670,128),(670,678),(52,678)],
 "traditional_yellow":[(52,128),(126,128),(165,105),(347,66),(505,103),(670,128),(670,678),(52,678)],
 "traditional_teal":[(52,128),(126,128),(165,105),(347,66),(505,103),(670,128),(670,678),(52,678)],
 "modern_pool_light":[(12,38),(708,38),(716,708),(10,708)],
 "modern_pool_dark":[(12,38),(708,38),(716,708),(10,708)],
 "modern_compact":[(80,78),(640,78),(640,485),(640,565),(720,565),(720,720),(0,720),(0,565),(80,565),(80,485)],
 "modern_narrow_flat":[(176,70),(544,70),(544,636),(176,636)],
 "modern_long_pool":[(127,0),(439,0),(438,705),(108,705)],
 "traditional_red_roof":[(42,34),(492,34),(496,58),(496,665),(485,684),(45,684),(34,664),(34,55)],
 "modern_gray":[(78,56),(642,56),(680,600),(720,720),(0,720),(0,600),(78,600)]
}
grid_report=json.loads((V1/"reports/grid_cleanup_report.json").read_text(encoding="utf-8"))

def repair_band(a,s,e,axis):
    if axis==0:
        lo=max(0,s-3); hi=min(a.shape[0]-1,e+3)
        left=a[lo].astype(np.float32); right=a[hi].astype(np.float32); den=max(1,hi-lo)
        for y in range(s,e+1):
            t=(y-lo)/den
            a[y]=np.clip(left*(1-t)+right*t,0,255).astype(np.uint8)
    else:
        lo=max(0,s-3); hi=min(a.shape[1]-1,e+3)
        left=a[:,lo].astype(np.float32); right=a[:,hi].astype(np.float32); den=max(1,hi-lo)
        for x in range(s,e+1):
            t=(x-lo)/den
            a[:,x]=np.clip(left*(1-t)+right*t,0,255).astype(np.uint8)
    return a

def flood8(c):
    h,w=c.shape; seen=np.zeros((h,w),dtype=bool)
    stack=[(0,x) for x in range(w)]+[(h-1,x) for x in range(w)]+[(y,0) for y in range(1,h-1)]+[(y,w-1) for y in range(1,h-1)]
    while stack:
        y,x=stack.pop()
        if x<0 or x>=w or y<0 or y>=h or seen[y,x] or not c[y,x]: continue
        l=x; r=x
        while l>0 and c[y,l-1] and not seen[y,l-1]: l-=1
        while r<w-1 and c[y,r+1] and not seen[y,r+1]: r+=1
        seen[y,l:r+1]=True
        for ny in (y-1,y+1):
            if 0<=ny<h:
                lo=max(0,l-1); hi=min(w,r+2)
                q=c[ny,lo:hi] & (~seen[ny,lo:hi]); inds=np.flatnonzero(q)
                if len(inds):
                    starts=[int(inds[0])]
                    for k in range(1,len(inds)):
                        if inds[k]>inds[k-1]+1: starts.append(int(inds[k]))
                    stack.extend((ny,lo+z) for z in starts)
    return seen

def remove_bg(im):
    a=np.asarray(im.convert("RGB")).copy()
    mx=a.max(2).astype(np.int16); mn=a.min(2).astype(np.int16); mean=a.mean(2)
    candidates=((mx-mn)<=18) & (mean>=168)
    bg=flood8(candidates)
    rgba=np.dstack([a,np.where(bg,0,255).astype(np.uint8)])
    return Image.fromarray(rgba), int(bg.sum())

def trim(im,pad=3):
    a=np.asarray(im.getchannel("A")); y,x=np.where(a>8)
    if len(x): return im.crop((max(0,x.min()-pad),max(0,y.min()-pad),min(im.width,x.max()+1+pad),min(im.height,y.max()+1+pad)))
    return im

def scale(im,path,limit=768):
    im=trim(im)
    if max(im.size)>limit:
        k=limit/max(im.size)
        im=im.resize((max(1,round(im.width*k)),max(1,round(im.height*k))),Image.Resampling.LANCZOS)
    im.save(path,optimize=True)

def ref_scale(im):
    return min(720/im.width,720/im.height)

def crop_ref(im,b):
    k=ref_scale(im)
    return im.crop(tuple(round(v/k) for v in b))

def poly(im,pts,path,limit=600):
    k=ref_scale(im)
    mask=Image.new("L",im.size,0)
    ImageDraw.Draw(mask).polygon([(round(x/k),round(y/k)) for x,y in pts],fill=255)
    o=im.copy()
    o.putalpha(ImageChops.multiply(o.getchannel("A"),mask))
    scale(o,path,limit)

def sample(name,key,b):
    p=ImageOps.fit(crop_ref(imgs[key],b).convert("RGB"),(128,128),method=Image.Resampling.LANCZOS)
    p.save(ROOT/"textures"/"samples"/(name+".png"),optimize=True)

def make_tile(src,feather=10):
    im=ImageChops.offset(src,src.width//2,src.height//2)
    a=np.asarray(im.convert("RGB")).astype(np.float32).copy()
    h,w=a.shape[:2]; fx=min(feather,w//8); fy=min(feather,h//8)
    for d in range(1,fx+1):
        t=(fx-d+1)/(fx+1)
        x1=w//2-d; x2=w//2+d-1
        avg=(a[:,x1].copy()+a[:,x2].copy())/2
        a[:,x1]=a[:,x1]*(1-t)+avg*t
        a[:,x2]=a[:,x2]*(1-t)+avg*t
    for d in range(1,fy+1):
        t=(fy-d+1)/(fy+1)
        y1=h//2-d; y2=h//2+d-1
        avg=(a[y1].copy()+a[y2].copy())/2
        a[y1]=a[y1]*(1-t)+avg*t
        a[y2]=a[y2]*(1-t)+avg*t
    return Image.fromarray(np.clip(a,0,255).astype(np.uint8))

imgs={}; qa={}
for key,fn in FILES.items():
    raw=Image.open(SRC/fn).convert("RGB"); a=np.asarray(raw).copy(); meta=grid_report.get(key,{})
    for s,e in meta.get("grid_rows",[]):
        if e<a.shape[0]: a=repair_band(a,s,e,0)
    for s,e in meta.get("grid_columns",[]):
        if e<a.shape[1]: a=repair_band(a,s,e,1)
    fixed=Image.fromarray(a)
    rgba,removed=remove_bg(fixed)
    imgs[key]=rgba
    qa[key]={"source":fn,"source_size":list(raw.size),"removed_background_pixels":removed,"removed_background_pct":round(100*removed/(raw.width*raw.height),2),"guide_rows_repaired":meta.get("grid_rows",[]),"guide_columns_repaired":meta.get("grid_columns",[])}

for key in FILES:
    sub="angled_front" if key in FRONT else "top_down"
    poly(imgs[key],PROPERTY_POLYS[key],ROOT/"properties"/sub/(key+".png"),768)

poly(imgs["modern_pool_light"],[(270,115),(540,115),(545,289),(468,359),(389,359),(389,300),(270,300)],ROOT/"roofs/shapes/roof_hipped_light_ceramic.png")
poly(imgs["modern_pool_dark"],[(270,115),(540,115),(545,289),(468,359),(389,359),(389,300),(270,300)],ROOT/"roofs/shapes/roof_hipped_brown_ceramic.png")
poly(imgs["traditional_pink"],[(165,105),(350,66),(503,105),(500,423),(350,448),(164,423)],ROOT/"roofs/shapes/roof_gable_terracotta_red.png")
poly(imgs["modern_narrow_flat"],[(181,74),(417,74),(417,350),(181,350)],ROOT/"roofs/shapes/roof_flat_concrete_solar.png")

SPECS=[
 ("roof_terracotta_orange","traditional_pink",(260,130,345,220)),
 ("roof_terracotta_shadow","traditional_pink",(375,130,465,220)),
 ("roof_ceramic_light","modern_pool_light",(295,145,460,265)),
 ("roof_ceramic_brown","modern_pool_dark",(295,145,460,265)),
 ("concrete_roof","modern_compact",(190,35,410,115)),
 ("roof_corrugated_gray","traditional_pink",(520,250,660,315)),
 ("roof_corrugated_red","traditional_pink",(520,325,660,415)),
 ("sidewalk_pavers","modern_pool_light",(205,645,445,705)),
 ("grass","modern_pool_dark",(145,345,235,445)),
 ("pool_water","modern_pool_light",(130,205,218,287)),
 ("terracotta_patio","traditional_pink",(235,525,480,567)),
 ("dark_pavers","modern_pool_dark",(205,645,445,705))
]
for spec in SPECS: sample(*spec)

tile_names=["roof_terracotta_orange","roof_terracotta_shadow","roof_corrugated_gray","roof_corrugated_red","sidewalk_pavers","grass","pool_water","terracotta_patio","dark_pavers"]
for name in tile_names:
    src=Image.open(ROOT/"textures"/"samples"/(name+".png")).convert("RGB")
    make_tile(src).save(ROOT/"textures"/"tiles"/(name+"_tileable.png"),optimize=True)

for name,key,b,lim in [
 ("air_conditioning_units_rooftop_cluster","modern_pool_light",(475,52,582,112),384),
 ("water_tank_rooftop","modern_pool_light",(260,48,337,110),320),
 ("double_garage_gate_light","modern_pool_light",(241,561,397,621),512),
 ("pedestrian_gate_light","modern_pool_light",(455,560,518,624),384),
 ("front_wall_left_segment","modern_pool_light",(18,562,82,630),256),
 ("street_bin","modern_pool_light",(547,619,572,665),256)
]:
    crop=crop_ref(imgs[key],b)
    scale(crop,ROOT/"objects"/(name+".png"),lim)

poly(imgs["modern_pool_light"],[(80,544),(110,535),(165,544),(192,566),(199,618),(188,675),(98,682),(80,648)],ROOT/"objects/tree_with_planter.png",512)
poly(imgs["modern_pool_light"],[(13,36),(77,37),(91,103),(89,188),(17,189),(8,131)],ROOT/"objects/palm_pair_garden_cluster.png",512)
poly(imgs["modern_pool_light"],[(120,190),(225,190),(230,298),(117,298)],ROOT/"objects/pool_with_deck_and_umbrella.png",512)
poly(imgs["modern_pool_dark"],[(46,145),(125,140),(145,180),(142,250),(110,264),(55,238)],ROOT/"objects/poolside_lounge_set.png",384)
poly(imgs["modern_narrow_flat"],[(185,75),(285,75),(292,146),(185,146)],ROOT/"objects/solar_panels_cluster.png",384)
poly(imgs["modern_pool_light"],[(247,452),(311,452),(319,541),(248,543)],ROOT/"objects/car_light_topdown.png",384)
poly(imgs["modern_pool_dark"],[(247,452),(311,452),(319,541),(248,543)],ROOT/"objects/car_red_topdown.png",384)
poly(imgs["modern_pool_light"],[(306,452),(380,452),(385,543),(307,543)],ROOT/"objects/car_silver_topdown.png",384)
poly(imgs["modern_pool_light"],[(15,390),(222,390),(235,540),(18,540)],ROOT/"objects/shrub_flowerbed_cluster.png",512)

files=sorted((ROOT/"properties").rglob("*.png"))+sorted((ROOT/"roofs").rglob("*.png"))+sorted((ROOT/"objects").glob("*.png"))+sorted((ROOT/"textures"/"samples").glob("*.png"))+sorted((ROOT/"textures"/"tiles").glob("*.png"))
cols=4; cw=260; ch=245
sheet=Image.new("RGB",(cols*cw,math.ceil(len(files)/cols)*ch),(42,44,47)); draw=ImageDraw.Draw(sheet); index=[]
for i,f in enumerate(files):
    im=Image.open(f).convert("RGBA"); thumb=im.copy(); thumb.thumbnail((240,210),Image.Resampling.LANCZOS)
    x=(i%cols)*cw+10; y=(i//cols)*ch+8
    bg=Image.new("RGBA",thumb.size,(75,78,82,255)); bg.alpha_composite(thumb)
    sheet.paste(bg.convert("RGB"),(x,y)); draw.text((x,y+214),f.stem[:38],fill=(245,245,240))
    alpha=np.asarray(im.getchannel("A")) if "A" in im.getbands() else None
    transparent=int((alpha<255).sum()) if alpha is not None else 0
    rel=f.relative_to(ROOT).as_posix()
    if rel.startswith("properties/"): cat="property-composition"; view="angled-front" if "angled_front" in rel else "top-down"
    elif rel.startswith("roofs/"): cat="roof-sprite"; view="top-down/roof-plane"
    elif rel.startswith("objects/"): cat="object-or-structural-module"; view="top-down/source-view"
    elif "/tiles/" in rel: cat="repeatable-surface"; view="tile"
    else: cat="material-sample"; view="sample"
    index.append({"id":f.stem,"path":rel,"category":cat,"view":view,"width":im.width,"height":im.height,"mode":im.mode,"transparent_pixels":transparent,"alpha_fraction":round(transparent/(im.width*im.height),4),"tileable":cat=="repeatable-surface"})
sheet.save(ROOT/"preview/catalogo_assets.jpg",quality=92,optimize=True)

tile_qa={}
for f in sorted((ROOT/"textures"/"tiles").glob("*.png")):
    a=np.asarray(Image.open(f).convert("RGB")).astype(np.int16)
    tile_qa[f.stem]={"size":list(Image.open(f).size),"edge_mean_abs_diff_x":round(float(np.abs(a[:,0]-a[:,-1]).mean()),2),"edge_mean_abs_diff_y":round(float(np.abs(a[0]-a[-1]).mean()),2)}
qa_out={"source_processing":qa,"tile_edge_checks":tile_qa,"known_limits":[
 "The source references mix angled-front and top-down camera views; keep these groups separate.",
 "Object crops marked as structural modules intentionally retain their rectangular construction surface.",
 "The first pass removes connected bright neutral backgrounds and repairs reported guide bands; remaining edge halos must be reviewed visually.",
 "The package is not wired into Phaser yet; lot footprint, draw order, scale and collision integration are still pending."
]}
(ROOT/"reports/qa_v2.json").write_text(json.dumps(qa_out,ensure_ascii=False,indent=2),encoding="utf-8")
(ROOT/"asset-index.json").write_text(json.dumps(index,ensure_ascii=False,indent=2),encoding="utf-8")
(ROOT/"manifest.json").write_text(json.dumps({"name":"Aracatexas Residential Assets v2","version":2,"source_images":list(FILES.values()),"source_originals_modified":False,"tile_base_px":32,"pixels_per_meter":16,"processing":{"grid_band_repair":"linear interpolation across detected guide bands","background_removal":"8-connected flood removal of light neutral background pixels, followed by object silhouette masks","repeatable_textures":"offset seam blending, no mirrored quadrants"},"limitations":qa_out["known_limits"]},ensure_ascii=False,indent=2),encoding="utf-8")
(ROOT/"README.md").write_text("""# Aracatexas — Residential Assets v2

Revisao tecnica do pacote v1, preservado sem alteracoes.

## Categorias
- properties/top_down: composicoes de lotes em vista superior.
- properties/angled_front: composicoes com fachada em angulo.
- roofs/shapes: planos de telhado recortados.
- objects: objetos e modulos estruturais.
- textures/samples: amostras de materiais, sem promessa de repeticao.
- textures/tiles: superficies 128x128 com costura central suavizada por offset, sem quadrantes espelhados.

## Escala de referencia
Tile base do jogo: 32x32 px. Uma textura 128x128 ocupa 4x4 tiles, antes do ajuste visual no Phaser.

## Correcoes em relacao a v1
- A remocao do fundo agora e executada de fato por conectividade, em vez de devolver a imagem opaca.
- As faixas-guia detectadas sao interpoladas por completo.
- Os tiles nao sao mais construidos por espelhamento de quadrantes.
- O indice registra fracao transparente e orientacao.

## Limitacoes
Este pacote ainda exige revisao visual de halos/bordas e teste no mapa. As referencias misturam camera top-down e angulo frontal; os grupos devem permanecer separados. Os modulos estruturais retangulares nao sao sprites flutuantes isolados. Nenhum codigo do jogo foi alterado.
""",encoding="utf-8")
(ROOT/"build_assets_v2.py").write_text(Path(__file__).read_text(encoding="utf-8"),encoding="utf-8")
print("V2_READY",len(files),"pngs")
print("PNG_COUNTS properties",len(list((ROOT/"properties").rglob("*.png"))),"roofs",len(list((ROOT/"roofs").glob("*.png"))),"objects",len(list((ROOT/"objects").glob("*.png"))),"samples",len(list((ROOT/"textures"/"samples").glob("*.png"))),"tiles",len(list((ROOT/"textures"/"tiles").glob("*.png"))))
for key,v in qa.items(): print("BG",key,v["removed_background_pct"],"pct")
