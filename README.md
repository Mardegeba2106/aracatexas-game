# Araçatexas — primeiro protótipo jogável

Protótipo top-down em Phaser 3, JavaScript e Vite. O mapa é preparado a partir dos dados originais do Knoxify e do cache do OpenStreetMap; este projeto não altera a pasta Knoxify.

## Estado da entrega

- Código do jogo, controles, minimapa, sprites e tiles pixel-art estão incluídos.
- O conversor de dados está incluído e lê os arquivos originais descritos abaixo.
- **O `public/data/map.json` não acompanha este ZIP**, pois os arquivos do Dropbox foram inspecionados, mas não foi possível transferir seus binários para o ambiente de empacotamento nesta sessão. Gere o arquivo localmente antes de abrir o mapa no jogo.
- O jogo mostra instruções quando o mapa ainda não foi preparado. Não cria uma malha urbana fictícia como substituto.

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

## 3. Preparar o mapa real

Se o Knoxify estiver no caminho padrão:

```powershell
npm run prepare:map
```

Ou informe a pasta raiz do Knoxify:

```powershell
npm run prepare:map -- --source "C:\Users\guilh\Desktop\python\knoxify-master"
```

Também é possível apontar diretamente para `procedural_city`:

```powershell
npm run prepare:map -- --source "C:\caminho\knoxify-master\output\procedural_city"
```

O conversor procura o cache Overpass na árvore informada. Se os arquivos estiverem em outra unidade, ajuste o caminho.

O resultado é criado em:

`public\data\map.json`

O recorte usa como centro longitude `-50.43568`, latitude `-21.22224` e raio de 650 metros. As coordenadas são transformadas de WGS84 para **EPSG:32722 (UTM 22S)**. Quadras, lotes, edifícios e ruas são preservados como geometrias; as vias são lidas diretamente de `elements[].geometry` nos elementos `way` do cache.

## 4. Executar o jogo

Depois de preparar o mapa:

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
