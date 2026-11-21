// Zoom-based visual simplification. World data and collision geometry never change.
export function resolveLodLevel(zoom, previousLevel = null) {
  if (!Number.isFinite(zoom)) return previousLevel ?? 0;

  if (previousLevel === null) {
    if (zoom < 0.30) return 3;
    if (zoom < 0.55) return 2;
    if (zoom < 0.85) return 1;
    return 0;
  }

  // Small hysteresis bands avoid rapid visibility changes around thresholds.
  if (previousLevel === 0) {
    if (zoom < 0.27) return 3;
    if (zoom < 0.52) return 2;
    if (zoom < 0.82) return 1;
    return 0;
  }
  if (previousLevel === 1) {
    if (zoom > 0.88) return 0;
    if (zoom < 0.27) return 3;
    if (zoom < 0.52) return 2;
    return 1;
  }
  if (previousLevel === 2) {
    if (zoom > 0.88) return 0;
    if (zoom > 0.58) return 1;
    if (zoom < 0.27) return 3;
    return 2;
  }
  if (previousLevel === 3) {
    if (zoom > 0.88) return 0;
    if (zoom > 0.58) return 1;
    if (zoom > 0.33) return 2;
    return 3;
  }

  return 0;
}

const layerVisible = (layer, level) => {
  if (layer === "labels") return level === 0;
  if (layer === "roofDetails") return level === 0;
  if (layer === "properties") return level <= 2;
  if (layer === "foliage") return level <= 1;
  return true;
};

export default class WorldLODManager {
  constructor() {
    this.level = null;
  }

  register(chunk, layer, object) {
    if (!chunk || !layer || !object) return;
    chunk.lodLayers ||= {};
    chunk.lodLayers[layer] ||= [];
    if (layer === "terrain") {
      object.__lodBaseTileScaleX = object.tileScaleX || 1;
      object.__lodBaseTileScaleY = object.tileScaleY || 1;
    }
    chunk.lodLayers[layer].push(object);
    if (this.level !== null) this.setObjectVisible(object, layerVisible(layer, this.level), layer, this.level);
  }

  setObjectVisible(object, visible, layer = null, level = 0) {
    if (layer === "terrain" && typeof object.setTileScale === "function") {
      // Aumenta o tamanho aparente do padrão à distância, reduzindo a repetição
      // de microdetalhes sem esconder o terreno nem alterar a geometria.
      const scale = [1, 1.35, 1.9, 2.6][level] || 1;
      object.setTileScale(
        (object.__lodBaseTileScaleX || 1) * scale,
        (object.__lodBaseTileScaleY || 1) * scale
      );
    }
    if (typeof object.setVisible === "function") object.setVisible(visible);
    else object.visible = visible;
  }

  applyChunk(chunk) {
    if (!chunk?.lodLayers || this.level === null) return;
    for (const [layer, objects] of Object.entries(chunk.lodLayers)) {
      const visible = layerVisible(layer, this.level);
      for (const object of objects) this.setObjectVisible(object, visible, layer, this.level);
    }
  }

  update(zoom, chunks) {
    const nextLevel = resolveLodLevel(zoom, this.level);
    if (nextLevel === this.level) return false;
    this.level = nextLevel;
    for (const chunk of chunks) this.applyChunk(chunk);
    return true;
  }
}
