# Araçatexas — pacote residencial v2

Pacote produzido a partir das dez referências originais. A versão 1 foi preservada; esta é uma revisão técnica separada.

## Conteúdo
- 10 composições residenciais: 7 top-down e 3 com fachada em ângulo
- 4 recortes de planos de telhado
- 15 objetos e módulos de ambiente
- 12 amostras de materiais
- 9 texturas repetíveis de 128×128 px
- 50 PNGs de assets

## Organização
- properties/top_down/: composições vistas de cima, para referência e futuros prefabs
- properties/angled_front/: composições com perspectiva frontal/oblíqua; não misturar com a câmera top-down
- roofs/shapes/: recortes de telhados
- objects/: objetos e módulos; alguns preservam partes de muros, portões ou equipamentos e não são sprites flutuantes isolados
- textures/samples/: amostras de materiais
- textures/tiles/: 9 superfícies repetíveis para grama, água, telhas, telhado metálico, pavers e piso

## Escala do jogo
A referência do projeto é tile base de 32×32 px, com 16 px por metro. Um tile de textura 128×128 equivale a 4×4 tiles de jogo antes de ajustar a escala visual.

## Integração Phaser já testada localmente
O projeto local passou a carregar grass_tileable.png como chão de fundo. Nos edifícios com footprint compatível, o renderizador usa:
- telhas cerâmicas laranja/sombreadas em casas
- telha metálica cinza/vermelha em estabelecimentos comerciais
- pavers cinza em alguns apartamentos

As superfícies são aplicadas como TileSprite, recortadas por uma máscara geométrica construída a partir do polígono real da edificação. O ângulo acompanha a aresta mais longa. Isso evita que a imagem escape do footprint ou seja esticada sobre formatos incompatíveis. A cor chapada dos lotes foi reduzida para deixar o gramado aparecer.

Filtro atual de elegibilidade: 55–650 m², lado menor mínimo de 7 m, lado maior máximo de 60 m e proporção máxima de 2,5. Edifícios fora desses limites mantêm o render procedural atual.

Estado do código: integração compilada e visualmente testada no projeto local. As alterações de WorldScene.js e WorldChunkManager.js continuam locais e sem commit; não foram empurradas para o GitHub porque o branch de trabalho já continha alterações anteriores do projeto. A branch de assets no GitHub contém o pacote visual, não uma integração de código mesclada na main.

## Reconstrução
No PC com Python e Pillow instalados, execute python rebuild_v2.py. O script usa as dez imagens de Desktop/python/exemplos texturas e não altera os arquivos originais.

## Limites conhecidos
A remoção automática de fundo foi feita por conectividade e máscara, mas objetos complexos ainda podem precisar de retoque manual de borda. Os recortes de fachada em ângulo são uma família separada. As composições residenciais completas e a maior parte dos objetos ainda não foram distribuídos automaticamente no mapa; a integração atual aplica materiais de telhado e gramado, com fallback procedural para os demais casos. Os tiles passaram por teste de repetição 3×3, mas amostras pequenas podem revelar padrões repetidos em áreas grandes.
