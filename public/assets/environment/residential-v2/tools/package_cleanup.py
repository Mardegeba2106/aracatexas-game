from pathlib import Path
import shutil
root=Path(r"C:\Users\guilh\Dropbox\ARAÇATEXAS ARQUIVOS\Assets\residencial-v2")
qa=root/"tools"/"qa"; qa.mkdir(parents=True,exist_ok=True)
for rel in ["make_qa.py","preview/make_material_review.py","preview/grass_crop_candidates_v2.py","preview/palm_mask_test.py"]:
    p=root/rel
    if p.exists(): shutil.move(str(p),str(qa/p.name))
for rel in ["preview/grass_candidates.jpg","preview/material_crop_review.jpg","preview/grass_crop_candidates_v2.jpg","preview/palm_color_mask_test.jpg","preview/tile_repeat_qa.jpg"]:
    p=root/rel
    if p.exists(): p.unlink()
readme="""# Aracatexas — Residential Assets v2

Pacote revisado com base nas dez imagens originais. A v1 permanece preservada.

## Conteudo e contagem
- 10 composicoes de imoveis: 7 top-down e 3 angled-front
- 4 recortes de planos de telhado
- 15 objetos/modulos de ambiente
- 12 amostras de materiais
- 9 texturas repetiveis 128x128
- 50 PNGs de assets no total (arquivos de teste em preview nao entram na contagem)

## Escala
O jogo usa tile base de 32x32 px, com referencia de 16 px por metro. Os tiles 128x128 ocupam 4x4 tiles do jogo antes do ajuste final no Phaser.

## Reconstrucao
Na pasta, execute python rebuild_v2.py. O orquestrador executa build_assets_v2.py e depois refine_assets_v2.py. As imagens originais em Desktop/python/exemplos texturas nao sao alteradas.

## O que foi corrigido em relacao a v1
- Remocao real do fundo claro conectado ao exterior, em vez de manter alpha totalmente opaco.
- Reparacao das faixas-guia detectadas.
- Tiles construidos por offset e mistura das costuras, sem espelhamento em quatro quadrantes.
- Recorte mais limpo de grama, agua e palmeira.
- Indice com dimensoes, orientacao e fracao transparente.

## Como interpretar os assets
- properties/top_down: composicoes de lote vistas de cima.
- properties/angled_front: composicoes com perspectiva frontal/obliqua. Nao misturar com top-down na mesma camada de camera.
- roofs/shapes: planos de telhado recortados.
- objects: inclui sprites com transparencia e modulos estruturais que preservam parte da superficie original (por exemplo, segmentos de portao/muro e equipamentos sobre telhado). Os modulos opacos precisam ser posicionados como pecas de ambiente, nao como sprites flutuantes isolados.
- textures/samples: amostras de referencia; nao assumir que todas repetem perfeitamente.
- textures/tiles: materiais repetiveis para pisos, grama, agua e telhados.

## Limites conhecidos
Este pacote ainda nao foi integrado ao Phaser. As casas precisam ser ajustadas as footprints, escala e colisao dos lotes OSM; ordem de desenho, ancoragem e sobreposicao ainda precisam de teste no mapa. Os nove tiles foram testados em repeticao 3x3, mas a repeticao visual de uma amostra pequena ainda pode aparecer em areas grandes. A v2 e uma base tecnica revisada, nao uma integracao final do jogo.
"""
(root/"README.md").write_text(readme,encoding="utf-8")
rebuild='''from pathlib import Path
import runpy
ROOT = Path(__file__).resolve().parent
runpy.run_path(str(ROOT / "build_assets_v2.py"), run_name="__main__")
runpy.run_path(str(ROOT / "refine_assets_v2.py"), run_name="__main__")
'''
(root/"rebuild_v2.py").write_text(rebuild,encoding="utf-8")
groups={
 "properties":list((root/"properties").rglob("*.png")),
 "roofs":list((root/"roofs").rglob("*.png")),
 "objects":list((root/"objects").glob("*.png")),
 "samples":list((root/"textures"/"samples").glob("*.png")),
 "tiles":list((root/"textures"/"tiles").glob("*.png"))
}
print("ASSET_COUNTS",{k:len(v) for k,v in groups.items()},"TOTAL",sum(map(len,groups.values())))
