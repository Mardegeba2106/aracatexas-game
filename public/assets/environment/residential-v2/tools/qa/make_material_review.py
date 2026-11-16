from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
import math
src=Path(r"C:\Users\guilh\Desktop\python\exemplos texturas")
out=Path(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets\residencial-v2\preview")
specs=[
("grass-light-a","Gemini_Generated_Image_am03u7am03u7am03.jpg",(140,420,205,485)),
("grass-light-b","Gemini_Generated_Image_am03u7am03u7am03.jpg",(150,440,220,510)),
("grass-dark-a","Gemini_Generated_Image_kh6d0okh6d0okh6d.jpg",(145,430,210,495)),
("grass-dark-b","Gemini_Generated_Image_kh6d0okh6d0okh6d.jpg",(145,350,210,420)),
("water-a","Gemini_Generated_Image_am03u7am03u7am03.jpg",(135,215,210,280)),
("water-b","Gemini_Generated_Image_am03u7am03u7am03.jpg",(140,225,205,275)),
("water-c","Gemini_Generated_Image_kh6d0okh6d0okh6d.jpg",(135,215,210,280)),
("water-d","Gemini_Generated_Image_kh6d0okh6d0okh6d.jpg",(140,225,205,275))]
sheet=Image.new("RGB",(4*230,2*230),(45,47,50)); d=ImageDraw.Draw(sheet)
for i,(name,fn,b) in enumerate(specs):
 im=Image.open(src/fn).convert("RGB"); k=min(720/im.width,720/im.height); crop=im.crop(tuple(round(v/k) for v in b))
 crop=crop.resize((190,190),Image.Resampling.NEAREST)
 x=(i%4)*230+20; y=(i//4)*230+8
 sheet.paste(crop,(x,y)); d.text((x,y+195),name+" "+str(b),fill=(245,245,245))
sheet.save(out/"material_crop_review.jpg",quality=92)
