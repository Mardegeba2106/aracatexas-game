export async function loadPreparedMap() {
  const response = await fetch("/data/map.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `O arquivo public/data/map.json não foi encontrado (HTTP ${response.status}).`
    );
  }

  const map = await response.json();
  const required = ["blocks", "lots", "buildings", "roads"];
  for (const key of required) {
    if (!Array.isArray(map[key])) {
      throw new Error(`O mapa preparado está incompleto: a camada "${key}" não existe.`);
    }
  }
  if (!map.meta || map.meta.crs !== "EPSG:32722") {
    throw new Error("Sistema de coordenadas inesperado. Gere novamente os dados com prepare_map.py.");
  }
  return map;
}
