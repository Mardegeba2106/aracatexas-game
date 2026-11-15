from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import numpy as np
src=Path(r"C:\Users\guilh\Desktop\python\exemplos texturas\Gemini_Generated_Image_am03u7am03u7am03.jpg")
im=Image.open(src).convert("RGB")
k=min(720/im.width,720/im.height)
b=(8,25,92,190); crop=im.crop(tuple(round(v/k) for v in b))
a=np.asarray(crop).astype(np.int16); sat=a.max(2)-a.min(2); mx=a.max(2)
mask=((sat>28)&(mx>55)).astype(np.uint8)*255
m=Image.fromarray(mask).filter(ImageFilter.MaxFilter(9))
out=crop.convert("RGBA"); out.putalpha(m)
canvas=Image.new("RGBA",out.size,(48,48,52,255)); canvas.alpha_composite(out); canvas.thumbnail((480,480),Image.Resampling.NEAREST); canvas.convert("RGB").save(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets\residencial-v2\preview\palm_color_mask_test.jpg",quality=92)
print("crop",crop.size,"kept_pct",round((np.asarray(m)>0).mean()*100,2))
