ARAÇATEXAS WORLD BUILDER — VISUAL WORLD EXPORT

Formato: aracatexas-world-v1
Projeção: EPSG:32722
Tiles: 32x32 px = 2.0 m
Chunk: 64 tiles
Seed: 20261108

Conteúdo:
- aracatexas_preview.png: prévia renderizada em pixel art.
- aracatexas_map.json: mapa compatível com o schema do Araçatexas Game, com metadados visuais e vegetação procedural em lotes vazios.
- aracatexas_tileset.png: atlas de chão, asfalto, calçadas e sinalização.
- aracatexas_buildings.png: atlas inicial de fachadas/volumes modulares.
- control_*.png: imagens de controle em grade de 2 m por pixel.
- chunk_index.json: índice espacial para carregamento regional futuro.
- manifest.json: metadados e catálogo de recursos.

Feições preservadas: 150 quadras, 1341 lotes, 1023 construções e 210 vias.
Árvores OSM: 0; árvores adicionadas em lotes vazios: 94.

INTEGRAÇÃO COM O JOGO
1. Faça uma cópia de segurança do arquivo public/data/map.json do jogo.
2. Substitua esse arquivo por aracatexas_map.json.
3. Copie os PNGs de atlas para public/assets/.
4. O mapa base mantém o formato de coordenadas local em metros (EPSG:32722).
5. Consulte visual.* dentro do JSON para os caminhos de atlas, escala e estilos.

A prévia é um raster de inspeção. O jogo deve continuar desenhando as geometrias do JSON em Phaser para preservar colisões e zoom; os atlas são a biblioteca-base para o próximo passo de autotiling/renderização por tiles.

Dados geográficos: © OpenStreetMap contributors · ODbL.
