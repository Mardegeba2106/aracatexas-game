# Araçatexas — primeiro protótipo jogável

Protótipo top-down em Phaser 3, JavaScript e Vite. O mapa é preparado a partir dos dados originais do Knoxify e do cache do OpenStreetMap; este projeto não altera a pasta Knoxify.

## Estado da entrega

- O jogo carrega primeiro `public/data/aracatexas_map.json`; `public/data/map.json` é mantido como fallback.
- O mapa visual contém quadras, lotes, 1.023 footprints de construções, 210 vias e 94 árvores procedurais.
- Os atlas originais estão incluídos: terreno com grade de 8 × 4 tiles de 32 px e construções com grade de 4 × 2 prefabs de 64 px.
- A primeira camada visual já desenha lotes, vias, calçadas, telhados estilizados, árvores e prefabs. O Araçatuba Shopping recebe um tratamento de landmark com letreiro.
- Os arquivos de referência do export (manifest, índice de chunks e mapas de controle) ficam em `public/data/visual_world_source/`.
- Esta é uma primeira versão visual jogável, ainda não o acabamento definitivo da cidade. Autotiling completo, fachadas individualizadas, mobiliário urbano e landmarks feitos à mão continuam no roteiro.

## 1. Pré-requisitos no Windows

1. Instale Node.js 22.12 ou superior.
2. Instale Python 3.10 ou superior.
3. Tenha os arquivos Knoxify originais no computador, sem movê-los ou modificá-los.

O caminho usado como padrão pelo conversor é:

`C:\Users\guilh\Desktop\python\knoxify-master`

A estrutura esperada é:

```text
knoxify-master/
  output/
    procedural_city/
      blocks.geojson
      lots.geojson
      buildings.geojson
      summary.json
      preview.svg
    _cache/
      overpass/
        1d7eb5974fa95dec318ef69f8bbf92fed48f7663.json
```

O `preview.svg` é apenas uma prévia e não é usado como arte do jogo.

## 2. Instalação

Abra o PowerShell dentro da pasta `aracatexas-game` e execute:

```powershell
npm install
```

O conversor usa apenas a biblioteca padrão do Python; não é necessário instalar dependências Python extras. Ele usa `pyproj` quando está instalado e contém um cálculo UTM 22S alternativo quando não está.

## 3. Dados geográficos e recursos visuais

O mapa principal já preparado está em:

`public\data\aracatexas_map.json`

O jogo tenta carregar esse arquivo primeiro e usa `public\data\map.json` apenas como fallback. Não execute o conversor sobre o mapa principal durante o desenvolvimento: o script `prepare:map` gera o arquivo de fallback `map.json`, não o export visual do Dropbox.

A fonte visual original está organizada em:

```text
public/
  assets/
    aracatexas_tileset.png       # 8 × 4 tiles, 32 px
    aracatexas_buildings.png     # 4 × 2 prefabs, 64 px
  data/
    aracatexas_map.json          # mapa principal
    map.json                     # fallback
    map_backup.json              # cópia preservada
    visual_world_source/
      manifest.json
      chunk_index.json
      README.txt
      control_ground.png
      control_roads.png
      control_buildings.png
      control_zones.png
```

Os arquivos dentro de `visual_world_source` são referências para as próximas etapas do renderizador. Os mapas de controle ainda não são usados como camadas em tempo real pelo jogo.

O recorte geográfico usa longitude `-50.43568`, latitude `-21.22224`, raio de 650 metros e **EPSG:32722 (UTM 22S)**. As geometrias de quadras, lotes, construções e ruas preservam a referência espacial original.

## 4. Executar o jogo

Com os arquivos do mapa já presentes no repositório:

```powershell
npm run dev
```

Abra no navegador o endereço indicado pelo Vite, normalmente:

`http://localhost:5173`

Para gerar uma versão de produção:

```powershell
npm run build
npm run preview
```

## 5. Controles

- **WASD** ou **setas**: movimentar.
- **E**: interagir com a construção ou via próxima.
- Em telas touch, use o direcional virtual e o botão **INTERAGIR**.
- A câmera acompanha o personagem; o minimapa fica no canto superior direito.

## 6. Testes locais

Execute:

```powershell
npm run test:data
```

O teste verifica a origem UTM, a conversão para metros, o recorte de linhas pelo raio e a leitura de geometrias diretamente nos elementos `way`.

## 7. Estrutura

```text
aracatexas-game/
  public/
    assets/          # sprites e tiles PNG
    data/            # map.json gerado localmente
  scripts/
    prepare_map.py   # Knoxify + OSM -> dados do jogo
    generate_assets.py
  src/
    data/
    scenes/
    utils/
    main.js
    style.css
  tests/
```

## 8. Observações técnicas e limitações do primeiro corte

- O recorte inclui feições que intersectam o círculo de 650 m; geometrias de lotes/edifícios que cruzam a borda permanecem inteiras para evitar cortar telhados e limites de lote.
- As larguras das ruas são aproximações visuais por classe OSM, a menos que a tag `width` esteja disponível.
- A colisão do protótipo usa os footprints dos edifícios; muros, cercas, mobiliário urbano e obstáculos não mapeados ainda não têm colisão.
- O cache fornecido tem geometrias nas próprias `ways`; o conversor não depende de reconstruir todas as linhas por meio de IDs de nodes.
- A primeira camada visual usa textura de terreno, limites reais de lotes, traçados OSM e footprints reais de edifícios. Telhados e fachadas são estilizações procedurais sobre os polígonos, não modelos individuais desenhados à mão.
- O protótipo é single-player. Multiplayer, NPCs, missões e sistema de estabelecimentos interativos completos ficam para etapas posteriores.
- O cache OSM é atribuído a © OpenStreetMap contributors e está sujeito à ODbL. Consulte https://www.openstreetmap.org/copyright.

## 9. Fonte dos dados

Os arquivos foram localizados no Dropbox em:

`/ARAÇATEXAS ARQUIVOS/Knoxify/knoxify-master/procedural_city/`

e o cache em:

`/ARAÇATEXAS ARQUIVOS/Knoxify/knoxify-master/output/_cache/overpass/`

Nenhum arquivo original do Knoxify é sobrescrito pelo conversor.
