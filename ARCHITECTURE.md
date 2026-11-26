# Araçatexas — arquitetura técnica

> Este documento descreve o código observado na worktree `C:\Users\guilh\Desktop\python\aracatexas-game`, em 20/11/2026. Confirme o código atual antes de usar estes detalhes para uma alteração.

## 1. Stack e ponto de entrada
- JavaScript em módulos ES.
- Phaser 3.90.0 para o jogo 2D.
- Vite 8.3.6 para servidor de desenvolvimento e build.
- Python para preparar/transformar os dados geográficos.
- Entrada: `src/main.js`.
- Cena principal: `src/scenes/WorldScene.js`.

`main.js` configura o Phaser, registra controles touch em `window.__araControls` e instancia `WorldScene`. A cena principal coordena carregamento do mapa, jogador, câmera, HUD, minimapa, colisões, atualização dos chunks e ferramentas de desenvolvimento.

## 2. Pipeline de dados do mapa
Scripts relevantes:
- `scripts/prepare_map.py`: transforma dados de origem do Knoxify e cache OpenStreetMap para o formato usado pelo jogo.
- `scripts/split_through_lots.py`: divide os lotes que atravessam a quadra de rua a rua em duas metades e marca os lotes irregulares como especiais (ver "Divisão de lotes passantes").
- `scripts/split_map_chunks.py`: divide os dados preparados em arquivos por chunk (e aplica `wall-ownership.json`, se válido).
- `scripts/compute_wall_ownership.mjs`: calcula o dono de cada divisa compartilhada (um muro por divisa).
- `scripts/build_road_index.py`: gera o índice de vias usado no cálculo de muros/recuos.
- `scripts/generate_assets.py`: gera recursos visuais procedurais.

O comando `npm run prepare:map` executa a preparação e depois `npm run split:lots` (divisão dos lotes, chunks, índice de vias e posse dos muros). O resultado observado em `public/data` inclui:
- `world-manifest.json`
- `minimap.json`
- `roads-index.json`
- `map.json`
- `chunks/*.json`

O mapa usa o sistema de coordenadas `EPSG:32722` (UTM 22S). A cena usa a escala de 16 pixels por metro (`PPM = 16`) e converte o eixo Y do mapa para o eixo de tela do Phaser.

### Particionamento geometrico dos chunks (manifesto v2)

- scripts/split_map_chunks.py recorta quadras e lotes na divisa de cada chunk usando Shapely. Geometrias concavas, buracos e intersecoes que geram mais de um fragmento no mesmo chunk sao preservados.
- Cada fragmento carrega polygon_indices para manter o indice original. chunk_clipped: true informa ao renderizador que o poligono ja esta local e nao deve passar por um segundo recorte.
- Lotes totalmente contidos em um chunk usam full_polygon_indices. Lotes que atravessam chunks mantem source_polygons uma unica vez, no chunk da ancora calculada com a mesma limpeza e orientacao de lotWalls.js. Isso permite construir o muro pelo perimetro completo sem duplicar a geometria em todos os chunks.
- Edificios ainda usam o formato anterior. A separacao de footprint, composicao visual e colisao precisa de uma etapa propria antes de recorta-los.
- world-manifest.json versao 2 separa map_version (identidade estavel para edicoes do World Editor) de cache_version (invalidacao dos arquivos de chunk).
- O preparo do mapa requer Shapely: python -m pip install -r requirements.txt.


## 3. Carregamento e gerenciamento de chunks
### `src/data/mapLoader.js`
Carrega em paralelo o manifesto do mundo e os dados do minimapa. Aceita manifestos v1 e v2; a versao 2 separa a identidade do mapa da chave de cache dos chunks. Valida versão do manifesto e CRS. Tenta carregar `roads-index.json`; se estiver ausente, avisa no console e retorna o índice vazio, o que desativa a geração dos muros dependentes desse índice.

### `src/scenes/WorldChunkManager.js`
É responsável por trabalhar com os dados divididos em chunks. O código define tamanho padrão de 512 pixels, carrega a janela necessária ao redor da área visível e mantém estruturas de chunks carregados/disponíveis. Também normaliza registros de quadras, lotes, ruas e árvores, instancia objetos visuais e mantém dados de colisão/cache. A camada de edifícios está vazia até a substituição da arte antiga.

Não force carregamento de chunks apenas para inspeção. Ferramentas de debug devem observar os dados já disponíveis e preservar o comportamento do gerenciador.

## 4. Geometria, muros e colisões
- `src/utils/geometry.js`: conversões de coordenadas e operações geométricas reutilizadas pelo jogo.
- `src/scenes/lotWalls.js`: regras e funções para segmentar vias, planejar muros/recuos de lotes e tratar portões.
- `WorldChunkManager.js`: integra os planos de muro, objetos do mundo e estruturas de colisão.
- `WorldScene.js`: usa os dados de colisão para impedir que o jogador atravesse objetos bloqueadores.

Ao alterar geometria, confira unidades: coordenadas do mapa em metros, coordenadas do mundo em pixels e fator de 16 pixels por metro. Atenção especial ao sinal do eixo Y.

## 5. Cena, jogador, controles e HUD
### Jogador
O jogador usa o spritesheet `public/assets/player.png`, com frames de 32x48, animações direcionais e movimento na cena principal.

### Controles
- Teclado: WASD ou setas para movimentação; E para interação.
- Touch: botões ligados a `window.__araControls` em `main.js`.
- O CSS principal fica em `src/style.css`.

### Câmeras e interface
`WorldScene` usa a câmera principal para o mundo e uma segunda câmera para o HUD. Objetos registrados por `registerHud` são separados da renderização da câmera do mundo. A cena também coordena minimapa, sobreposição de mapa, mensagens/toasts e painel de desempenho (F3).

Não mova elementos do HUD para a câmera do mundo sem avaliar scroll, zoom, safe area e redimensionamento da tela.

## 6. Ferramentas exclusivas de desenvolvimento
A cena carrega as ferramentas abaixo dinamicamente dentro de `if (import.meta.env.DEV)`. Elas não devem ser transformadas em dependências do jogo publicado.

### Free Camera — F6
Arquivo: `src/dev/FreeCamera.js`.
- Permite mover a câmera independentemente do jogador.
- WASD move a câmera; Shift acelera o deslocamento.
- Zoom por roda/controles disponíveis no módulo, com limites definidos nele.
- Permite retornar suavemente à câmera acompanhando o jogador.

### World Inspector — F7
Arquivos:
- `src/dev/WorldInspector.js`: interface e integração com a cena.
- `src/dev/inspectorCore.js`: cálculos e consultas sem dependência direta do Phaser, testáveis em Node.

Recursos observados: coordenadas de cursor em tela/mundo/metros e lon/lat, identificação de lote sob o cursor, seleção de construção/muro/árvore/rua/lote, grade, overlay de colisões, limites/estado dos chunks e medição de distância. Atalhos do painel: L, G, C, K, R e Esc.

O Inspector deve permanecer somente leitura: não altera dados do mapa nem força carregamento de chunks.

## 7. Arte e prévias
A cena carrega tiles/sprites e recursos de `public/assets`. Há conjuntos residenciais V2 e recursos de prévia V4. O parâmetro `?v4preview=1` ativa a prévia V4 na cena observada. Não substitua a arte principal por recursos de prévia sem autorização e validação visual.

## 8. Comandos definidos no package.json
- `npm run dev`: servidor Vite.
- `npm run build`: build de produção.
- `npm run preview`: prévia do build.
- `npm run prepare:map`: prepara o mapa, chunks e índice de vias.
- `npm run split:map`: refaz chunks e índice de vias.
- `npm run split:lots`: divide os lotes passantes, refaz chunks/índice e recalcula a posse dos muros (idempotente).
- `npm run test:data` também cobre a divisão de lotes (`tests/test_split_through_lots.py`).
- `npm run test:ownership`: testes de muros por divisa única e terrenos especiais.
- `npm run test:data`: testes Python dos dados.
- `npm run test:walls`: teste de muros/lotes.
- `npm run test:freecam`: testes da câmera livre.
- `npm run test:inspector`: testes do World Inspector.

## 9. Limites de escopo atuais
O protótipo ainda não deve ser tratado como implementação completa de:
- multiplayer;
- rotinas/simulação completa de NPCs;
- empregos, economia e inventário completos;
- sistema completo de propriedades;
- missões/história final;
- combate e polícia completos.

Esses itens pertencem à visão futura. Antes de implementar, planeje uma fatia pequena e jogável e confirme que ela se encaixa na arquitetura existente.

## World Editor

- `src/data/world-mods.default.json` define o baseline oficial de modificações. `WorldScene` valida sua `mapVersion` contra `mapVersionKey(mapData)` e aplica a camada compartilhada antes de criar os chunks, tanto em desenvolvimento quanto no build de produção.
- A camada ativa não contém os 1.023 edifícios antigos. Os polígonos foram arquivados em `archive/legacy-buildings-2026-11-21.json` e as antigas sprites/texturas em `archive/legacy-house-art/`, ambos fora de `public/` e sem serem carregados pelo jogo. Quadras, lotes, ruas, calçadas, grama e muros foram preservados.
- WorldEditor (F8) compartilha a camada da cena e mantém alterações não destrutivas em `worldMods.js`; restaurações e novas edições são persistidas no `localStorage`.
- A identidade do mapa mudou após a limpeza. Modificações locais da versão anterior são rejeitadas por incompatibilidade de `mapVersion`, evitando referências a edifícios que não existem mais.
- WorldChunkManager reaplica edições a chunks carregados e aos chunks criados posteriormente; chunks em montagem são invalidados e reiniciados com o estado atualizado.
- WorldInspector (F7) continua sendo somente leitura. Os dois painéis podem ficar abertos ao mesmo tempo.
- As alterações locais e os arquivos JSON exportados são vinculados à chave de cache dos chunks. Importar uma edição de outro mapa é recusado.
- O Modo Construção permanece reservado; a colocação/renderização de novos objetos não faz parte desta integração.

## Divisão de lotes passantes e muros por divisa única
Regras (constantes `RULES` em `scripts/split_through_lots.py`): o lote que vai de uma rua à rua oposta e tem formato regular (retangular, trapezoidal ou polígono regular) é cortado no meio da profundidade, paralelo às frentes, em duas metades (`<id>_a`, `<id>_b`), cada uma com frente para uma rua. Mínimos por metade: profundidade 18 m, largura 8 m, área 200 m². Abaixo disso o lote é preservado. Lote de formato irregular não é dividido e recebe `lot_kind: "special"` e `wall_policy: "none"`: não tem muro automático (tratamento especial futuro).

Propriedades novas dos lotes em `map.json`/chunks: `lot_kind` (`split` | `special`), `parent_lot_id`, `split_side`, `wall_policy`, `wall_skip`. `public/data/lot-split-report.json` guarda os parâmetros e as contagens (não é carregado pelo jogo).

Um muro por divisa: `scripts/compute_wall_ownership.mjs` planeja os muros com o próprio `planLotWall` e, onde dois lotes têm muro na mesma divisa, o de menor ID é o dono; o outro recebe em `wall-ownership.json` (e depois em `wall_skip` nos chunks) o trecho a ceder. `planLotWall(ring, { skipSegs })` remove esses trechos (`skipIntervals`/`subtractIntervals`). Vizinho especial ou sem plano nunca cede. O arquivo é amarrado ao hash do `map.json`; `split_map_chunks.py` o ignora, com aviso, se o hash não bater. Se `lotWalls.js` mudar, rode `npm run split:lots` e `node scripts/compute_wall_ownership.mjs --check`.

Pontos de atenção: o `map_version` muda (as edições locais do World Editor deixam de valer, por desenho) e o baseline `src/data/world-mods.default.json` precisa acompanhar o `map_version` do manifesto; os IDs `wall:<lote>:...` do editor passam a usar os IDs novos dos lotes.
