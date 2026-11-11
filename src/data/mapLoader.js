export async function loadPreparedMap() {
  const candidates = ["/data/aracatexas_map.json", "/data/map.json"];
  let lastError = null;

  for (const path of candidates) {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status} ao carregar ${path}`);
      const map = await response.json();
      const required = ["blocks", "lots", "buildings", "roads"];
      for (const key of required) {
        if (!Array.isArray(map[key])) {
          throw new Error(`O mapa está incompleto: a camada "${key}" não existe.`);
        }
      }
      if (!map.meta || map.meta.crs !== "EPSG:32722") {
        throw new Error("Sistema de coordenadas inesperado. Esperado EPSG:32722.");
      }
      map.trees = Array.isArray(map.trees) ? map.trees : [];
      map.visual = map.visual || null;
      console.info(`[Araçatexas] Mapa carregado: ${path}`, {
        blocks: map.blocks.length,
        lots: map.lots.length,
        buildings: map.buildings.length,
        roads: map.roads.length,
        trees: map.trees.length
      });
      return map;
    } catch (error) {
      lastError = error;
      console.warn(`[Araçatexas] Falha ao carregar ${path}:`, error);
    }
  }
  throw lastError || new Error("Nenhum arquivo de mapa válido foi encontrado.");
}
