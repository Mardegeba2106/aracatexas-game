# Araçatexas — estado atual

**Última atualização:** 20/11/2026
**Raiz oficial:** C:\Users\guilh\Desktop\python\aracatexas-game
**Branch de publicação:** main

## 1. Estado do projeto

O projeto usa Phaser 3.90.0, Vite 8.3.6 e dados geográficos preparados em EPSG:32722. O mundo é dividido em chunks, com carregamento ao redor da área visível. O mapa, minimapa, índice de vias, lotes, edifícios, árvores, colisões e muros fazem parte da base técnica atual.

A prévia visual residencial V4 é experimental e pode ser ativada com ?v4preview=1. A arte V4 não deve ser tratada como substituta automática de toda a arte principal.

## 2. Ferramentas de desenvolvimento

### Free Camera — F6
- Movimenta a câmera independentemente do personagem.
- WASD move a câmera; Shift acelera.
- Permite zoom e retorno suave ao personagem.
- Bloqueia o movimento/interação do personagem enquanto está ativa.
- Carregada apenas no modo de desenvolvimento.

### World Inspector — F7
- Exibe coordenadas de cursor, mundo, metros e lon/lat.
- Permite destacar e selecionar lotes, construções, muros, árvores e ruas.
- Inclui grade, visualização de colisões, limites/estado de chunks e medidor de distância.
- Atalhos no painel: L (lotes), G (grade), C (colisões), K (chunks), R (medidor), Esc (cancelar/limpar).
- É somente leitura: não altera o mapa nem força carregamento de chunks.
- As camadas de inspeção só aparecem enquanto o painel F7 está aberto; ao fechar, os desenhos e rótulos são removidos.
- Carregada apenas no modo de desenvolvimento.

### Outros elementos
- HUD separado por câmera, minimapa circular e mapa expandido (M).
- Painel de desempenho (F3).
- Preview V4 pela query string ?v4preview=1.

## 3. Validação executada em 20/11/2026

- npm.cmd run build: concluído com sucesso. O Vite emitiu apenas o aviso de bundle JavaScript acima de 500 kB.
- npm.cmd run test:walls: 1.341 lotes lidos, 1.156 planos de muro, zero violações geométricas.
- npm.cmd run test:freecam: todos os testes passaram.
- npm.cmd run test:inspector: todos os testes passaram.
- npm.cmd run test:e2e: todos os checks passaram; inclui a confirmação de que grade e limites desaparecem ao fechar F7. Nenhum erro de console/exceção foi observado.

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