async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Não foi possível carregar ${path} (HTTP ${response.status}).`);
  }
  return response.json();
}

export async function loadPreparedMap() {
  const baseUrl = import.meta.env.BASE_URL;
  const [manifest, minimap] = await Promise.all([
    fetchJson(`${baseUrl}data/world-manifest.json`),
    fetchJson(`${baseUrl}data/minimap.json`)
  ]);

  if (manifest.version !== 1 || !Array.isArray(manifest.chunks)) {
    throw new Error("O manifesto de chunks está ausente ou em versão incompatível. Execute npm run prepare:map.");
  }
  if (!manifest.meta || manifest.meta.crs !== "EPSG:32722") {
    throw new Error("Sistema de coordenadas inesperado no manifesto do mapa.");
  }
  if (!Array.isArray(minimap.roads)) {
    throw new Error("Os dados do minimapa estão incompletos. Execute npm run prepare:map.");
  }

  return {
    meta: manifest.meta,
    roads: minimap.roads,
    chunkManifest: manifest,
    chunkBaseUrl: `${baseUrl}data/chunks/`
  };
}