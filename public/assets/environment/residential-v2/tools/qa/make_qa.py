from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
import numpy as np, json, math
base=Path(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets\residencial-v2")
src=Path(r"C:\Users\guilh\Desktop\python\exemplos texturas")
out=base/"preview"
# 3x3 tiled stress test for all repeatable tiles
tiles=sorted((base/"textures"/"tiles").glob("*.png"))
cols=3; cell=220; rows=math.ceil(len(tiles)/cols)
sheet=Image.new("RGB",(cols*cell,rows*(cell+30)),(45,47,50)); d=ImageDraw.Draw(sheet)
for i,p in enumerate(tiles):
    im=Image.open(p).convert("RGB").resize((64,64),Image.Resampling.NEAREST)
    rep=Image.new("RGB",(192,192))
    for y in range(3):
        for x in range(3): rep.paste(im,(x*64,y*64))
    rep=rep.resize((192,192),Image.Resampling.NEAREST)
    x=(i%cols)*cell+14; y=(i//cols)*(cell+30)+8
    sheet.paste(rep,(x,y)); d.text((x,y+195),p.stem,fill=(245,245,245))
sheet.save(out/"tile_repeat_qa.jpg",quality=92)
# Candidate grass regions in reference images, 720-coordinates.
boxes=[(0,150,130,280),(0,280,130,410),(0,410,130,540),(0,540,130,680),(560,150,700,280),(560,280,700,410),(560,410,700,540),(560,540,700,680),(100,300,220,420),(120,420,240,540)]
sheet=Image.new("RGB",(5*170,4*170),(45,47,50)); d=ImageDraw.Draw(sheet)
for r,(key,fn) in enumerate([("light","Gemini_Generated_Image_am03u7am03u7am03.jpg"),("dark","Gemini_Generated_Image_kh6d0okh6d0okh6d.jpg")]):
    im=Image.open(src/fn).convert("RGB")
    k=min(720/im.width,720/im.height)
    for j,b in enumerate(boxes):
        cr=im.crop(tuple(round(v/k) for v in b)); cr.thumbnail((140,130),Image.Resampling.LANCZOS)
        x=(j%5)*170+15; y=(r*2+j//5)*170+8
        sheet.paste(cr,(x,y)); d.text((x,y+132),f"{key}-{j+1} {b}",fill=(245,245,245))
sheet.save(out/"grass_candidates.jpg",quality=92)
print("created",out/"tile_repeat_qa.jpg",out/"grass_candidates.jpg")
