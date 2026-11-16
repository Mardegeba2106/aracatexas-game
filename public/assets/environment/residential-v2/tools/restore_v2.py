from pathlib import Path
p=Path(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets\residencial-v2\build_assets_v2.py")
s=p.read_text(encoding="utf-8")
marker="# Aerial traditional terracotta roof isolated from the top-down reference."
if marker in s:
 start=s.index(marker)
 end=s.index("SPECS=[",start)
 s=s[:start]+s[end:]
p.write_text(s,encoding="utf-8")
rp=Path(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets\residencial-v2\rebuild_v2.py")
s=rp.read_text(encoding="utf-8").replace("5 recortes de planos de telhado, incluindo um telhado tradicional top-down","4 recortes de planos de telhado").replace("51 PNGs de assets","50 PNGs de assets")
rp.write_text(s,encoding="utf-8")
roof=Path(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets\residencial-v2\roofs\shapes\roof_traditional_terracotta_topdown.png")
if roof.exists(): roof.unlink()
for f in ["patch_build_script.py","patch_roof_mask.py"]:
 p=Path(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets\residencial-v2\tools")/f
 if p.exists(): p.unlink()
print("RESTORED_TO_FOUR_CLEAN_ROOF_ASSETS")
