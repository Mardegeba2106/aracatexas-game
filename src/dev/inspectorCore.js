// World Inspector (Dev Mode): lógica pura, sem Phaser, testável em Node.
// Reaproveita as estruturas que o jogo já tem (chunkManager.loaded, record.lots,
// record.buildings, collisions...). Nada aqui altera dados do mapa e nada força
// o carregamento de chunks.
import { pointInPolygon } from "../utils/geometry.js";
import { ids as modIds } from "../scenes/worldMods.js";

export const PPM = 16; // pixels por metro (a mesma escala do jogo)

// ------------------------------------------------------------ coordenadas
// Fórmula exata da câmera do Phaser (validada contra Camera.getWorldPoint):
// mundo = scroll + w/2 - w/(2z) + tela/z. Usa o scroll que o jogo está desenhando.
export function screenToWorld(cam, sx, sy) {
  const z = cam.zoom;
  return {
    x: cam.scrollX + cam.width / 2 - cam.width / (2 * z) + sx / z,
    y: cam.scrollY + cam.height / 2 - cam.height / (2 * z) + sy / z
  };
}

export function worldToScreen(cam, wx, wy) {
  const z = cam.zoom;
  return {
    x: (wx - cam.scrollX - cam.width / 2) * z + cam.width / 2,
    y: (wy - cam.scrollY - cam.height / 2) * z + cam.height / 2
  };
}

// Mundo em pixels (y para baixo) <-> metros do mapa (x leste, y norte).
export const worldToMeters = (p, ppm = PPM) => ({ x: p.x / ppm, y: -p.y / ppm });
export const metersToWorld = (p, ppm = PPM) => ({ x: p.x * ppm, y: -p.y * ppm });

export function distanceMeters(a, b, ppm = PPM) {
  const dx = (b.x - a.x) / ppm, dy = (b.y - a.y) / ppm;
  return { meters: Math.hypot(dx, dy), dx, dy: -dy };
}

// UTM (WGS84) -> longitude/latitude. Série de Krüger de 3ª ordem (erro < 1 mm).
export function utmToLonLat(easting, northing, zone, south) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const n = f / (2 - f);
  const A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64);
  const beta = [n / 2 - 2 * n * n / 3 + 37 * n ** 3 / 96, n * n / 48 + n ** 3 / 15, 17 * n ** 3 / 480];
  const delta = [2 * n - 2 * n * n / 3 - 2 * n ** 3, 7 * n * n / 3 - 8 * n ** 3 / 5, 56 * n ** 3 / 15];
  const xi = (northing - (south ? 10000000 : 0)) / (k0 * A);
  const eta = (easting - 500000) / (k0 * A);
  let xiP = xi, etaP = eta;
  for (let j = 1; j <= 3; j++) {
    xiP -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  let lat = chi;
  for (let j = 1; j <= 3; j++) lat += delta[j - 1] * Math.sin(2 * j * chi);
  const lon0 = (zone * 6 - 183) * Math.PI / 180;
  const lon = lon0 + Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  return { lon: lon * 180 / Math.PI, lat: lat * 180 / Math.PI };
}

// meta do world-manifest: origin_utm + crs ("EPSG:32722" = UTM 22 sul).
export function metersToLonLat(meta, xm, ym) {
  const m = /EPSG:(326|327)(\d\d)/.exec(meta?.crs || "");
  if (!m || !meta?.origin_utm) return null;
  return utmToLonLat(meta.origin_utm[0] + xm, meta.origin_utm[1] + ym, Number(m[2]), m[1] === "327");
}

// ------------------------------------------------------------------ grade
// Escolhe o passo da grade (em metros) para as linhas nunca ficarem densas demais.
export function gridStepMeters(zoom, ppm = PPM, minPx = 48) {
  for (const step of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]) {
    if (step * ppm * zoom >= minPx) return step;
  }
  return 5000;
}

export function viewBounds(cam) {
  const z = cam.zoom;
  const minX = cam.scrollX + cam.width / 2 - cam.width / (2 * z);
  const minY = cam.scrollY + cam.height / 2 - cam.height / (2 * z);
  return { minX, minY, maxX: minX + cam.width / z, maxY: minY + cam.height / z };
}

export const boundsIntersect = (a, b) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

// ----------------------------------------------------------------- chunks
export function chunkCoordsAt(wx, wy, chunkSize) {
  const cx = Math.floor(wx / chunkSize), cy = Math.floor(wy / chunkSize);
  return { cx, cy, key: `${cx}_${cy}` };
}

// Informações de um chunk SEM carregá-lo: só consulta o que já existe.
export function describeChunk(manager, cx, cy) {
  const key = `${cx}_${cy}`;
  const size = manager.chunkSize;
  const chunk = manager.loaded.get(key) || null;
  const record = chunk?.record || null;
  const info = {
    key, cx, cy,
    exists: manager.available.has(key),
    loaded: Boolean(chunk),
    state: chunk?.state || null,
    originMeters: { x: (cx * size) / PPM, y: -((cy + 1) * size) / PPM }, // canto sudoeste
    sizeMeters: size / PPM,
    counts: null,
    loadedTotal: manager.loaded.size,
    loadingTotal: manager.loadingCount
  };
  if (record) {
    info.counts = {
      blocos: record.blocks.length, lotes: record.lots.length,
      construções: record.buildings.length, ruas: record.roads.length,
      árvores: record.trees.length, colisões: record.collisions.length
    };
  }
  return info;
}

// ------------------------------------------------------------------ picks
const inBounds = (b, p, pad = 0) =>
  p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad;

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

const chunkRecordAt = (manager, p) => {
  const { key } = chunkCoordsAt(p.x, p.y, manager.chunkSize);
  const chunk = manager.loaded.get(key);
  return chunk?.record ? { chunk, record: chunk.record } : null;
};

function pickPolygon(manager, p, type) {
  const hit = chunkRecordAt(manager, p);
  if (!hit) return null;
  for (const item of hit.record[type]) {
    if (!inBounds(item.bounds, p)) continue;
    for (let i = 0; i < item.polygons.length; i++) {
      if (pointInPolygon(p, item.polygons[i])) {
        // World Editor: construção ocultada/removida não é mais "visível" para a consulta.
        const polygonIndex = item.polygonIndices?.[i] ?? i;
        if (type === "buildings" && manager.isElementRendered &&
            !manager.isElementRendered(modIds.building(item.feature.id, polygonIndex))) continue;
        return {
          kind: type === "lots" ? "lot" : "building",
          item, polygonIndex, fragmentIndex: i, chunkKey: hit.chunk.key
        };
      }
    }
  }
  return null;
}

export const pickLot = (manager, p) => pickPolygon(manager, p, "lots");
export const pickBuilding = (manager, p) => pickPolygon(manager, p, "buildings");

// Muros: usa os planos que o jogo já calculou (lotWallPlans). Só lê o cache.
export function pickWall(manager, p, tolerance = 7) {
  let best = null;
  for (const [key, plan] of manager.lotWallPlans || []) {
    if (!plan || !inBounds(plan.bbox, p, tolerance + 28)) continue;
    for (const seg of plan.collisions) {
      const d = segDist(p, seg.a, seg.b);
      // World Editor: trecho ocultado/removido não é selecionável aqui.
      if (seg.piece !== undefined && manager.isElementRendered &&
          !manager.isElementRendered(modIds.wallPiece(key, seg.piece))) continue;
      if (d <= tolerance && (!best || d < best.distance)) {
        best = { kind: "wall", lotKey: key, plan, segment: seg, distance: d };
      }
    }
  }
  return best;
}

export function pickTree(manager, p) {
  const hit = chunkRecordAt(manager, p);
  if (!hit) return null;
  for (const tree of hit.record.trees) {
    if (Math.hypot(p.x - tree.point.x, p.y - tree.point.y) <= tree.radius) {
      return { kind: "tree", item: tree, chunkKey: hit.chunk.key };
    }
  }
  return null;
}

export function pickRoad(manager, p) {
  const hit = chunkRecordAt(manager, p);
  if (!hit) return null;
  let best = null;
  for (const item of hit.record.roads) {
    for (const line of item.lines) {
      for (let i = 0; i < line.length - 1; i++) {
        const d = segDist(p, line[i], line[i + 1]);
        if (d <= item.roadWidth / 2 && (!best || d < best.distance)) {
          best = { kind: "road", item, distance: d, chunkKey: hit.chunk.key };
        }
      }
    }
  }
  return best;
}

// Clique: construção > muro > árvore > rua > lote.
export function pickObject(manager, p) {
  const building = manager.showBuildings === false ? null : pickBuilding(manager, p);
  return building || pickWall(manager, p) || pickTree(manager, p)
    || pickRoad(manager, p) || pickLot(manager, p);
}

// -------------------------------------------------------------- descrições
const HIDDEN = new Set(["polygons", "lines", "point", "coordinates", "geometry"]);
const fmt = (v, d = 1) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : String(v));

// Mostra só as propriedades que existem (strings, números, booleanos).
export function featureProps(feature, skip = [], limit = 9) {
  const out = [];
  for (const [k, v] of Object.entries(feature || {})) {
    if (HIDDEN.has(k) || skip.includes(k)) continue;
    if (v === null || v === undefined || v === "" || typeof v === "object") continue;
    out.push([k, fmt(v)]);
    if (out.length >= limit) break;
  }
  return out;
}

function polygonStats(polygons, index) {
  const ring = polygons[index]?.[0] || [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cx = 0, cy = 0;
  for (const p of ring) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    cx += p.x; cy += p.y;
  }
  const n = Math.max(1, ring.length);
  return {
    width: (maxX - minX) / PPM, height: (maxY - minY) / PPM,
    center: { x: minX === Infinity ? 0 : (minX + maxX) / 2, y: minY === Infinity ? 0 : (minY + maxY) / 2 },
    vertices: Math.max(0, ring.length - (ring.length > 1 && ring[0].x === ring[ring.length - 1].x && ring[0].y === ring[ring.length - 1].y ? 1 : 0)),
    centroid: { x: cx / n, y: cy / n }
  };
}

// Linhas "rótulo: valor" para o painel. Só entra o que existe.
export function describeObject(sel, manager) {
  if (!sel) return [];
  const size = manager.chunkSize;
  const lines = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== "") lines.push([k, v]); };
  const at = c => {
    const m = worldToMeters(c);
    return `x ${m.x.toFixed(1)}  y ${m.y.toFixed(1)} m`;
  };

  if (sel.kind === "lot" || sel.kind === "building") {
    const f = sel.item.feature;
    const st = polygonStats(sel.item.polygons, sel.fragmentIndex ?? sel.polygonIndex);
    add("tipo", sel.kind === "lot" ? "lote" : `construção (${f.building_type || "casa"})`);
    add("id", f.id);
    if (sel.kind === "lot") { add("zona", f.zone); add("área", f.area_m2 !== undefined ? `${fmt(f.area_m2)} m²` : null); }
    else { add("nome", f.name); add("área", f.area_m2 !== undefined ? `${fmt(f.area_m2)} m²` : null); }
    add("caixa", `${st.width.toFixed(1)} x ${st.height.toFixed(1)} m`);
    add("centro", at(st.center));
    add("vértices", st.vertices);
    add("chunk", sel.chunkKey);
    const skip = [
      "id", "zone", "area_m2", "name", "building_type",
      "polygon_indices", "full_polygon_indices", "source_polygons", "chunk_clipped", "wall_skip"
    ];
    for (const [k, v] of featureProps(f, skip, 6)) add(k, v);
    if (sel.kind === "lot") {
      const key = `${f.id}:${sel.polygonIndex}`;
      if (manager.lotWallPlans?.has(key)) {
        const plan = manager.lotWallPlans.get(key);
        add("muro", plan ? `sim, recuo máx ${(plan.insetMax / PPM).toFixed(1)} m${plan.gate ? ", portão" : ""}` : "não gerado");
      }
    } else {
      const has = (manager.scene?.buildingCollision || []).some(c => c.key === `${f.id}:${sel.polygonIndex}`);
      add("colisão", has ? "sim" : "não");
    }
  } else if (sel.kind === "road") {
    const f = sel.item.feature;
    add("tipo", "rua");
    add("id", f.id); add("nome", f.name); add("via", f.highway);
    add("largura", f.width_m !== undefined ? `${fmt(f.width_m)} m` : null);
    const sw = manager.getSidewalkWidthMeters?.({ feature: f });
    if (typeof sw === "number") add("calçada", sw > 0 ? `${fmt(sw)} m` : "sem calçada");
    add("chunk", sel.chunkKey);
  } else if (sel.kind === "tree") {
    add("tipo", "árvore"); add("id", sel.item.feature.id);
    add("centro", at(sel.item.point)); add("raio", `${(sel.item.radius / PPM).toFixed(2)} m`);
    add("chunk", sel.chunkKey);
    for (const [k, v] of featureProps(sel.item.feature, ["id"], 5)) add(k, v);
  } else if (sel.kind === "wall") {
    const mid = { x: (sel.segment.a.x + sel.segment.b.x) / 2, y: (sel.segment.a.y + sel.segment.b.y) / 2 };
    add("tipo", "muro de lote");
    add("lote", sel.lotKey.split(":")[0]);
    add("trecho", `${(Math.hypot(sel.segment.b.x - sel.segment.a.x, sel.segment.b.y - sel.segment.a.y) / PPM).toFixed(1)} m`);
    add("posição", at(mid));
    add("chunk", chunkCoordsAt(mid.x, mid.y, size).key);
    add("trechos do lote", sel.plan.collisions.length);
  }
  return lines;
}
