# Araçatexas — estado atual

**Última atualização:** 21/11/2026
**Raiz oficial:** C:\Users\guilh\Desktop\python\aracatexas-game
**Branch de publicação:** main

## 1. Estado do projeto

O projeto usa Phaser 3.90.0, Vite 8.3.6 e dados geográficos preparados em EPSG:32722. O mundo é dividido em chunks, com carregamento ao redor da área visível. O mapa ativo mantém quadras, lotes, ruas, calçadas, grama e muros; a camada antiga de edifícios foi removida até a nova arte ser criada.

A prévia visual residencial V4 é experimental e pode ser ativada com ?v4preview=1. A arte V4 não deve ser tratada como substituta automática de toda a arte principal.

## 2. Otimizacao geometrica dos chunks

- Quadras e lotes agora sao recortados no gerador para armazenar somente a geometria local de cada chunk. Os indices originais sao preservados para o Inspector, o Editor e os muros.
- Lotes que cruzam chunks mantem uma unica geometria-fonte no chunk de ancora de lotWalls.js; os demais chunks guardam apenas os fragmentos locais. Edificios permanecem no formato anterior ate uma etapa especifica de footprint/colisao.
- Manifesto v2 usa map_version estavel e cache_version independente. A identidade atual do mapa foi preservada para nao invalidar edicoes locais do World Editor.
- Dependencia de preparo: python -m pip install -r requirements.txt (Shapely).

**Medicao no mapa atual:** 1.732 -> 1.604 chunks; JSON espacial de 6.473.824 -> 2.925.302 bytes (reducao de aproximadamente 54,8%). As 1.341 geometrias de lote e 150 de quadra continuam cobertas. Diferenca maxima de area na validacao numerica: menor que 0,00028 m2 por poligono.

## 3. Ferramentas de desenvolvimento

### Free Camera — F6
- Movimenta a câmera independentemente do personagem.
- WASD move a câmera; Shift acelera.
- Permite zoom e retorno suave ao personagem.
- Bloqueia o movimento/interação do personagem enquanto está ativa.
- Carregada apenas no modo de desenvolvimento.

### World Inspector — F7
- Exibe coordenadas de cursor, mundo, metros e lon/lat.
- Permite destacar e selecionar lotes, muros, árvores e ruas. A camada antiga de construções está vazia.
- Inclui grade, visualização de colisões, limites/estado de chunks e medidor de distância.
- Atalhos no painel: L (lotes), G (grade), C (colisões), K (chunks), R (medidor), Esc (cancelar/limpar).
- É somente leitura: não altera o mapa nem força carregamento de chunks.
- As camadas de inspeção só aparecem enquanto o painel F7 está aberto; ao fechar, os desenhos e rótulos são removidos.
- Carregada apenas no modo de desenvolvimento.

### Outros elementos
- HUD separado por câmera, minimapa circular e mapa expandido (M).
- Painel de desempenho (F3).
- Preview V4 pela query string ?v4preview=1.

## 3. Validação executada em 21/11/2026

- `npm.cmd run build`: concluído com sucesso. O Vite emitiu apenas o aviso já conhecido de bundle Phaser acima de 500 kB.
- `npm.cmd run test:editor`: validado para a camada de modificações; o baseline oficial agora começa vazio, sem as 70 remoções antigas.
- `npm.cmd run test:editor:ui`: passou; confirmou camada sem edifícios, painel F8 e coexistência independente com F7.
- `npm.cmd run test:streaming`, `test:walls`, `test:freecam`, `test:inspector` e `test:data`: todos passaram. Muros: 1.341 lotes lidos, 1.156 planos, zero violações geométricas.
- `node scripts/e2e_dev_tools.mjs` com preview local: todos os checks passaram, inclusive F6/F7, colisões, LOD e streaming; nenhum erro de console/exceção foi observado.

Os testes E2E usam Chrome headless e não substituem a validação visual em GPU/navegador normal.

## 4. Scripts úteis

- npm.cmd run dev: servidor local Vite.
- npm.cmd run build: build de produção.
- npm.cmd run prepare:map: prepara dados geográficos, chunks e índice de vias.
- npm.cmd run test:data: testes Python dos dados.
- npm.cmd run test:walls: validação dos muros.
- npm.cmd run test:freecam: testes da câmera livre.
- npm.cmd run test:inspector: testes do Inspector.
- npm.cmd run test:e2e: teste integrado em navegador.

## 5. Próximos passos recomendados

1. Fazer validação visual manual do F6/F7 e da prévia V4 no navegador normal.
2. Estabilizar fachadas, muros, portões, calçadas e colisões.
3. Completar elementos urbanos e pontos reconhecíveis de Araçatuba.
4. Só depois avançar para as primeiras interações de gameplay.

Não começar vários sistemas grandes em paralelo. Manter entregas pequenas, testáveis e jogáveis.

## World Editor integrado

- F8 abre o editor; F7 mantém o Inspector. Seleção, ocultar/remover/restaurar, colisão e histórico Ctrl+Z/Ctrl+Y fazem parte do modo Edição.
- As edições são salvas em armazenamento local e podem ser exportadas/importadas em JSON.
- Os polígonos dos 1.023 edifícios antigos e as texturas/sprites dos projetos residenciais anteriores foram arquivados fora de `public/`. Quadras, 1.341 lotes, 210 vias, calçadas, grama e dados de muros permanecem. Construção/posicionamento continuam reservados para etapa futura.
- `src/data/world-mods.default.json` é o baseline oficial vazio. A identidade do mapa foi atualizada, então modificações locais da versão antiga não são aplicadas ao mapa limpo.
- `WorldScene` carrega o baseline antes de criar os chunks, inclusive no build de produção. A configuração só é aplicada quando a identidade do mapa coincide exatamente.
- O World Editor compartilha a camada da cena. Storages com a identidade antiga do mapa são ignorados para não reaplicar IDs de edifícios removidos; novas edições passam a ser salvas com a identidade atual.
- Testes: `npm.cmd run test:editor`; com Vite ativo, `npm.cmd run test:editor:ui`.
- O teste de navegador do World Editor valida a camada limpa e a coexistência independente dos painéis F7 (Inspector) e F8 (Editor). A lógica de edição/undo/redo segue coberta pelos testes unitários.
