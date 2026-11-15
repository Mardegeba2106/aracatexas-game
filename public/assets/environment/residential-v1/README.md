# Aracatexas — Residential Assets v1

Pacote derivado das dez imagens de referência fornecidas para o projeto.

## Conteúdo
- `properties/top_down/`: composições completas de imóveis em vista superior.
- `properties/angled_front/`: composições de casas tradicionais com fachada/ângulo oblíquo.
- `roofs/shapes/`: recortes de telhados em PNG com transparência.
- `objects/`: carros, árvores, piscina, conjunto de lazer, portões, muro, lixeira, caixa d’água, ar-condicionado e painéis solares.
- `textures/samples/`: recortes de materiais de referência, 128×128.
- `textures/tiles/`: 9 superfícies 128×128 com bordas repetíveis, montadas por espelhamento de amostras 64×64.
- `preview/catalogo_assets.jpg`: catálogo geral.
- `asset-index.json`: dimensões, categorias, orientação e indicação de repetição de cada PNG.
- `manifest.json` e `reports/`: origem e detalhes de processamento.
- `build_assets.py`: script de reconstrução a partir das dez referências originais.

## Escala do jogo
O Araçatexas usa tile base de 32×32 px, equivalente a 2×2 m (16 px/m). As superfícies repetíveis são 128×128 px (4×4 tiles). Os sprites grandes devem ser dimensionados pela medida do lote/edificação, não reduzidos automaticamente para 32×32.

## Processamento
As faixas da grade de composição foram detectadas e corrigidas por interpolação local dos pixels muito escuros/claros. O exterior das composições foi recortado por máscaras poligonais com transparência. As imagens originais foram preservadas.

## Limitações conhecidas
- Os tiles repetíveis usam espelhamento de amostras. As bordas coincidem, mas algumas superfícies podem revelar simetria quando repetidas em áreas grandes.
- `textures/samples/` são amostras de referência, não tiles certificados.
- As casas completas são sprites compostos. Ainda precisam ser alinhadas às footprints/colisões do OSM antes de substituir os polígonos do mapa.
- As perspectivas `top_down` e `angled_front` não devem ser misturadas sem ajuste de câmera.
- Este pacote não altera a lógica de renderização ou colisão do jogo.
