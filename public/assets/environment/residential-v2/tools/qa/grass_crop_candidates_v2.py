from pathlib import Path
from PIL import Image, ImageDraw
src=Path(r"C:\Users\guilh\Desktop\python\exemplos texturas"); out=Path(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets\residencial-v2\preview")
boxes=[(150,440,190,490),(135,450,180,495),(140,460,190,510),(160,440,205,480),(140,430,190,480),(125,430,175,480)]
im=Image.open(src/"Gemini_Generated_Image_am03u7am03u7am03.jpg").convert("RGB"); k=min(720/im.width,720/im.height)
sheet=Image.new("RGB",(3*210,2*210),(45,47,50)); d=ImageDraw.Draw(sheet)
for i,b in enumerate(boxes):
 cr=im.crop(tuple(round(v/k) for v in b)).resize((180,180),Image.Resampling.NEAREST)
 x=(i%3)*210+15; y=(i//3)*210+8; sheet.paste(cr,(x,y)); d.text((x,y+184),str(b),fill=(245,245,245))
sheet.save(out/"grass_crop_candidates_v2.jpg",quality=93)
