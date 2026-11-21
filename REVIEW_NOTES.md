# Revisão técnica — World Editor

Esta revisão parte dos arquivos entregues pelo Claude, recebeu correções e testes adicionais e foi integrada ao projeto principal.

## Correções
- Edições que atingem chunks no estado building marcam o chunk como desatualizado e reiniciam suas etapas com a camada de modificações atual, sem interromper o streaming.
- Colisões globais e seleção de elementos consideram apenas chunks totalmente carregados.
- A identidade das edições usa a chave de cache dos chunks (ou o mesmo fallback do mapLoader), não apenas a versão do formato do manifesto.
- Importação, armazenamento local, desfazer/refazer e restauração tratam o campo added, reservado para futuras construções.
- A UI informa erros e avisos ao carregar dados salvos ou importar arquivos de outra versão do mapa.

## Testes acrescentados
- O teste E2E agora aguarda chunks totalmente carregados e dados de colisão antes de iniciar as verificações, eliminando a corrida que gerava falha intermitente.
- Regressão de uma construção que atravessa três chunks, com uma montagem pausada durante a edição.
- Rejeição de modificações vinculadas a outra identidade de mapa.
- Preservação e histórico dos objetos added.
- Teste de navegador F8, presença dos modos, coexistência com F7, edição real de construção, colisão, persistência, desfazer/refazer/restaurar e ausência de erros de console.

## Limites mantidos
- O Modo Construção permanece reservado na interface. Criar, mover, rotacionar e renderizar novos objetos ainda não está implementado.
- Em certas casas residenciais V2, estrutura e telhado são um único sprite e não podem ser editados separadamente.
- A suíte automatizada não substitui a avaliação visual do editor no navegador com renderização de GPU.

## Comandos de validação
- npm run test:editor
- npm run test:editor:ui (com Vite ativo; o teste abre buildings=1 para validar edição de construção)
- npm run test:streaming
- npm run test:walls
- npm run test:freecam
- npm run test:inspector
- npm run test:e2e
- npm run test:data
- npm run build
