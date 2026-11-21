import Phaser from "phaser";
import { toWorld, polygonBounds, polygonCentroid, getFeaturePolygons } from "../utils/geometry.js";
import { WALL_CFG, buildRoadSegments, planLotWall, mixColor } from "./lotWalls.js";
import ChunkStreamingManager from "./ChunkStreamingManager.js";
import WorldLODManager from "./WorldLODManager.js";

const PPM = 16;
const CHUNK_SIZE = 512;

const palette = {
  lot: [0x6c8850, 0x718d53, 0x7a9258, 0x667f4c],
  roof: [0x9b5540, 0xa56c4a, 0x797d78, 0x8d6651],
  commercial: [0x657b83, 0x788b8b, 0x8c8272],
  industrial: [0x777c76, 0x8a8a7b]
};

const hash = value => {
  let h = 2166136261;
  const text = String(value);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    const crosses = (a.y > point.y) !== (b.y > point.y);
    if (crosses && point.x < (b.x - a.x) * (point.y - a.y) /
        ((b.y - a.y) || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

function isRectangularLotRing(sourceRing) {
  const corners = sourceRing.slice();
  if (corners.length > 1) {
    const first = corners[0];
    const last = corners[corners.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-4) corners.pop();
  }

  // Ignore extra OSM points placed along an otherwise straight property edge.
  let simplified = true;
  const straightTolerance = Math.sin(8 * Math.PI / 180);
  while (simplified && corners.length > 4) {
    simplified = false;
    for (let i = 0; i < corners.length; i++) {
      const previous = corners[(i - 1 + corners.length) % corners.length];
      const current = corners[i];
      const next = corners[(i + 1) % corners.length];
      const incoming = { x: current.x - previous.x, y: current.y - previous.y };
      const outgoing = { x: next.x - current.x, y: next.y - current.y };
      const incomingLength = Math.hypot(incoming.x, incoming.y);
      const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
      if (incomingLength < 1 || outgoingLength < 1) continue;
      const cross = Math.abs(
        incoming.x * outgoing.y - incoming.y * outgoing.x
      ) / (incomingLength * outgoingLength);
      const dot = (
        incoming.x * outgoing.x + incoming.y * outgoing.y
      ) / (incomingLength * outgoingLength);
      if (cross <= straightTolerance && dot > 0) {
        corners.splice(i, 1);
        simplified = true;
        break;
      }
    }
  }

  if (corners.length !== 4) return false;

  const sides = [];
  let turnSign = 0;
  const angleTolerance = 12 * Math.PI / 180;
  const parallelTolerance = Math.sin(angleTolerance);

  for (let i = 0; i < 4; i++) {
    const previous = corners[(i + 3) % 4];
    const current = corners[i];
    const next = corners[(i + 1) % 4];
    const toPrevious = { x: previous.x - current.x, y: previous.y - current.y };
    const toNext = { x: next.x - current.x, y: next.y - current.y };
    const previousLength = Math.hypot(toPrevious.x, toPrevious.y);
    const nextLength = Math.hypot(toNext.x, toNext.y);
    if (previousLength < 2 || nextLength < 2) return false;

    const cosine = Phaser.Math.Clamp(
      (toPrevious.x * toNext.x + toPrevious.y * toNext.y) /
        (previousLength * nextLength),
      -1,
      1
    );
    const angle = Math.acos(cosine);
    if (Math.abs(angle - Math.PI / 2) > angleTolerance) return false;

    const incoming = { x: current.x - previous.x, y: current.y - previous.y };
    const outgoing = { x: next.x - current.x, y: next.y - current.y };
    const turn = incoming.x * outgoing.y - incoming.y * outgoing.x;
    if (Math.abs(turn) < 1e-4) return false;
    const sign = Math.sign(turn);
    if (turnSign && sign !== turnSign) return false;
    turnSign = sign;

    sides.push(Math.hypot(outgoing.x, outgoing.y));
  }

  const parallelError = (a, b) => Math.abs(
    a.x * b.y - a.y * b.x
  ) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y));

  const edges = corners.map((point, index) => {
    const next = corners[(index + 1) % 4];
    return { x: next.x - point.x, y: next.y - point.y };
  });

  if (parallelError(edges[0], edges[2]) > parallelTolerance ||
      parallelError(edges[1], edges[3]) > parallelTolerance) return false;

  const oppositeRatio = (a, b) => Math.max(a, b) / Math.min(a, b);
  if (oppositeRatio(sides[0], sides[2]) > 1.25 ||
      oppositeRatio(sides[1], sides[3]) > 1.25) return false;

  return true;
}

function closestPointOnSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 1e-9
    ? Phaser.Math.Clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq, 0, 1)
    : 0;
  const nearest = { x: a.x + dx * t, y: a.y + dy * t };
  return {
    point: nearest,
    distance: Phaser.Math.Distance.Between(point.x, point.y, nearest.x, nearest.y)
  };
}

function mergeBounds(target, source) {
  target.minX = Math.min(target.minX, source.minX);
  target.minY = Math.min(target.minY, source.minY);
  target.maxX = Math.max(target.maxX, source.maxX);
  target.maxY = Math.max(target.maxY, source.maxY);
}

function boundsOfPolygons(polygons) {
  const bounds = {
    minX: Infinity, minY: Infinity,
    maxX: -Infinity, maxY: -Infinity
  };
  for (const polygon of polygons) {
    if (polygon[0]?.length >= 3) mergeBounds(bounds, polygonBounds(polygon[0]));
  }
  return bounds;
}

function clipSegment(a, b, rect) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const tests = [
    [-dx, a.x - rect.minX],
    [dx, rect.maxX - a.x],
    [-dy, a.y - rect.minY],
    [dy, rect.maxY - a.y]
  ];

  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      t0 = Math.max(t0, t);
    } else {
      if (t < t0) return null;
      t1 = Math.min(t1, t);
    }
  }

  return [
    { x: a.x + t0 * dx, y: a.y + t0 * dy },
    { x: a.x + t1 * dx, y: a.y + t1 * dy }
  ];
}

function clipRing(ring, rect) {
  let points = ring.length > 1 &&
    ring[0].x === ring[ring.length - 1].x &&
    ring[0].y === ring[ring.length - 1].y
      ? ring.slice(0, -1)
      : ring.slice();

  const edges = [
    {
      inside: p => p.x >= rect.minX,
      intersect: (a, b) => {
        const t = (rect.minX - a.x) / ((b.x - a.x) || 1e-9);
        return { x: rect.minX, y: a.y + (b.y - a.y) * t };
      }
    },
    {
      inside: p => p.x <= rect.maxX,
      intersect: (a, b) => {
        const t = (rect.maxX - a.x) / ((b.x - a.x) || 1e-9);
        return { x: rect.maxX, y: a.y + (b.y - a.y) * t };
      }
    },
    {
      inside: p => p.y >= rect.minY,
      intersect: (a, b) => {
        const t = (rect.minY - a.y) / ((b.y - a.y) || 1e-9);
        return { x: a.x + (b.x - a.x) * t, y: rect.minY };
      }
    },
    {
      inside: p => p.y <= rect.maxY,
      intersect: (a, b) => {
        const t = (rect.maxY - a.y) / ((b.y - a.y) || 1e-9);
        return { x: a.x + (b.x - a.x) * t, y: rect.maxY };
      }
    }
  ];

  for (const edge of edges) {
    if (!points.length) break;
    const input = points;
    points = [];
    let previous = input[input.length - 1];
    let previousInside = edge.inside(previous);
    for (const current of input) {
      const currentInside = edge.inside(current);
      if (currentInside) {
        if (!previousInside) points.push(edge.intersect(previous, current));
        points.push(current);
      } else if (previousInside) {
        points.push(edge.intersect(previous, current));
      }
      previous = current;
      previousInside = currentInside;
    }
  }
  return points;
}

function makeCollision(item, polygon, polygonIndex) {
  const bounds = polygonBounds(polygon[0]);
  return {
    key: `${item.feature.id || "building"}:${polygonIndex}`,
    rings: polygon,
    bounds: {
      minX: bounds.minX - 8,
      minY: bounds.minY - 8,
      maxX: bounds.maxX + 8,
      maxY: bounds.maxY + 8
    },
    name: item.feature.name || "",
    buildingType: (item.feature.building_type || "house").toLowerCase(),
    center: polygonCentroid(polygon[0])
  };
}

export default class WorldChunkManager {
  constructor(scene, mapData) {
    this.scene = scene;
    this.mapData = mapData;
    // Construções ficam temporariamente ocultas enquanto a arte residencial é refeita.
    // ?buildings=1 permite comparar a camada antiga sem alterar os dados do mapa.
    this.showBuildings = typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("buildings") === "1";
    this.chunkSize = mapData.chunkManifest.chunk_size_px || CHUNK_SIZE;
    this.marginChunks = 1;
    this.available = new Set(mapData.chunkManifest.chunks);
    this.loaded = new Map();
    this.lastWindow = "";
    this.chunkWindow = null;
    this.streaming = new ChunkStreamingManager({
      maxConcurrentLoads: 3,
      maxBuildsPerFrame: 1,
      reserveLimit: 16
    });
    this.buildQueue = [];
    this.buildBudgetMs = 6;
    this.maxBuildStepsPerFrame = 3;
    this.lodManager = new WorldLODManager();
    this.visibleKeys = new Set();
    this.prefetchKeys = new Set();
    this.streamTick = 0;
    this.lastCameraCenter = null;
    this.lastPriorityCenter = null;
    this.lastZoomBand = null;
    this.cameraDirection = { x: 0, y: 0, strength: 0 };
    this.buildingCollision = [];
    this.wallCollision = [];
    this.treeCollision = [];
    this.frontageRoads = (mapData.roads || []).map(road => ({
      feature: road,
      roadWidth: (road.width_m || 7) * PPM,
      lines: (road.lines || []).map(line => line.map(point => toWorld(point, PPM)))
        .filter(line => line.length > 1)
    })).filter(road => road.lines.length);
    this.lotFrontageCache = new Map();
    this.lotWallEligibility = new Map();
    this.lotWallGeometryCache = new Map();
    this.lotWallPlans = new Map();
    this.wallRoadSegments = buildRoadSegments(mapData.roadIndex || []);
  }

  get loadingCount() {
    return this.streaming.loadingCount;
  }

  get queuedCount() {
    return this.streaming.queuedCount;
  }

  get readyCount() {
    return this.streaming.readyCount;
  }

  key(cx, cy) {
    return `${cx}_${cy}`;
  }

  makeRect(cx, cy) {
    const x = cx * this.chunkSize;
    const y = cy * this.chunkSize;
    return {
      minX: x, minY: y,
      maxX: x + this.chunkSize, maxY: y + this.chunkSize
    };
  }

  addWorldObject(chunk, object, lodLayer = null) {
    if (!object) return object;
    chunk.objects.push(object);
    if (lodLayer) this.lodManager.register(chunk, lodLayer, object);
    this.scene.hudCamera?.ignore(object);
    return object;
  }

  normalizeRecord(raw) {
    const record = {
      blocks: [], lots: [], roads: [], buildings: [],
      trees: [], labels: [], collisions: [], roadItems: []
    };

    for (const type of ["blocks", "lots", "buildings"]) {
      for (const feature of raw[type] || []) {
        const polygons = getFeaturePolygons(feature, PPM);
        const bounds = boundsOfPolygons(polygons);
        if (!Number.isFinite(bounds.minX)) continue;
        const item = { feature, polygons, bounds };
        record[type].push(item);
        if (type === "buildings" && this.showBuildings) {
          polygons.forEach((polygon, index) => {
            if (polygon[0]?.length < 3) return;
            record.collisions.push(makeCollision(item, polygon, index));
          });
        }
      }
    }

    for (const road of raw.roads || []) {
      const lines = (road.lines || []).map(line => line.map(point => toWorld(point, PPM)))
        .filter(line => line.length > 1);
      if (!lines.length) continue;
      const item = {
        feature: road,
        lines,
        roadWidth: (road.width_m || 7) * PPM
      };
      record.roads.push(item);
      record.roadItems.push(item);
    }

    for (const tree of raw.trees || []) {
      const point = toWorld(tree.point, PPM);
      const seed = hash(tree.id);
      const radius = 10 + (seed % 5);
      record.trees.push({ feature: tree, point, radius, seed });
      record.collisions.push({
        key: `tree:${tree.id}`,
        x: point.x,
        y: point.y + 3,
        radius: 11
      });
    }

    record.labels = raw.labels || [];
    return record;
  }

  syncCollisionArrays() {
    const buildings = new Map();
    const walls = new Map();
    const trees = new Map();
    for (const chunk of this.loaded.values()) {
      for (const collision of chunk.record?.collisions || []) {
        if (collision.rings) buildings.set(collision.key, collision);
        else if (collision.segments) walls.set(collision.key, collision);
        else trees.set(collision.key, collision);
      }
    }
    this.buildingCollision.splice(
      0, this.buildingCollision.length, ...buildings.values()
    );
    this.wallCollision.splice(
      0, this.wallCollision.length, ...walls.values()
    );
    this.treeCollision.splice(
      0, this.treeCollision.length, ...trees.values()
    );
    this.scene.buildingCollision = this.buildingCollision;
    this.scene.wallCollision = this.wallCollision;
    this.scene.treeCollision = this.treeCollision;
  }
  async loadChunkData(chunk) {
    const controller = new AbortController();
    chunk.controller = controller;
    chunk.state = "loading";

    try {
      const response = await fetch(
        `${this.mapData.chunkBaseUrl}${chunk.key}.json?v=${this.mapData.chunkCacheKey || "map-v1"}`,
        { cache: "force-cache", signal: controller.signal }
      );
      if (!response.ok) {
        throw new Error(`Chunk ${chunk.key}: HTTP ${response.status}`);
      }
      const raw = await response.json();
      if (this.loaded.get(chunk.key) !== chunk || controller.signal.aborted) return;
      chunk.state = "ready";
      this.streaming.pushReady(chunk, raw);
    } catch (error) {
      if (error.name !== "AbortError") {
        chunk.state = "error";
        console.error("[AraÃ§atexas] Falha ao carregar chunk:", chunk.key, error);
      }
    } finally {
      this.streaming.completeLoad();
      if (chunk.controller === controller) chunk.controller = null;
    }
  }

  pumpLoadQueue() {
    while (this.streaming.canStartLoad) {
      const chunk = this.streaming.startNextLoad();
      if (!chunk) break;
      if (this.loaded.get(chunk.key) !== chunk || chunk.state !== "queued") {
        this.streaming.completeLoad();
        continue;
      }
      this.loadChunkData(chunk);
    }
  }

  processReadyChunks() {
    // Transfere respostas para uma fila que continua respeitando a prioridade atual.
    const ready = this.streaming.takeReady(this.streaming.readyCount);
    for (const entry of ready) {
      const { chunk, raw } = entry;
      if (this.loaded.get(chunk.key) !== chunk || chunk.state !== "ready") continue;
      chunk.state = "building";
      chunk.buildRaw = raw;
      chunk.buildStage = 0;
      this.buildQueue.push(chunk);
    }

    const startedAt = performance.now();
    let steps = 0;
    let collisionDataChanged = false;
    const stages = [
      chunk => { chunk.record = this.normalizeRecord(chunk.buildRaw); chunk.buildRect = this.makeRect(chunk.cx, chunk.cy); },
      chunk => this.drawBlocks(chunk, chunk.record, chunk.buildRect),
      chunk => this.drawLots(chunk, chunk.record, chunk.buildRect),
      chunk => this.drawRoads(chunk, chunk.record, chunk.buildRect),
      chunk => this.drawLotWalls(chunk, chunk.record, chunk.buildRect),
      chunk => this.drawLabels(chunk, chunk.record),
      chunk => this.drawBuildings(chunk, chunk.record, chunk.buildRect),
      chunk => this.drawTrees(chunk, chunk.record)
    ];

    while (this.buildQueue.length && steps < this.maxBuildStepsPerFrame &&
        (steps === 0 || performance.now() - startedAt < this.buildBudgetMs)) {
      this.buildQueue.sort((a, b) =>
        (a.priorityTier ?? 2) - (b.priorityTier ?? 2) ||
        (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER)
      );
      const chunk = this.buildQueue.shift();
      if (this.loaded.get(chunk.key) !== chunk || chunk.state !== "building") continue;
      try {
        stages[chunk.buildStage](chunk);
        chunk.buildStage++;
        steps++;
        if (chunk.buildStage >= stages.length) {
          chunk.state = "loaded";
          delete chunk.buildRaw;
          delete chunk.buildRect;
          delete chunk.buildStage;
          this.lodManager.applyChunk(chunk);
          collisionDataChanged = true;
        } else {
          this.buildQueue.push(chunk);
        }
      } catch (error) {
        chunk.state = "error";
        delete chunk.buildRaw;
        this.buildQueue = this.buildQueue.filter(item => item !== chunk);
        console.error("[Araçatexas] Falha ao montar chunk:", chunk.key, error);
      }
    }
    if (collisionDataChanged) this.syncCollisionArrays();
  }
  createChunk(cx, cy) {
    const key = this.key(cx, cy);
    const rect = this.makeRect(cx, cy);
    const chunk = {
      cx, cy, key, rect,
      objects: [],
      record: null,
      collisions: [],
      lodLayers: {},
      buildingsRendered: false,
      priority: Number.MAX_SAFE_INTEGER,
      lastUsedAt: this.streamTick,
      role: "prefetch",
      state: this.available.has(key) ? "queued" : "empty",
      controller: null
    };
    const groundKey = this.scene.v4Preview ? "v4-ground-grass" : "grass-ground-v2";
    const ground = this.scene.add.tileSprite(
      rect.minX, rect.minY,
      this.chunkSize + 1, this.chunkSize + 1,
      groundKey
    ).setOrigin(0).setDepth(-100);
    if (this.scene.v4Preview) ground.setTileScale(0.5, 0.5);
    this.addWorldObject(chunk, ground, "terrain");
    this.loaded.set(key, chunk);
    return chunk;
  }

  destroyChunk(chunk) {
    this.buildQueue = this.buildQueue.filter(item => item !== chunk);
    this.streaming.remove(chunk.key);
    chunk.controller?.abort();
    for (const object of chunk.objects) object.destroy();
    chunk.objects.length = 0;
    chunk.record = null;
    chunk.collisions = null;
    chunk.state = "unloaded";
    this.loaded.delete(chunk.key);
  }

  getChunkDistance(chunk, centerX, centerY) {
    const x = chunk.rect.minX + this.chunkSize / 2 - centerX;
    const y = chunk.rect.minY + this.chunkSize / 2 - centerY;
    return Math.hypot(x, y);
  }

  updateVisible(force = false) {
    const camera = this.scene.cameras.main;
    const view = camera.worldView;
    const player = this.scene.player;
    const viewWidth = camera.width / Math.max(0.1, camera.zoom);
    const viewHeight = camera.height / Math.max(0.1, camera.zoom);
    const viewBounds = view && view.width > 0 && view.height > 0
      ? { minX: view.x, minY: view.y, maxX: view.right, maxY: view.bottom }
      : {
          minX: (player?.x || 0) - viewWidth / 2,
          minY: (player?.y || 0) - viewHeight / 2,
          maxX: (player?.x || 0) + viewWidth / 2,
          maxY: (player?.y || 0) + viewHeight / 2
        };

    this.streamTick++;
    const centerX = (viewBounds.minX + viewBounds.maxX) / 2;
    const centerY = (viewBounds.minY + viewBounds.maxY) / 2;
    if (this.lastCameraCenter) {
      const dx = centerX - this.lastCameraCenter.x;
      const dy = centerY - this.lastCameraCenter.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0.5) {
        this.cameraDirection = {
          x: dx / distance,
          y: dy / distance,
          // Detecta também deslocamentos modestos por quadro (zoom alto ou FPS baixo).
          strength: Math.min(1, distance / 6)
        };
      } else {
        this.cameraDirection.strength *= 0.82;
      }
    }
    this.lastCameraCenter = { x: centerX, y: centerY };

    const visibleMinCx = Math.floor(viewBounds.minX / this.chunkSize);
    const visibleMinCy = Math.floor(viewBounds.minY / this.chunkSize);
    const visibleMaxCx = Math.floor(viewBounds.maxX / this.chunkSize);
    const visibleMaxCy = Math.floor(viewBounds.maxY / this.chunkSize);
    // Mantém uma faixa de segurança ao redor da tela em qualquer zoom.
    // Em zoom distante, a câmera percorre mais mundo por quadro e não pode ficar sem chunks na borda.
    const marginChunks = Math.max(1, this.marginChunks);
    const margin = this.chunkSize * marginChunks;
    let minCx = Math.floor((viewBounds.minX - margin) / this.chunkSize);
    let minCy = Math.floor((viewBounds.minY - margin) / this.chunkSize);
    let maxCx = Math.floor((viewBounds.maxX + margin) / this.chunkSize);
    let maxCy = Math.floor((viewBounds.maxY + margin) / this.chunkSize);

    // Acrescenta uma faixa de pré-carregamento à frente do movimento recente.
    if (this.cameraDirection.strength > 0.15) {
      if (this.cameraDirection.x > 0.35) maxCx++;
      else if (this.cameraDirection.x < -0.35) minCx--;
      if (this.cameraDirection.y > 0.35) maxCy++;
      else if (this.cameraDirection.y < -0.35) minCy--;
    }
    const signature = `${minCx}:${minCy}:${maxCx}:${maxCy}`;
    const zoomBand = camera.zoom < 0.30 ? 0 : camera.zoom < 0.55 ? 1 : 2;
    const priorityTravel = this.lastPriorityCenter
      ? Math.hypot(centerX - this.lastPriorityCenter.x, centerY - this.lastPriorityCenter.y)
      : Infinity;
    const shouldReschedule = force || signature !== this.lastWindow ||
      zoomBand !== this.lastZoomBand || priorityTravel >= this.chunkSize * 0.2;

    // Em quadros parados, só processa respostas e mantém a fila andando.
    // A busca, ordenação e política de retenção rodam quando a janela muda,
    // o zoom cruza uma faixa ou a câmera percorre distância relevante.
    if (!shouldReschedule) {
      this.lodManager.update(camera.zoom, this.loaded.values());
      this.processReadyChunks();
      this.pumpLoadQueue();
      return;
    }

    this.lastWindow = signature;
    this.lastPriorityCenter = { x: centerX, y: centerY };
    this.lastZoomBand = zoomBand;
    this.chunkWindow = { minCx, minCy, maxCx, maxCy };

    const visible = new Set();
    const active = new Set();
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = this.key(cx, cy);
        const isVisible = cx >= visibleMinCx && cx <= visibleMaxCx &&
          cy >= visibleMinCy && cy <= visibleMaxCy;
        active.add(key);
        if (isVisible) visible.add(key);

        let chunk = this.loaded.get(key);
        if (!chunk) chunk = this.createChunk(cx, cy);
        chunk.lastUsedAt = this.streamTick;

        const distance = this.getChunkDistance(chunk, centerX, centerY);
        const offsetX = chunk.rect.minX + this.chunkSize / 2 - centerX;
        const offsetY = chunk.rect.minY + this.chunkSize / 2 - centerY;
        const forward = offsetX * this.cameraDirection.x + offsetY * this.cameraDirection.y;
        const isAhead = !isVisible &&
          this.cameraDirection.strength > 0.15 &&
          forward > this.chunkSize * 0.15;

        // Prioridade em três níveis, sem misturar distância com importância:
        // 0 = já está na tela; 1 = pré-carregamento à frente; 2 = restante.
        chunk.role = isVisible ? "visible" : isAhead ? "ahead" : "prefetch";
        chunk.priorityTier = isVisible ? 0 : isAhead ? 1 : 2;
        const directionalBias = isAhead
          ? Math.max(0, forward) * 0.35 * this.cameraDirection.strength
          : 0;
        chunk.priority = Math.max(0, distance - directionalBias);

        if (chunk.state === "queued") {
          this.streaming.enqueue(chunk, chunk.priority, chunk.priorityTier);
        } else {
          this.streaming.reprioritize(key, chunk.priority, chunk.priorityTier);
        }
      }
    }

    this.visibleKeys = visible;
    this.prefetchKeys = active;

    // Retain only the closest already-built chunks outside the active window.
    // Pending/in-flight chunks outside the window are cancelled instead of wasting bandwidth.
    const outside = [...this.loaded.values()].filter(chunk =>
      !active.has(chunk.key)
    );
    const retainable = outside.filter(chunk =>
      chunk.state === "loaded" || chunk.state === "ready"
    );
    retainable.sort((a, b) => {
      const distance = this.getChunkDistance(a, centerX, centerY) -
        this.getChunkDistance(b, centerX, centerY);
      return distance || b.lastUsedAt - a.lastUsedAt;
    });
    const reserveLimit = camera.zoom < 0.30 ? 4
      : camera.zoom < 0.55 ? 8
      : camera.zoom < 0.85 ? 12
      : this.streaming.config.reserveLimit;
    const reserve = new Set(retainable
      .slice(0, reserveLimit)
      .map(chunk => chunk.key));

    let evicted = false;
    for (const chunk of outside) {
      if (!reserve.has(chunk.key)) {
        this.destroyChunk(chunk);
        evicted = true;
      } else {
        chunk.role = "reserve";
        chunk.priorityTier = 3;
        chunk.priority = this.getChunkDistance(chunk, centerX, centerY);
      }
    }
    if (evicted) this.syncCollisionArrays();

    this.lodManager.update(camera.zoom, this.loaded.values());
    this.processReadyChunks();
    this.pumpLoadQueue();
  }

  getCollisionCandidates(x, y, radius = 12) {
    const minCx = Math.floor((x - radius) / this.chunkSize);
    const minCy = Math.floor((y - radius) / this.chunkSize);
    const maxCx = Math.floor((x + radius) / this.chunkSize);
    const maxCy = Math.floor((y + radius) / this.chunkSize);
    const found = new Map();

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const chunk = this.loaded.get(this.key(cx, cy));
        if (!chunk?.record) continue;
        for (const item of chunk.record.collisions) {
          if (!found.has(item.key)) found.set(item.key, item);
        }
      }
    }
    return new Set(found.values());
  }

  getNearbyRoads(x, y, radius = 120) {
    const minCx = Math.floor((x - radius) / this.chunkSize);
    const minCy = Math.floor((y - radius) / this.chunkSize);
    const maxCx = Math.floor((x + radius) / this.chunkSize);
    const maxCy = Math.floor((y + radius) / this.chunkSize);
    const found = new Map();

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const chunk = this.loaded.get(this.key(cx, cy));
        if (!chunk?.record) continue;
        for (const road of chunk.record.roadItems) {
          const id = road.feature.id;
          if (!found.has(id)) {
            found.set(id, {
              feature: road.feature,
              roadWidth: road.roadWidth,
              lines: []
            });
          }
          found.get(id).lines.push(...road.lines);
        }
      }
    }
    return [...found.values()];
  }
  drawClippedRing(graphics, ring, rect) {
    for (let i = 0; i < ring.length; i++) {
      const segment = clipSegment(ring[i], ring[(i + 1) % ring.length], rect);
      if (!segment) continue;
      graphics.beginPath();
      graphics.moveTo(segment[0].x, segment[0].y);
      graphics.lineTo(segment[1].x, segment[1].y);
      graphics.strokePath();
    }
  }

  findLotForBuilding(center, record) {
    const matches = [];
    for (const item of record.lots) {
      for (const polygon of item.polygons) {
        const outer = polygon[0];
        if (!outer || outer.length < 3 || !pointInRing(center, outer)) continue;
        matches.push({ item, polygon, outer });
      }
    }
    matches.sort((a, b) =>
      Number(a.item.feature.area_m2 || Infinity) -
      Number(b.item.feature.area_m2 || Infinity)
    );
    return matches[0] || null;
  }

  findLotFrontageEdge(outer, center, record, roadSource = null) {
    let best = null;
    const source = roadSource || record.roads || [];
    // A frontage must border a street that actually receives a sidewalk.
    // Footways, service drives and access paths are not parcel street fronts.
    const roads = source.filter(road => this.getSidewalkWidthMeters(road) > 0);

    for (let i = 0; i < outer.length; i++) {
      const a = outer[i];
      const b = outer[(i + 1) % outer.length];
      const length = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
      if (length < 2) continue;
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

      for (const road of roads) {
        for (const line of road.lines || []) {
          for (let j = 0; j < line.length - 1; j++) {
            const nearest = closestPointOnSegment(midpoint, line[j], line[j + 1]);
            if (!best || nearest.distance < best.distance) {
              best = {
                a, b, midpoint, length, distance: nearest.distance,
                index: i, road
              };
            }
          }
        }
      }
    }

    // Quando a rua nÃ£o estÃ¡ no chunk atual, assume-se a menor lateral do lote.
    if (!best || best.distance > 18 * PPM) {
      let shortest = Infinity;
      for (let i = 0; i < outer.length; i++) {
        const a = outer[i];
        const b = outer[(i + 1) % outer.length];
        const length = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
        if (length < 2) continue;
        if (length < shortest) {
          shortest = length;
          best = {
            a, b,
            midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            length,
            distance: Infinity,
            index: i,
            road: null
          };
        }
      }
    }

    if (!best) return null;
    let rotation = Math.atan2(best.b.y - best.a.y, best.b.x - best.a.x);
    const outward = {
      x: best.midpoint.x - center.x,
      y: best.midpoint.y - center.y
    };
    const outwardLength = Math.hypot(outward.x, outward.y);
    if (outwardLength < 1) return null;

    const imageBottom = { x: -Math.sin(rotation), y: Math.cos(rotation) };
    if (imageBottom.x * outward.x + imageBottom.y * outward.y < 0) {
      rotation += Math.PI;
    }

    return {
      ...best,
      rotation,
      outward: { x: -Math.sin(rotation), y: Math.cos(rotation) }
    };
  }

  findLotFrontage(outer, center, record) {
    return this.findLotFrontageEdge(outer, center, record)?.rotation ?? NaN;
  }

  offsetLotRingFromSidewalk(outer) {
    const parcelCenter = polygonCentroid([...outer, outer[0]]);
    const edgeInfo = outer.map((a, index) => {
      const b = outer[(index + 1) % outer.length];
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 1) return { a, b, offset: 0, omit: false };

      // The normal is always directed toward the parcel interior.
      let nx = -dy / length;
      let ny = dx / length;
      const towardCenter = {
        x: parcelCenter.x - midpoint.x,
        y: parcelCenter.y - midpoint.y
      };
      if (nx * towardCenter.x + ny * towardCenter.y < 0) {
        nx *= -1;
        ny *= -1;
      }

      let nearestStreet = null;
      for (const road of this.frontageRoads) {
        const sidewalkMeters = this.getSidewalkWidthMeters(road);
        if (sidewalkMeters <= 0) continue;
        for (const line of road.lines || []) {
          for (let i = 0; i < line.length - 1; i++) {
            const nearest = closestPointOnSegment(midpoint, line[i], line[i + 1]);
            if (!nearestStreet || nearest.distance < nearestStreet.distance) {
              const roadWidth = road.roadWidth || (road.feature?.width_m || 7) * PPM;
              const sidewalkWidth = sidewalkMeters * PPM;
              nearestStreet = {
                distance: nearest.distance,
                // Reserve sidewalk clearance plus half the wall thickness.
                // The outer face can then sit outside the centerline without entering the pavement.
                requiredClearance: roadWidth / 2 + sidewalkWidth + 9,
                sidewalkWidth
              };
            }
          }
        }
      }

      let offset = 0;
      let omit = false;
      if (nearestStreet &&
          nearestStreet.distance < nearestStreet.requiredClearance) {
        const desiredOffset =
          nearestStreet.requiredClearance - nearestStreet.distance + 2;
        const previousLength = Phaser.Math.Distance.Between(
          outer[(index - 1 + outer.length) % outer.length].x,
          outer[(index - 1 + outer.length) % outer.length].y,
          a.x, a.y
        );
        const nextLength = Phaser.Math.Distance.Between(
          b.x, b.y,
          outer[(index + 2) % outer.length].x,
          outer[(index + 2) % outer.length].y
        );
        const safeInset = Math.min(previousLength, nextLength) * 0.42;

        // When there is not enough parcel depth to clear the pavement safely,
        // omit this street-facing wall rather than drawing it on the sidewalk.
        if (desiredOffset > safeInset) {
          omit = true;
        } else {
          offset = desiredOffset;
        }
      }

      return {
        a, b,
        offset,
        omit,
        shiftedA: { x: a.x + nx * offset, y: a.y + ny * offset },
        shiftedB: { x: b.x + nx * offset, y: b.y + ny * offset }
      };
    });

    const intersectLines = (lineA, lineB, fallback) => {
      const p = lineA.shiftedA;
      const r = {
        x: lineA.shiftedB.x - lineA.shiftedA.x,
        y: lineA.shiftedB.y - lineA.shiftedA.y
      };
      const q = lineB.shiftedA;
      const s = {
        x: lineB.shiftedB.x - lineB.shiftedA.x,
        y: lineB.shiftedB.y - lineB.shiftedA.y
      };
      const cross = r.x * s.y - r.y * s.x;
      if (Math.abs(cross) < 1e-6) return fallback;
      const qmp = { x: q.x - p.x, y: q.y - p.y };
      const t = (qmp.x * s.y - qmp.y * s.x) / cross;
      const point = { x: p.x + r.x * t, y: p.y + r.y * t };
      const maxMiter = Math.max(lineA.offset, lineB.offset, 2) * 3.2;
      return Phaser.Math.Distance.Between(point.x, point.y, fallback.x, fallback.y) <= maxMiter
        ? point
        : fallback;
    };

    const shiftedRing = outer.map((point, index) => {
      const previous = edgeInfo[(index - 1 + edgeInfo.length) % edgeInfo.length];
      const current = edgeInfo[index];
      return intersectLines(previous, current, point);
    });

    return {
      ring: shiftedRing,
      visibleEdges: edgeInfo.map(edge => !edge.omit)
    };
  }

  findAvenidaBrasiliaX(center, record) {
    let best = null;
    for (const road of record.roads || []) {
      const name = (road.feature?.name || "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      if (!name.includes("avenida brasilia")) continue;
      for (const line of road.lines || []) {
        for (let i = 0; i < line.length - 1; i++) {
          const nearest = closestPointOnSegment(center, line[i], line[i + 1]);
          if (!best || nearest.distance < best.distance) {
            best = { x: nearest.point.x, distance: nearest.distance };
          }
        }
      }
    }
    // Avenue BrasÃ­lia runs close to x=-200 m in the map's local EPSG:32722
    // frame. The exact local road geometry wins whenever this chunk contains it.
    return best && best.distance < 180 * PPM ? best.x : -200 * PPM;
  }

  drawResidentialProperty(chunk, buildingCenter, record, rect, seed) {
    // Only the chunk containing the building center owns the full property
    // sprite. This avoids duplicate images where adjacent chunks overlap.
    if (buildingCenter.x < rect.minX || buildingCenter.x >= rect.maxX ||
        buildingCenter.y < rect.minY || buildingCenter.y >= rect.maxY) return true;

    const lot = this.findLotForBuilding(buildingCenter, record);
    if (!lot) return false;

    const lotCenter = polygonCentroid(lot.outer);
    const rotation = this.findLotFrontage(lot.outer, lotCenter, record);
    if (!Number.isFinite(rotation)) return false;

    const ux = { x: Math.cos(rotation), y: Math.sin(rotation) };
    const uy = { x: -Math.sin(rotation), y: Math.cos(rotation) };
    let minU = Infinity, maxU = -Infinity;
    let minV = Infinity, maxV = -Infinity;
    for (const point of lot.outer) {
      const dx = point.x - lotCenter.x;
      const dy = point.y - lotCenter.y;
      const u = dx * ux.x + dy * ux.y;
      const v = dx * uy.x + dy * uy.y;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }

    const parcelWidth = maxU - minU;
    const parcelDepth = maxV - minV;
    const parcelArea = Number(lot.item.feature.area_m2 ||
      (parcelWidth * parcelDepth) / (PPM * PPM));
    if (parcelWidth < 6 * PPM || parcelDepth < 7 * PPM ||
        parcelWidth > 240 * PPM || parcelDepth > 120 * PPM ||
        parcelArea < 55 || parcelArea > 15000) return false;

    // Long frontage parcels are rows of several homes, not one gigantic house.
    // Split those frontages into natural-sized properties instead of stretching
    // one composition across an entire block.
    const repeatCount = parcelWidth > 55 * PPM &&
      parcelWidth / Math.max(1, parcelDepth) > 1.8
      ? Math.min(16, Math.max(2, Math.ceil(parcelWidth / (19 * PPM))))
      : 1;
    const houseWidth = parcelWidth / repeatCount;
    const aspect = houseWidth / Math.max(1, parcelDepth);
    const avenueX = this.findAvenidaBrasiliaX(lotCenter, record);
    const modernSide = lotCenter.x < avenueX;
    const textureKeys = [];

    for (let i = 0; i < repeatCount; i++) {
      let textureKey;
      if (modernSide) {
        if (aspect < 0.58) {
          textureKey = (seed + i) % 2
            ? "property-modern-long-pool-v2"
            : "property-modern-narrow-flat-v2";
        } else if (aspect < 0.82) {
          textureKey = "property-modern-narrow-flat-v2";
        } else if (parcelArea >= 330 && repeatCount === 1) {
          textureKey = (seed + i) % 2
            ? "property-modern-pool-dark-v2"
            : "property-modern-pool-light-v2";
        } else {
          textureKey = (seed + i) % 2
            ? "property-modern-gray-v2"
            : "property-modern-compact-v2";
        }
      } else {
        textureKey = "property-traditional-red-v2";
      }
      if (!this.scene.textures.exists(textureKey)) return false;
      textureKeys.push(textureKey);
    }

    const maskGraphics = this.scene.add.graphics();
    maskGraphics.fillStyle(0xffffff, 1);
    maskGraphics.fillPoints(
      lot.outer.map(point => new Phaser.Geom.Point(point.x, point.y)), true, true
    );
    maskGraphics.setVisible(false);
    const geometryMask = maskGraphics.createGeometryMask();
    const centerV = (minV + maxV) / 2;

    for (let i = 0; i < repeatCount; i++) {
      const centerU = minU + (i + 0.5) * houseWidth;
      const x = lotCenter.x + ux.x * centerU + uy.x * centerV;
      const y = lotCenter.y + ux.y * centerU + uy.y * centerV;
      const property = this.scene.add.image(x, y, textureKeys[i])
        .setOrigin(0.5, 0.5)
        .setRotation(rotation)
        .setDisplaySize(houseWidth * 0.96, parcelDepth * 0.96)
        .setDepth(31)
        .setMask(geometryMask);
      property.setFlipX(((seed + i) & 1) === 1);
      this.addWorldObject(chunk, property, "properties");
    }

    this.addWorldObject(chunk, maskGraphics);
    return true;
  }

  drawV4PreviewRoof(chunk, outer, center, rect, seed, type) {
    const bounds = polygonBounds(outer);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    if (longSide < 1 || shortSide < 1) return;

    let angle = 0;
    let longest = 0;
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i], b = outer[(i + 1) % outer.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length > longest) { longest = length; angle = Math.atan2(dy, dx); }
    }

    let textureKey = "v4-roof-ceramic";
    if (type === "industrial") textureKey = "v4-roof-metal";
    else if (type === "commercial") textureKey = seed % 2 ? "v4-roof-metal" : "v4-surface-concrete";
    else if (type === "apartment") textureKey = seed % 2 ? "v4-surface-pavers" : "v4-surface-concrete";
    else if (type === "house" && seed % 5 === 0) textureKey = "v4-roof-metal";
    if (!this.scene.textures.exists(textureKey)) return;

    const maskGraphics = this.scene.add.graphics();
    maskGraphics.fillStyle(0xffffff, 1);
    maskGraphics.fillPoints(outer.map(point => new Phaser.Geom.Point(point.x, point.y)), true, true);
    maskGraphics.setVisible(false);
    const geometryMask = maskGraphics.createGeometryMask();
    // A forma simples fica por baixo da textura e continua visível nos LODs distantes.
    const silhouette = this.scene.add.graphics().setDepth(31);
    silhouette.fillStyle(palette.roof[seed % palette.roof.length], 1);
    silhouette.fillPoints(outer.map(point => new Phaser.Geom.Point(point.x, point.y)), true, true);
    const roof = this.scene.add.tileSprite(center.x, center.y, longSide, shortSide, textureKey)
      .setOrigin(0.5, 0.5).setRotation(angle).setDepth(31).setMask(geometryMask);
    roof.setTileScale(0.5, 0.5);
    this.addWorldObject(chunk, silhouette);
    const outline = this.scene.add.graphics().setDepth(32);
    outline.lineStyle(2, 0x342f2b, 0.92);
    this.drawClippedRing(outline, outer, rect);
    this.addWorldObject(chunk, maskGraphics);
    this.addWorldObject(chunk, roof, "roofDetails");
    this.addWorldObject(chunk, outline);
  }

  drawTexturedHouseFallback(chunk, outer, center, bounds, rect, seed) {
    const longSide = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    const shortSide = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    if (longSide < 1 || shortSide < 1) return;

    let angle = 0;
    let longest = 0;
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i], b = outer[(i + 1) % outer.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length > longest) {
        longest = length;
        angle = Math.atan2(dy, dx);
      }
    }

    const textureKey = seed % 2
      ? "roof-terracotta-orange-v2"
      : "roof-terracotta-shadow-v2";
    if (!this.scene.textures.exists(textureKey)) return;

    const maskGraphics = this.scene.add.graphics();
    maskGraphics.fillStyle(0xffffff, 1);
    maskGraphics.fillPoints(
      outer.map(point => new Phaser.Geom.Point(point.x, point.y)), true, true
    );
    maskGraphics.setVisible(false);
    const geometryMask = maskGraphics.createGeometryMask();
    const silhouette = this.scene.add.graphics().setDepth(31);
    silhouette.fillStyle(palette.roof[seed % palette.roof.length], 1);
    silhouette.fillPoints(outer.map(point => new Phaser.Geom.Point(point.x, point.y)), true, true);
    const roof = this.scene.add.tileSprite(
      center.x, center.y, longSide, shortSide, textureKey
    ).setOrigin(0.5, 0.5).setRotation(angle).setDepth(31).setMask(geometryMask);
    this.addWorldObject(chunk, silhouette);

    const outline = this.scene.add.graphics().setDepth(32);
    outline.lineStyle(2, 0x342f2b, 0.9);
    this.drawClippedRing(outline, outer, rect);
    this.addWorldObject(chunk, maskGraphics);
    this.addWorldObject(chunk, roof, "roofDetails");
    this.addWorldObject(chunk, outline);
  }

  drawBlocks(chunk, record, rect) {
    if (!record.blocks.length) return;
    const g = this.addWorldObject(chunk, this.scene.add.graphics().setDepth(-30));
    for (const item of record.blocks) {
      for (const polygon of item.polygons) {
        const outer = polygon[0];
        if (!outer || outer.length < 3) continue;
        const clipped = clipRing(outer, rect);
        if (clipped.length < 3) continue;
        g.fillStyle(item.feature.zone === "mixed" ? 0x9c956d : 0x87956a, 0.35);
        g.fillPoints(clipped.map(p => new Phaser.Geom.Point(p.x, p.y)), true, true);
        g.lineStyle(2, 0x526b48, 0.26);
        this.drawClippedRing(g, outer, rect);
      }
    }
  }

  drawLots(chunk, record, rect) {
    if (!record.lots.length) return;
    const g = this.addWorldObject(chunk, this.scene.add.graphics().setDepth(-20));
    for (const item of record.lots) {
      const seed = hash(item.feature.id);
      const base = palette.lot[seed % palette.lot.length];
      for (const polygon of item.polygons) {
        const outer = polygon[0];
        if (!outer || outer.length < 3) continue;
        const clipped = clipRing(outer, rect);
        if (clipped.length < 3) continue;
        g.fillStyle(base, 0.46);
        g.fillPoints(clipped.map(p => new Phaser.Geom.Point(p.x, p.y)), true, true);
        g.lineStyle(1, 0x9eaa68, 0.32);
        this.drawClippedRing(g, outer, rect);
        const center = polygonCentroid(outer);
        if (seed % 4 === 0 && center.x >= rect.minX && center.x <= rect.maxX &&
            center.y >= rect.minY && center.y <= rect.maxY) {
          g.fillStyle(0xa2ae68, 0.25);
          g.fillRect(center.x - 2, center.y - 2, 4, 4);
        }
      }
    }
  }

  // Plano de muro do lote (geometria pura em lotWalls.js), calculado uma vez por lote.
  getLotWallPlan(item, polygonIndex) {
    const lotId = item.feature?.id ?? "lote";
    const key = `${lotId}:${polygonIndex}`;
    if (this.lotWallPlans.has(key)) return this.lotWallPlans.get(key);
    let plan = null;
    const polygon = item.polygons[polygonIndex];
    // Só lotes simples (sem buracos) recebem muro.
    if (polygon && polygon.length === 1 && polygon[0].length >= 4) {
      const result = planLotWall(polygon[0], {
        roadSegs: this.wallRoadSegments,
        seed: hash(lotId),
        blockSeed: hash(item.feature?.block_id ?? item.feature?.block ?? "")
      });
      if (result.ok) plan = result;
    }
    this.lotWallPlans.set(key, plan);
    return plan;
  }

  // Muros dos lotes: prisma 2D (face externa, topo e face interna) montado a
  // partir do PERÍMETRO do lote, recuado para depois da calçada. Nada é girado.
  drawLotWalls(chunk, record, rect) {
    if (!this.scene.v4Preview || !record.lots.length || !this.wallRoadSegments.length) return;

    const faces = [], tops = [], pillars = [], segments = [], debug = [];
    for (const item of record.lots) {
      for (let polygonIndex = 0; polygonIndex < item.polygons.length; polygonIndex++) {
        const plan = this.getLotWallPlan(item, polygonIndex);
        if (!plan) continue;
        // O chunk que contém o primeiro vértice do lote desenha o muro inteiro.
        // Assim o topo, que sobe na tela, nunca é cortado na divisa de chunks.
        if (Math.floor(plan.anchor.x / this.chunkSize) !== chunk.cx ||
            Math.floor(plan.anchor.y / this.chunkSize) !== chunk.cy) continue;
        faces.push(...plan.faces);
        tops.push(...plan.tops);
        pillars.push(...plan.pillars);
        segments.push(...plan.collisions);
        debug.push(plan.rings);
      }
    }
    if (!faces.length && !tops.length && !pillars.length) return;

    if (segments.length) {
      const points = segments.flatMap(segment => [segment.a, segment.b]);
      const padding = 12;
      record.collisions.push({
        key: `walls:${chunk.key}`,
        segments,
        thickness: WALL_CFG.thickness + 4,
        bounds: {
          minX: Math.min(...points.map(point => point.x)) - padding,
          minY: Math.min(...points.map(point => point.y)) - padding,
          maxX: Math.max(...points.map(point => point.x)) + padding,
          maxY: Math.max(...points.map(point => point.y)) + padding
        }
      });
    }

    const wallFaces = this.addWorldObject(chunk, this.scene.add.graphics().setDepth(33));
    const wallTops = this.addWorldObject(chunk, this.scene.add.graphics().setDepth(34));
    const wallPillars = this.addWorldObject(chunk, this.scene.add.graphics().setDepth(35));
    const H = WALL_CFG.height;
    const lerpPoint = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const fillPoly = (graphics, color, points) => {
      graphics.fillStyle(color, 1);
      graphics.fillPoints(points, true);
    };

    // Face: faixa de rodapé, corpo de reboco e sombra sob o topo, entre dois pontos do chão.
    faces.sort((a, b) => a.sortY - b.sortY);
    for (const face of faces) {
      const { p0, p1, pal, shade } = face;
      const strips = [
        [0, 1, pal.outline],
        [1, 5, mixColor(pal.base, shade)],
        [5, H - 3, mixColor(pal.face, shade)],
        [H - 3, H - 1, mixColor(pal.faceShadow, shade)],
        [H - 1, H, mixColor(pal.capShade, shade)]
      ];
      for (const [s0, s1, color] of strips) {
        fillPoly(wallFaces, color, [
          { x: p0.x, y: p0.y - s0 }, { x: p1.x, y: p1.y - s0 },
          { x: p1.x, y: p1.y - s1 }, { x: p0.x, y: p0.y - s1 }
        ]);
      }
    }

    // Topo: mostra a espessura do muro (contorno, brilho, capa e sombra).
    tops.sort((a, b) => a.sortY - b.sortY);
    for (const top of tops) {
      const [a, b, c, d] = top.pts;
      const { pal } = top;
      const bands = [
        [0, 0.25, pal.outline], [0.25, 0.5, pal.capHi],
        [0.5, 0.85, pal.cap], [0.85, 1, pal.capShade]
      ];
      for (const [f0, f1, color] of bands) {
        fillPoly(wallTops, color, [
          lerpPoint(a, d, f0), lerpPoint(b, c, f0), lerpPoint(b, c, f1), lerpPoint(a, d, f1)
        ]);
      }
    }

    // Pilares nos cantos e nas pontas de portões/aberturas (sempre alinhados à tela).
    pillars.sort((a, b) => a.sortY - b.sortY);
    const pillarHeight = H + WALL_CFG.pillarExtra;
    for (const pillar of pillars) {
      const { pal } = pillar;
      const x0 = Math.round(pillar.x - WALL_CFG.pillarHalf);
      const bottom = Math.round(pillar.y + WALL_CFG.pillarHalf);
      const top = bottom - pillarHeight;
      wallPillars.fillStyle(pal.outline, 1).fillRect(x0, top, 7, pillarHeight);
      wallPillars.fillStyle(pal.pillar, 1).fillRect(x0 + 1, top, 5, pillarHeight - 1);
      wallPillars.fillStyle(pal.base, 1).fillRect(x0 + 1, bottom - 5, 5, 4);
      wallPillars.fillStyle(pal.outline, 1).fillRect(x0, top - 7, 7, 7);
      wallPillars.fillStyle(pal.cap, 1).fillRect(x0 + 1, top - 6, 5, 5);
      wallPillars.fillStyle(pal.capHi, 1).fillRect(x0 + 1, top - 6, 5, 1);
    }

    // Depuração: ?wallsdebug=1 mostra o lote (ciano) e o eixo do muro (magenta).
    if (typeof window !== "undefined" && /[?&]wallsdebug=1/.test(window.location.search)) {
      const overlay = this.addWorldObject(chunk, this.scene.add.graphics().setDepth(60));
      for (const rings of debug) {
        overlay.lineStyle(1, 0x00ffff, 0.9).strokePoints(rings.lot, true, true);
        overlay.lineStyle(1, 0xff00ff, 0.9).strokePoints(rings.center, true, true);
      }
    }
  }

  drawRoadStroke(graphics, line, rect, width, color, alpha) {
    graphics.lineStyle(width, color, alpha);
    for (let i = 0; i < line.length - 1; i++) {
      const segment = clipSegment(line[i], line[i + 1], rect);
      if (!segment) continue;
      graphics.beginPath();
      graphics.moveTo(segment[0].x, segment[0].y);
      graphics.lineTo(segment[1].x, segment[1].y);
      graphics.strokePath();
    }
  }

  getSidewalkWidthMeters(road) {
    const highway = String(road?.feature?.highway || "").toLowerCase();
    const name = String(road?.feature?.name || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

    // A Avenida BrasÃ­lia Ã© a referÃªncia de maior largura do projeto.
    // A geometria sÃ³ recebe essa regra quando a via estÃ¡ identificada pelo nome.
    if (name.includes("avenida brasilia")) return 6.0;

    // Vias de acesso, caminhos e faixas exclusivas nÃ£o recebem calÃ§ada automÃ¡tica.
    if (["service", "services", "footway", "path", "busway",
      "cycleway", "steps", "pedestrian", "track", "motorway",
      "motorway_link", "trunk", "trunk_link"].includes(highway)) {
      return 0;
    }

    if (highway === "primary") return 4.0;
    if (highway === "primary_link") return 3.0;
    if (highway === "secondary") return 3.2;
    if (highway === "secondary_link") return 2.6;
    if (highway === "tertiary" || highway === "tertiary_link") return 2.5;
    if (highway === "residential" || highway === "unclassified") return 1.8;
    return 0;
  }

  drawRoads(chunk, record, rect) {
    if (!record.roads.length) return;

    const roadside = [];
    for (const item of record.roads) {
      const width = (item.feature.width_m || 7) * PPM;
      const sidewalkMeters = this.getSidewalkWidthMeters(item);
      if (sidewalkMeters <= 0) continue;
      roadside.push({
        item,
        width,
        sidewalkWidth: sidewalkMeters * PPM,
        totalWidth: width + sidewalkMeters * PPM * 2
      });
    }

    if (roadside.length && this.scene.v4Preview) {
      // Na prÃ©via V4, cada trecho da rua recebe sua prÃ³pria faixa texturizada.
      // As pontas se sobrepÃµem um pouco para evitar falhas entre segmentos e chunks.
      const textureKey = "v4-surface-sidewalk";
      if (this.scene.textures.exists(textureKey)) {
        for (const entry of roadside) {
          const expandedRect = {
            minX: rect.minX - 8,
            minY: rect.minY - 8,
            maxX: rect.maxX + 8,
            maxY: rect.maxY + 8
          };
          for (const line of entry.item.lines) {
            for (let i = 0; i < line.length - 1; i++) {
              const segment = clipSegment(line[i], line[i + 1], expandedRect);
              if (!segment) continue;
              const [a, b] = segment;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const length = Math.hypot(dx, dy);
              if (length < 1) continue;
              const sidewalkTexture = this.scene.add.tileSprite(
                (a.x + b.x) / 2,
                (a.y + b.y) / 2,
                length + 16,
                entry.totalWidth,
                textureKey
              ).setOrigin(0.5).setRotation(Math.atan2(dy, dx)).setDepth(-2);
              sidewalkTexture.setTileScale(0.5, 0.5);
              this.addWorldObject(chunk, sidewalkTexture);
            }
          }
        }
      }
    } else if (roadside.length) {
      // O modo normal mantÃ©m a mÃ¡scara e as texturas da biblioteca V2.
      const maskGraphics = this.scene.add.graphics().setDepth(-3);
      for (const entry of roadside) {
        maskGraphics.lineStyle(entry.totalWidth, 0xffffff, 1);
        for (const line of entry.item.lines) {
          if (line.length < 2) continue;
          maskGraphics.beginPath();
          maskGraphics.moveTo(line[0].x, line[0].y);
          for (let i = 1; i < line.length; i++) {
            maskGraphics.lineTo(line[i].x, line[i].y);
          }
          maskGraphics.strokePath();
        }
      }
      maskGraphics.setVisible(false);
      const sidewalkMask = maskGraphics.createGeometryMask();
      this.addWorldObject(chunk, maskGraphics);

      const textureKey = "roof-pavers-v2";
      if (this.scene.textures.exists(textureKey)) {
        const sidewalkTexture = this.scene.add.tileSprite(
          rect.minX, rect.minY,
          this.chunkSize + 1, this.chunkSize + 1,
          textureKey
        ).setOrigin(0).setDepth(-2).setMask(sidewalkMask);
        sidewalkTexture.setTileScale(1, 1);
        sidewalkTexture.setTilePosition(rect.minX, rect.minY);
        this.addWorldObject(chunk, sidewalkTexture);
      }
    }

    // A borda externa fica atrÃ¡s da textura; antes ela era desenhada por cima
    // da calÃ§ada e escondia completamente o material tileÃ¡vel.
    const curb = this.addWorldObject(chunk, this.scene.add.graphics().setDepth(-3));
    for (const item of record.roads) {
      const sidewalkMeters = this.getSidewalkWidthMeters(item);
      if (sidewalkMeters <= 0) continue;
      const width = (item.feature.width_m || 7) * PPM;
      const totalWidth = width + sidewalkMeters * PPM * 2;
      const roadRect = {
        minX: rect.minX - totalWidth / 2 - 12,
        minY: rect.minY - totalWidth / 2 - 12,
        maxX: rect.maxX + totalWidth / 2 + 12,
        maxY: rect.maxY + totalWidth / 2 + 12
      };
      for (const line of item.lines) {
        this.drawRoadStroke(curb, line, roadRect,
          totalWidth + 5, 0x62685f, 0.98);
      }
    }

    // O asfalto Ã© desenhado acima da textura da calÃ§ada, inclusive nos cruzamentos.
    const g = this.addWorldObject(chunk, this.scene.add.graphics().setDepth(0));
    for (const item of record.roads) {
      const width = (item.feature.width_m || 7) * PPM;
      const sidewalkMeters = this.getSidewalkWidthMeters(item);
      const totalWidth = width + sidewalkMeters * PPM * 2;
      const roadRect = {
        minX: rect.minX - totalWidth / 2 - 12,
        minY: rect.minY - totalWidth / 2 - 12,
        maxX: rect.maxX + totalWidth / 2 + 12,
        maxY: rect.maxY + totalWidth / 2 + 12
      };

      for (const line of item.lines) {
        this.drawRoadStroke(g, line, roadRect, width + 9, 0x8c977e, 0.92);
        this.drawRoadStroke(g, line, roadRect, width + 3, 0x39423e, 1);
        this.drawRoadStroke(g, line, roadRect, width, 0x515753, 1);

        if (["primary", "secondary", "tertiary"].includes(item.feature.highway)) {
          g.lineStyle(2, 0xc9bd8c, 0.42);
          for (let i = 0; i < line.length - 1; i++) {
            const a = line[i], b = line[i + 1];
            const length = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
            const count = Math.floor(length / 42);
            for (let n = 1; n < count; n += 2) {
              const t = n / count;
              const x = Phaser.Math.Linear(a.x, b.x, t);
              const y = Phaser.Math.Linear(a.y, b.y, t);
              if (x < roadRect.minX || x > roadRect.maxX ||
                  y < roadRect.minY || y > roadRect.maxY) continue;
              g.fillStyle(0xd8cda5, 0.50);
              g.fillRect(x - 3, y - 1, 6, 2);
            }
          }
        }
      }
    }
  }

  drawBuildings(chunk, record, rect) {
    chunk.buildingsRendered = false;
    if (!this.showBuildings || !record.buildings.length) return;
    chunk.buildingsRendered = true;
    const g = this.addWorldObject(chunk, this.scene.add.graphics().setDepth(30));
    let roofOutlineGraphics = null;
    for (const item of record.buildings) {
      const type = (item.feature.building_type || "house").toLowerCase();
      const commercial = /commercial|retail|shop|office/.test(type);
      const industrial = /industrial|warehouse|factory/.test(type);
      const colors = commercial ? palette.commercial :
        industrial ? palette.industrial : palette.roof;
      const shade = colors[hash(item.feature.id) % colors.length];

      for (const polygon of item.polygons) {
        const outer = polygon[0];
        if (!outer || outer.length < 3) continue;
        const b = polygonBounds(outer);
        const center = polygonCentroid(outer);
        const seed = hash(item.feature.id);
        const isHouse = [
          "house", "residential", "detached", "semidetached_house",
          "terrace", "bungalow"
        ].includes(type) || /residential/.test(type);

        if (isHouse) {
          // Retain a cheap footprint so LOD 3 can hide the complete property sprite
          // without making the building disappear from the distant city view.
          const footprint = clipRing(outer, rect);
          if (footprint.length >= 3) {
            g.fillStyle(shade, 1);
            g.fillPoints(footprint.map(point => new Phaser.Geom.Point(point.x, point.y)), true, true);
            g.lineStyle(1.5, 0x342f2b, 0.82);
            this.drawClippedRing(g, outer, rect);
          }
          if (this.scene.v4Preview) {
            this.drawV4PreviewRoof(chunk, outer, center, rect, seed, "house");
            continue;
          }
          const handled = this.drawResidentialProperty(
            chunk, center, record, rect, seed
          );
          if (!handled) {
            this.drawTexturedHouseFallback(
              chunk, outer, center, b, rect, seed
            );
          }
          continue;
        }

        // Build a roof material only for ordinary footprints whose proportions
        // are close enough to the source assets. A polygon geometry mask keeps
        // the repeated tile inside the real building outline.
        const width = b.maxX - b.minX;
        const height = b.maxY - b.minY;
        const longSide = Math.max(width, height);
        const shortSide = Math.min(width, height);
        const aspect = longSide / Math.max(1, shortSide);
        const areaM2 = Number(item.feature.area_m2 || 0);
        const isApartment = type === "apartment" || type === "apartments";
        const isCommercial = /commercial|retail|shop|office/.test(type);
        const eligibleFootprint =
          areaM2 >= 55 && areaM2 <= 650 &&
          shortSide >= 7 * PPM && longSide <= 60 * PPM &&
          aspect <= 2.5;
        const eligibleLargeCommercial =
          isCommercial && areaM2 > 650 && areaM2 <= 15000 &&
          shortSide >= 18 * PPM && longSide <= 180 * PPM &&
          aspect <= 2.5;
        let roofTexture = null;

        if (eligibleFootprint || eligibleLargeCommercial) {
          if (this.scene.v4Preview) {
            if (industrial) roofTexture = "v4-roof-metal";
            else if (isCommercial) {
              roofTexture = eligibleLargeCommercial
                ? "v4-surface-concrete"
                : seed % 2 ? "v4-roof-metal" : "v4-surface-concrete";
            } else if (isApartment) roofTexture = seed % 2 ? "v4-surface-pavers" : "v4-surface-concrete";
          } else {
            if (isHouse && seed % 5 !== 0) {
              roofTexture = seed % 2 === 0
                ? "roof-terracotta-orange-v2"
                : "roof-terracotta-shadow-v2";
            } else if (isCommercial && eligibleLargeCommercial) {
              roofTexture = "roof-corrugated-gray-v2";
            } else if (isCommercial && seed % 3 !== 0) {
              roofTexture = seed % 2 === 0
                ? "roof-corrugated-gray-v2"
                : "roof-corrugated-red-v2";
            } else if (isApartment && seed % 3 !== 0) {
              roofTexture = "roof-pavers-v2";
            }
          }
        }

        let longestAngle = 0;
        let longestEdge = 0;
        for (let i = 0; i < outer.length; i++) {
          const a = outer[i];
          const c = outer[(i + 1) % outer.length];
          const dx = c.x - a.x;
          const dy = c.y - a.y;
          const edgeLength = Math.hypot(dx, dy);
          if (edgeLength > longestEdge) {
            longestEdge = edgeLength;
            longestAngle = Math.atan2(dy, dx);
          }
        }
        const rotation = longestAngle;

        const shadow = clipRing(outer.map(p => ({ x: p.x + 5, y: p.y + 6 })), rect);
        const base = clipRing(outer.map(p => ({ x: p.x + 1, y: p.y + 2 })), rect);
        const roof = clipRing(outer, rect);

        if (shadow.length >= 3) {
          g.fillStyle(0x18231c, 0.38);
          g.fillPoints(shadow.map(p => new Phaser.Geom.Point(p.x, p.y)), true, true);
        }
        if (base.length >= 3) {
          g.fillStyle(0x4c5148, 1);
          g.fillPoints(base.map(p => new Phaser.Geom.Point(p.x, p.y)), true, true);
        }
        if (roof.length >= 3) {
          const ownsTexturedRoof = roofTexture &&
            center.x >= rect.minX && center.x < rect.maxX &&
            center.y >= rect.minY && center.y < rect.maxY;

          if (ownsTexturedRoof) {
            const maskGraphics = this.scene.add.graphics();
            maskGraphics.fillStyle(0xffffff, 1);
            maskGraphics.fillPoints(
              outer.map(p => new Phaser.Geom.Point(p.x, p.y)), true, true
            );
            maskGraphics.setVisible(false);
            const geometryMask = maskGraphics.createGeometryMask();

            const roofFill = this.scene.add.tileSprite(
              center.x, center.y, longSide, shortSide, roofTexture
            ).setOrigin(0.5, 0.5).setRotation(rotation).setDepth(31);
            roofFill.setMask(geometryMask);
            if (this.scene.v4Preview) roofFill.setTileScale(0.5, 0.5);

            this.addWorldObject(chunk, maskGraphics);
            this.addWorldObject(chunk, roofFill, "roofDetails");

            if (!roofOutlineGraphics) {
              roofOutlineGraphics = this.addWorldObject(
                chunk, this.scene.add.graphics().setDepth(32)
              );
            }
            roofOutlineGraphics.lineStyle(2, 0x342f2b, 0.95);
            this.drawClippedRing(roofOutlineGraphics, outer, rect);
            roofOutlineGraphics.lineStyle(1, 0xe0b88a, 0.55);
            this.drawClippedRing(
              roofOutlineGraphics, outer.map(p => ({ x: p.x - 1, y: p.y - 1 })), rect
            );
          } else {
            // Other chunks keep a plain clipped roof base. The owning chunk
            // draws the single textured roof over the complete footprint.
            g.fillStyle(shade, 1);
            g.fillPoints(roof.map(p => new Phaser.Geom.Point(p.x, p.y)), true, true);
            g.lineStyle(2, 0x342f2b, 0.95);
            this.drawClippedRing(g, outer, rect);
            g.lineStyle(1, 0xe0b88a, 0.58);
            this.drawClippedRing(g, outer.map(p => ({ x: p.x - 1, y: p.y - 1 })), rect);
          }
        }

        if (!roofTexture) {
          const spacing = Math.max(9, Math.min(18, Math.floor((b.maxY - b.minY) / 3)));
          const firstY = Math.max(b.minY + spacing, rect.minY);
          const lastY = Math.min(b.maxY - 2, rect.maxY);
          for (let y = firstY; y < lastY; y += spacing) {
            const intersections = [];
            for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
              const a = outer[j], c = outer[i];
              if ((a.y > y) !== (c.y > y)) {
                intersections.push(a.x + (c.x - a.x) * (y - a.y) / (c.y - a.y));
              }
            }
            intersections.sort((a, c) => a - c);
            g.lineStyle(1, commercial ? 0xc4d1ca : 0x3e302d, 0.27);
            for (let i = 0; i + 1 < intersections.length; i += 2) {
              const left = Math.max(intersections[i] + 2, rect.minX);
              const right = Math.min(intersections[i + 1] - 2, rect.maxX);
              if (right <= left) continue;
              g.beginPath();
              g.moveTo(left, y);
              g.lineTo(right, y);
              g.strokePath();
            }
          }

          if (center.x >= rect.minX && center.x <= rect.maxX &&
              center.y >= rect.minY && center.y <= rect.maxY) {
            const w = Math.max(3, Math.min(9, (b.maxX - b.minX) * 0.18));
            const h = Math.max(2, Math.min(5, (b.maxY - b.minY) * 0.12));
            g.fillStyle(commercial ? 0xb4c6bb : 0xd9ad7b, 0.72);
            g.fillRect(center.x - w / 2, center.y - h / 2, w, h);
          }
        }
      }
    }
  }

  drawTrees(chunk, record) {
    if (!record.trees.length) return;
    const g = this.addWorldObject(chunk, this.scene.add.graphics().setDepth(45), "foliage");
    for (const item of record.trees) {
      const p = item.point;
      const radius = item.radius;
      const seed = item.seed;
      g.fillStyle(0x1d2d21, 0.48);
      g.fillEllipse(p.x + 3, p.y + 7, radius * 2.3, radius * 1.25);
      g.fillStyle(0x654a30, 1);
      g.fillRect(p.x - 2, p.y + 2, 4, 12);
      g.fillStyle(seed % 2 ? 0x315d38 : 0x386c3e, 1);
      g.fillCircle(p.x, p.y - 4, radius);
      g.fillStyle(0x60904e, 0.9);
      g.fillCircle(p.x - 4, p.y - 7, Math.max(4, radius * 0.55));
      g.fillStyle(0x87a65c, 0.68);
      g.fillRect(p.x - 4, p.y - 12, 4, 3);
    }
  }

  drawLabels(chunk, record) {
    for (const label of record.labels) {
      const object = this.scene.add.text(label.x, label.y, label.name, {
        fontFamily: "Trebuchet MS, sans-serif", fontSize: "10px",
        color: "#eee3ba", stroke: "#252e2a", strokeThickness: 3,
        backgroundColor: "#303b35a0", padding: { x: 3, y: 1 }
      }).setOrigin(0.5).setDepth(10).setAlpha(0.78);
      this.addWorldObject(chunk, object, "labels");
    }
  }
}
