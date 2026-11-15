from pathlib import Path
from PIL import Image, ImageDraw, ImageOps, ImageChops
import numpy as np, json, math
ROOT=Path(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets\residencial-v1")
SRC=Path(r"C:\Users\guilh\Dropbox")
for d in ["properties/top_down","properties/angled_front","roofs/shapes","textures/samples","objects","preview","tools","reports"]: (ROOT/d).mkdir(parents=True,exist_ok=True)
FILES={"traditional_pink":"Gemini_Generated_Image_397pfo397pfo397p.jpg","traditional_yellow":"Gemini_Generated_Image_4gs3u44gs3u44gs3.jpg","modern_pool_light":"Gemini_Generated_Image_am03u7am03u7am03.jpg","modern_compact":"Gemini_Generated_Image_cmea5icmea5icmea.jpg","traditional_teal":"Gemini_Generated_Image_dwtzxzdwtzxzdwtz.jpg","modern_pool_dark":"Gemini_Generated_Image_kh6d0okh6d0okh6d.jpg","modern_narrow_flat":"Gemini_Generated_Image_md8es9md8es9md8e.jpg","modern_long_pool":"Gemini_Generated_Image_qu0dviqu0dviqu0d.jpg","traditional_red_roof":"Gemini_Generated_Image_u7qjq2u7qjq2u7qj.jpg","modern_gray":"Gemini_Generated_Image_z9u8ljz9u8ljz9u8.jpg"}
FRONT={"traditional_pink","traditional_yellow","traditional_teal"}; imgs={}; report={}
def runs(m):
 ids=np.flatnonzero(m); out=[]
 if not len(ids): return out
 a=b=int(ids[0])
 for v in map(int,ids[1:]):
  if v==b+1: b=v
  else:
   if b-a+1>=2: out.append((a,b))
   a=b=v
 if b-a+1>=2: out.append((a,b))
 return out
def repair(a,bands,axis):
 h,w=a.shape[:2]
 for s,e in bands:
  limit=h if axis==0 else w
  if s<10 or e>=limit-10: continue
  radius=8
  if axis==0:
   lo=np.median(a[s-radius:s-2].astype(float),axis=0); hi=np.median(a[e+2:e+radius].astype(float),axis=0); den=e-s+2
   for y in range(s,e+1):
    t=(y-s+1)/den; fill=np.clip(lo*(1-t)+hi*t,0,255).astype("uint8")
    pix=a[y].astype(float); gray=pix.mean(1); sat=pix.max(1)-pix.min(1)
    ink=((gray<28)&(sat<22))|((gray>248)&(sat<10)); a[y,ink]=fill[ink]
  else:
   lo=np.median(a[:,s-radius:s-2].astype(float),axis=1); hi=np.median(a[:,e+2:e+radius].astype(float),axis=1); den=e-s+2
   for x in range(s,e+1):
    t=(x-s+1)/den; fill=np.clip(lo*(1-t)+hi*t,0,255).astype("uint8")
    pix=a[:,x].astype(float); gray=pix.mean(1); sat=pix.max(1)-pix.min(1)
    ink=((gray<28)&(sat<22))|((gray>248)&(sat<10)); a[ink,x]=fill[ink]
 return a
def clean_grid(im):
 a=np.asarray(im.convert("RGB")).copy(); g=a.mean(2); s=a.max(2)-a.min(2)
 dark=(g<35)&(s<25); light=(g>248)&(s<12)
 hr=[(max(0,r[0]-2),min(a.shape[0]-1,r[1]+2)) for r in runs(dark.mean(1)>.92)+runs(light.mean(1)>.92) if 2<=r[1]-r[0]+1<=12]
 vc=[(max(0,r[0]-2),min(a.shape[1]-1,r[1]+2)) for r in runs(dark.mean(0)>.92)+runs(light.mean(0)>.92) if 2<=r[1]-r[0]+1<=12]
 a=repair(a,hr,0); a=repair(a,vc,1)
 return Image.fromarray(a),hr,vc
def flood(c):
 h,w=c.shape; seen=np.zeros((h,w),bool); st=[]
 for x in range(w):
  if c[0,x]: st.append((0,x))
  if c[-1,x]: st.append((h-1,x))
 for y in range(1,h-1):
  if c[y,0]: st.append((y,0))
  if c[y,-1]: st.append((y,w-1))
 while st:
  y,x=st.pop()
  if x<0 or x>=w or y<0 or y>=h or seen[y,x] or not c[y,x]: continue
  l=x; r=x
  while l>0 and c[y,l-1] and not seen[y,l-1]: l-=1
  while r<w-1 and c[y,r+1] and not seen[y,r+1]: r+=1
  seen[y,l:r+1]=1
  for ny in (y-1,y+1):
   if 0<=ny<h:
    q=c[ny,l:r+1]&(~seen[ny,l:r+1]); ix=np.flatnonzero(q)
    if len(ix):
     starts=[int(ix[0])]
     for k in range(1,len(ix)):
      if ix[k]>ix[k-1]+1: starts.append(int(ix[k]))
     st.extend((ny,l+z) for z in starts)
 return seen
def remove_bg(im,hr,vc):
 # Preserve full source; the composition mask controls the exterior cut.
 a=np.asarray(im.convert("RGB")).copy()
 rgba=np.dstack([a,np.full(a.shape[:2],255,dtype=np.uint8)])
 return Image.fromarray(rgba),0
def trim(im,pad=3):
 a=np.asarray(im.getchannel("A")); y,x=np.where(a>8)
 if len(x): return im.crop((max(0,x.min()-pad),max(0,y.min()-pad),min(im.width,x.max()+1+pad),min(im.height,y.max()+1+pad)))
 return im
def scaled(im,path,limit=768):
 im=trim(im)
 if max(im.size)>limit:
  k=limit/max(im.size); im=im.resize((round(im.width*k),round(im.height*k)),Image.Resampling.LANCZOS)
 im.save(path,optimize=True)
def sc(im): return min(720/im.width,720/im.height)
def box(im,b):
 k=sc(im); return im.crop(tuple(round(v/k) for v in b))
def poly(im,pts,path,limit=600):
 k=sc(im); m=Image.new("L",im.size,0); ImageDraw.Draw(m).polygon([(round(x/k),round(y/k)) for x,y in pts],fill=255)
 o=im.copy(); o.putalpha(ImageChops.multiply(o.getchannel("A"),m)); scaled(o,path,limit)
def sample(name,key,b):
 p=ImageOps.fit(box(imgs[key],b).convert("RGB"),(128,128),method=Image.Resampling.LANCZOS)
 p.save(ROOT/"textures"/"samples"/(name+".png"),optimize=True)
PROPERTY_POLYS={
 "traditional_pink":[(52,128),(126,128),(165,105),(347,66),(505,103),(670,128),(670,678),(52,678)],
 "traditional_yellow":[(52,128),(126,128),(165,105),(347,66),(505,103),(670,128),(670,678),(52,678)],
 "traditional_teal":[(52,128),(126,128),(165,105),(347,66),(505,103),(670,128),(670,678),(52,678)],
 "modern_pool_light":[(12,38),(708,38),(716,708),(10,708)],
 "modern_pool_dark":[(12,38),(708,38),(716,708),(10,708)],
 "modern_compact":[(80,78),(640,78),(640,485),(640,565),(720,565),(720,720),(0,720),(0,565),(80,565),(80,485)],
 "modern_narrow_flat":[(176,70),(544,70),(544,636),(176,636)],
 "modern_long_pool":[(127,0),(439,0),(438,705),(108,705)],
 "traditional_red_roof":[(28,12),(505,12),(505,680),(28,680)],
 "modern_gray":[(78,56),(642,56),(680,600),(720,720),(0,720),(0,600),(78,600)]
}
for key,fn in FILES.items():
 raw=Image.open(SRC/fn).convert("RGB"); fixed,hr,vc=clean_grid(raw); rgba,bg=remove_bg(fixed,hr,vc); imgs[key]=rgba
 report[key]={"source":fn,"source_size":list(raw.size),"grid_rows":hr,"grid_columns":vc,"transparent_pixels":bg}
 sub="angled_front" if key in FRONT else "top_down"
 target=ROOT/"properties"/sub/(key+".png")
 poly(rgba,PROPERTY_POLYS[key],target,768)
 report[key]["transparent_pixels_after_mask"]=int((np.asarray(Image.open(target).getchannel("A"))==0).sum())
# Roof silhouettes
poly(imgs["modern_pool_light"],[(270,115),(540,115),(545,289),(468,359),(389,359),(389,300),(270,300)],ROOT/"roofs/shapes/roof_hipped_light_ceramic.png")
poly(imgs["modern_pool_dark"],[(270,115),(540,115),(545,289),(468,359),(389,359),(389,300),(270,300)],ROOT/"roofs/shapes/roof_hipped_brown_ceramic.png")
poly(imgs["traditional_pink"],[(165,105),(350,66),(503,105),(500,423),(350,448),(164,423)],ROOT/"roofs/shapes/roof_gable_terracotta_red.png")
poly(imgs["modern_narrow_flat"],[(181,74),(417,74),(417,350),(181,350)],ROOT/"roofs/shapes/roof_flat_concrete_solar.png")
# Surface swatches. They are samples, not falsely labelled as seamless.
for spec in [("roof_terracotta_orange","traditional_pink",(260,130,345,220)),("roof_terracotta_shadow","traditional_pink",(375,130,465,220)),("roof_ceramic_light","modern_pool_light",(295,145,460,265)),("roof_ceramic_brown","modern_pool_dark",(295,145,460,265)),("concrete_roof","modern_compact",(190,35,410,115)),("roof_corrugated_gray","traditional_pink",(520,250,660,315)),("roof_corrugated_red","traditional_pink",(520,325,660,415)),("sidewalk_pavers","modern_pool_light",(205,645,445,705)),("grass","modern_pool_dark",(180,400,200,445)),("pool_water","modern_pool_light",(130,205,218,287)),("terracotta_patio","traditional_pink",(235,525,480,567)),("dark_pavers","modern_pool_dark",(205,645,445,705))]: sample(*spec)
# Repeating Phaser-friendly surface tiles. Each 64px source patch is mirrored on both axes
# so opposing edges match; this is a deliberate reflected tile, not a claim that the source
# material itself was seamless.
tile_names=["roof_terracotta_orange","roof_terracotta_shadow","roof_corrugated_gray","roof_corrugated_red","sidewalk_pavers","grass","pool_water","terracotta_patio","dark_pavers"]
tile_dir=ROOT/"textures"/"tiles"; tile_dir.mkdir(parents=True,exist_ok=True)
for name in tile_names:
 src=Image.open(ROOT/"textures"/"samples"/(name+".png")).convert("RGB").resize((64,64),Image.Resampling.LANCZOS)
 tile=Image.new("RGB",(128,128))
 tile.paste(src,(0,0)); tile.paste(ImageOps.mirror(src),(64,0))
 tile.paste(ImageOps.flip(src),(0,64)); tile.paste(ImageOps.flip(ImageOps.mirror(src)),(64,64))
 tile.save(tile_dir/(name+"_tileable.png"),optimize=True)
# Independent props
poly(imgs["modern_pool_light"],[(80,544),(110,535),(165,544),(192,566),(199,618),(188,675),(98,682),(80,648)],ROOT/"objects/tree_with_planter.png",512)
poly(imgs["modern_pool_light"],[(13,36),(77,37),(91,103),(89,188),(17,189),(8,131)],ROOT/"objects/palm_pair_garden_cluster.png",512)
poly(imgs["modern_pool_light"],[(120,190),(225,190),(230,298),(117,298)],ROOT/"objects/pool_with_deck_and_umbrella.png",512)
poly(imgs["modern_pool_dark"],[(46,145),(125,140),(145,180),(142,250),(110,264),(55,238)],ROOT/"objects/poolside_lounge_set.png",384)
poly(imgs["modern_narrow_flat"],[(185,75),(285,75),(292,146),(185,146)],ROOT/"objects/solar_panels_cluster.png",384)
poly(imgs["modern_pool_light"],[(247,452),(311,452),(319,541),(248,543)],ROOT/"objects/car_light_topdown.png",384)
poly(imgs["modern_pool_dark"],[(247,452),(311,452),(319,541),(248,543)],ROOT/"objects/car_red_topdown.png",384)
poly(imgs["modern_pool_light"],[(306,452),(380,452),(385,543),(307,543)],ROOT/"objects/car_silver_topdown.png",384)
poly(imgs["modern_pool_light"],[(15,390),(222,390),(235,540),(18,540)],ROOT/"objects/shrub_flowerbed_cluster.png",512)
for name,key,b,lim in [
 ("air_conditioning_units_rooftop_cluster","modern_pool_light",(475,52,582,112),384),
 ("water_tank_rooftop","modern_pool_light",(260,48,337,110),320),
 ("double_garage_gate_light","modern_pool_light",(241,561,397,621),512),
 ("pedestrian_gate_light","modern_pool_light",(455,560,518,624),384),
 ("front_wall_left_segment","modern_pool_light",(18,562,82,630),256)]:
 o=box(imgs[key],b); scaled(o,ROOT/"objects"/(name+".png"),lim)
poly(imgs["modern_pool_light"],[(547,619),(572,619),(575,665),(546,665)],ROOT/"objects/street_bin.png",256)
# Catalog visual
files=sorted((ROOT/"properties").rglob("*.png"))+sorted((ROOT/"roofs").rglob("*.png"))+sorted((ROOT/"objects").glob("*.png"))+sorted((ROOT/"textures"/"samples").glob("*.png"))+sorted((ROOT/"textures"/"tiles").glob("*.png"))
cols=4; cw=260; ch=245; sheet=Image.new("RGB",(cols*cw,math.ceil(len(files)/cols)*ch),(42,44,47)); d=ImageDraw.Draw(sheet)
for i,f in enumerate(files):
 im=Image.open(f).convert("RGBA"); im.thumbnail((240,210),Image.Resampling.LANCZOS)
 x=(i%cols)*cw+10; y=(i//cols)*ch+8
 bg=Image.new("RGBA",im.size,(75,78,82,255)); bg.alpha_composite(im); sheet.paste(bg.convert("RGB"),(x,y)); d.text((x,y+214),f.stem[:38],fill=(245,245,240))
sheet.save(ROOT/"preview/catalogo_assets.jpg",quality=92,optimize=True)
manifest={"name":"Aracatexas Residential Assets v1","game_reference":{"tile_px":32,"pixels_per_meter":16,"tile_meters":2},"sources":list(FILES.values()),"processing":{"grid_repaired":"guide-grid bands detected; near-black/near-white overlay pixels were inpainted from local median samples","background_cutout":"outer composition silhouettes clipped with explicit polygon masks; internal neutral surfaces were preserved","originals_modified":False,"per_source":report},"tileable_textures":{"method":"64x64 material samples mirrored into 128x128 repeatable tiles so opposite edges match","caveat":"mirroring is a practical seamless tiling treatment; it can create visible symmetry in some materials"},"limitations":["textures/samples are reference crops and are not individually certified seamless.","Whole-property sprites are composed reference sprites, not automatically aligned to OSM collision footprints.","Angled-front and top-down viewpoints are separated; do not mix their camera treatments.","No game rendering or collision code has been changed."]}
(ROOT/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
(ROOT/"README.md").write_text("""# Aracatexas — Residential Assets v1

Pacote derivado das dez imagens de referência fornecidas para o projeto.

## Conteúdo
- `properties/top_down/`: composições completas de imóveis em vista superior.
- `properties/angled_front/`: composições de casas tradicionais com fachada/ângulo oblíquo.
- `roofs/shapes/`: recortes de telhados em PNG com transparência.
- `objects/`: carros, árvores, piscina, conjunto de lazer, portões, muro, lixeira, caixa d\u2019água, ar-condicionado e painéis solares.
- `textures/samples/`: recortes de materiais de referência, 128×128.
- `textures/tiles/`: 9 superfícies 128×128 com bordas repetíveis, montadas por espelhamento de amostras 64×64.
- `preview/catalogo_assets.jpg`: catálogo geral.
- `asset-index.json`: dimensões, categorias, orientação e indicação de repetição de cada PNG.
- `manifest.json` e `reports/`: origem e detalhes de processamento.
- `build_assets.py`: script de reconstrução a partir das dez referências originais.

## Escala do jogo
O Araçatexas usa tile base de 32×32 px, equivalente a 2×2 m (16 px/m). As superfícies repetíveis são 128×128 px (4×4 tiles). Os sprites grandes devem ser dimensionados pela medida do lote/edificação, não reduzidos automaticamente para 32×32.

## Processamento
As faixas da grade de composição foram detectadas e corrigidas por interpolação local dos pixels muito escuros/claros. O exterior das composições foi recortado por máscaras poligonais com transparência. As imagens originais foram preservadas.

## Limitações conhecidas
- Os tiles repetíveis usam espelhamento de amostras. As bordas coincidem, mas algumas superfícies podem revelar simetria quando repetidas em áreas grandes.
- `textures/samples/` são amostras de referência, não tiles certificados.
- As casas completas são sprites compostos. Ainda precisam ser alinhadas às footprints/colisões do OSM antes de substituir os polígonos do mapa.
- As perspectivas `top_down` e `angled_front` não devem ser misturadas sem ajuste de câmera.
- Este pacote não altera a lógica de renderização ou colisão do jogo.
""",encoding="utf-8")
(ROOT/"reports/grid_cleanup_report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
# Machine-readable dimensions and import hints for every delivered PNG.
asset_index=[]
for f in files:
 im=Image.open(f)
 rel=f.relative_to(ROOT).as_posix()
 if rel.startswith("properties/"): category="property-composition"; view="angled-front" if "angled_front" in rel else "top-down"
 elif rel.startswith("roofs/"): category="roof-sprite"; view="top-down/roof-plane"
 elif rel.startswith("objects/"): category="object-sprite"; view="source-view"
 elif "/tiles/" in rel: category="repeatable-surface"; view="tile"
 else: category="material-sample"; view="sample"
 asset_index.append({"id":f.stem,"path":rel,"category":category,"view":view,"width":im.width,"height":im.height,"mode":im.mode,"has_alpha":"A" in im.getbands(),"tileable":category=="repeatable-surface"})
(ROOT/"asset-index.json").write_text(json.dumps(asset_index,ensure_ascii=False,indent=2),encoding="utf-8")
print("ASSETS_READY; properties",len(list((ROOT/"properties").rglob("*.png"))),"roofs",len(list((ROOT/"roofs").rglob("*.png"))),"objects",len(list((ROOT/"objects").glob("*.png"))),"samples",len(list((ROOT/"textures/samples").glob("*.png"))),"total",len(files))
