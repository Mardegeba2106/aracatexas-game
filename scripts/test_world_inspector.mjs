// Testa o núcleo do World Inspector com os dados reais do mapa.
// Uso: node scripts/test_world_inspector.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFeaturePolygons, polygonBounds, pointInPolygon } from "../src/utils/geometry.js";
import { planLotWall, buildRoadSegments } from "../src/scenes/lotWalls.js";
import {
  PPM, screenToWorld, worldToScreen, worldToMeters, metersToWorld, distanceMeters,
  utmToLonLat, metersToLonLat, gridStepMeters, viewBounds, chunkCoordsAt, describeChunk,
  pickLot, pickBuilding, pickWall, pickRoad, pickObject, describeObject, featureProps
} from "../src/dev/inspectorCore.js";

let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log("FALHOU:", m); } else console.log("ok:", m); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = p => JSON.parse(fs.readFileSync(path.join(root, "public", "data", p), "utf8"));
const manifest = data("world-manifest.json");
const roadIndex = data("roads-index.json");

// ---- 1) câmera: tela <-> mundo
{
  const cam = { scrollX: 1234.5, scrollY: -987, zoom: 1.12, width: 1280, height: 720 };
  const w = screenToWorld(cam, 900, 200), s = worldToScreen(cam, w.x, w.y);
  ok(near(s.x, 900, 1e-9) && near(s.y, 200, 1e-9), "tela -> mundo -> tela volta ao mesmo pixel");
  const c = screenToWorld(cam, 640, 360);
  ok(near(c.x, cam.scrollX + 640) && near(c.y, cam.scrollY + 360), "o centro da tela é scroll + metade (independente do zoom)");
  for (const z of [0.2, 0.5, 2, 4]) {
    const k = { ...cam, zoom: z }, p = screenToWorld(k, 100, 50), b = viewBounds(k);
    ok(near(p.x, b.minX + 100 / z, 1e-6) && near(p.y, b.minY + 50 / z, 1e-6), `canto do enquadramento coerente com zoom ${z}`);
  }
}

// ---- 2) escala e conversão geográfica
{
  const m = worldToMeters({ x: 160, y: -320 });
  ok(m.x === 10 && m.y === 20, "160 px = 10 m a leste; y do mundo para baixo = norte (y=-320 -> 20 m)");
  const back = metersToWorld(m);
  ok(back.x === 160 && back.y === -320, "metros -> mundo faz o caminho de volta");
  const d = distanceMeters({ x: 0, y: 0 }, { x: 480, y: -640 });
  ok(near(d.meters, 50) && near(d.dx, 30) && near(d.dy, 40), "distância 30 m leste + 40 m norte = 50 m (3-4-5)");
  const o = metersToLonLat(manifest.meta, 0, 0);
  ok(near(o.lon, manifest.meta.origin_lonlat[0], 2e-6) && near(o.lat, manifest.meta.origin_lonlat[1], 2e-6),
    `origem UTM -> lon/lat bate com o manifesto (erro ${Math.abs(o.lon - manifest.meta.origin_lonlat[0]).toExponential(1)}°, ${Math.abs(o.lat - manifest.meta.origin_lonlat[1]).toExponential(1)}°)`);
  const n = metersToLonLat(manifest.meta, 0, 100), e = metersToLonLat(manifest.meta, 100, 0);
  ok(near((n.lat - o.lat) * 110600, 100, 1.5), "100 m ao norte ≈ +0,0009° de latitude");
  ok(near((e.lon - o.lon) * 111320 * Math.cos(o.lat * Math.PI / 180), 100, 1.5), "100 m a leste ≈ +0,00096° de longitude");
  ok(metersToLonLat({}, 0, 0) === null, "sem metadados geográficos: retorna null em vez de inventar");
}

// ---- 3) grade: nunca densa demais
{
  let worst = 0, minGap = Infinity;
  for (const z of [0.2, 0.3, 0.5, 1, 1.12, 2, 4]) {
    const step = gridStepMeters(z), gap = step * PPM * z, lines = 1280 / z / (step * PPM);
    minGap = Math.min(minGap, gap); worst = Math.max(worst, lines);
  }
  ok(minGap >= 48, `espaçamento mínimo na tela ${minGap.toFixed(0)} px (>= 48)`);
  ok(worst <= 30, `no máximo ${worst.toFixed(0)} linhas verticais em 1280 px (zoom afastado não fica denso)`);
  ok(gridStepMeters(4) < gridStepMeters(0.2), "passo cresce quando o zoom afasta");
}

// ---- 4) seleção com dados reais (mesmo formato do normalizeRecord)
function loadChunk(key) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, "public", "data", "chunks", `${key}.json`), "utf8"));
  const record = { blocks: [], lots: [], roads: [], buildings: [], trees: [], labels: [], collisions: [], roadItems: [] };
  const bounds = polys => {
    let b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const poly of polys) for (const p of poly[0]) { b.minX = Math.min(b.minX, p.x); b.minY = Math.min(b.minY, p.y); b.maxX = Math.max(b.maxX, p.x); b.maxY = Math.max(b.maxY, p.y); }
    return b;
  };
  for (const t of ["blocks", "lots", "buildings"]) for (const feature of raw[t] || []) {
    const polygons = getFeaturePolygons(feature, PPM); record[t].push({ feature, polygons, bounds: bounds(polygons) });
  }
  for (const road of raw.roads || []) {
    const lines = road.lines.map(l => l.map(p => ({ x: p[0] * PPM, y: -p[1] * PPM }))).filter(l => l.length > 1);
    if (lines.length) record.roads.push({ feature: road, lines, roadWidth: (road.width_m || 7) * PPM });
  }
  const [cx, cy] = key.split("_").map(Number);
  return { cx, cy, key, state: "ready", record };
}
const available = new Set(manifest.chunks);
const manager = {
  chunkSize: manifest.chunk_size_px, available, loaded: new Map(), loadingCount: 0,
  lotWallPlans: new Map(), scene: { buildingCollision: [] },
  getSidewalkWidthMeters: r => (r.feature.highway === "residential" ? 1.8 : 0)
};
const centerKey = "-2_-1";
for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
  const k = `${-2 + dx}_${-1 + dy}`; if (available.has(k)) manager.loaded.set(k, loadChunk(k));
}
const loadedBefore = [...manager.loaded.keys()].sort().join(",");
const c0 = manager.loaded.get(centerKey);
const shop = c0.record.buildings.find(b => b.feature.name?.includes("Shopping"));
const shopPt = (() => { const r = shop.polygons[0][0]; return { x: (Math.min(...r.map(p => p.x)) + Math.max(...r.map(p => p.x))) / 2, y: (Math.min(...r.map(p => p.y)) + Math.max(...r.map(p => p.y))) / 2 }; })();

{
  const hit = pickBuilding(manager, shopPt);
  ok(hit?.kind === "building" && hit.item.feature.name === "Araçatuba Shopping Center", "clique dentro do shopping seleciona a construção certa");
  const lines = describeObject(hit, manager), keys = lines.map(l => l[0]);
  ok(keys.includes("tipo") && keys.includes("id") && keys.includes("caixa") && keys.includes("chunk"), `descrição traz tipo, id, caixa e chunk (${keys.join(", ")})`);
  ok(lines.find(l => l[0] === "chunk")[1] === hit.chunkKey, "o chunk exibido é o chunk onde o objeto foi achado");
  ok(!lines.some(l => l[1] === undefined || l[1] === "" || l[1] === null), "nada vazio é exibido (propriedade ausente some)");
  ok(pickObject(manager, shopPt).kind === "building", "pickObject dá prioridade à construção sobre o lote");
  manager.showBuildings = false;
  ok(pickObject(manager, shopPt)?.kind !== "building",
    "com construções ocultas, o Inspector não seleciona edifícios invisíveis");
  manager.showBuildings = true;
}
{
  // lote: ponto central de um lote sem construção por cima
  let found = null;
  outer: for (const chunk of manager.loaded.values()) for (const lot of chunk.record.lots) {
    const r = lot.polygons[0][0]; const p = { x: r.reduce((s, q) => s + q.x, 0) / r.length, y: r.reduce((s, q) => s + q.y, 0) / r.length };
    if (manager.loaded.has(chunkCoordsAt(p.x, p.y, manager.chunkSize).key) && pointInPolygon(p, lot.polygons[0]) && !pickBuilding(manager, p) && !pickRoad(manager, p)) { found = { lot, p }; break outer; }
  }
  const hit = pickLot(manager, found.p);
  ok(hit?.kind === "lot" && hit.item.feature.id === found.lot.feature.id, "hover no centro de um lote devolve esse lote");
  const keys = describeObject(hit, manager).map(l => l[0]);
  ok(keys.includes("zona") && keys.includes("área") && keys.includes("vértices"), `lote mostra zona, área e vértices (${keys.join(", ")})`);
  ok(pickObject(manager, found.p).kind === "lot", "sem construção/muro/árvore/rua por cima, o clique cai no lote");
  ok(pickLot(manager, { x: found.p.x + 1e6, y: found.p.y }) === null, "ponto fora de qualquer chunk carregado não devolve nada");
}

// ---- 5) força bruta: contra TODOS os lotes dos chunks carregados
{
  const all = [...manager.loaded.values()].flatMap(c => c.record.lots);
  let checked = 0, bad = 0, hits = 0;
  for (const chunk of manager.loaded.values()) for (let i = 0; i < 400; i++) {
    const p = { x: (chunk.cx + Math.random()) * manager.chunkSize, y: (chunk.cy + Math.random()) * manager.chunkSize };
    const brute = new Set(all.filter(l => l.polygons.some(poly => pointInPolygon(p, poly))).map(l => l.feature.id));
    const got = pickLot(manager, p)?.item.feature.id;
    checked++; if (got) hits++;
    if (brute.size ? !brute.has(got) : got !== undefined) bad++;
  }
  ok(bad === 0 && hits > 0, `pickLot confere com a busca em força bruta (${checked} pontos, ${hits} acertos, ${bad} divergências)`);
}

// ---- 6) muro e rua
{
  const segs = buildRoadSegments(roadIndex);
  const lot = [...manager.loaded.values()].flatMap(c => c.record.lots).find(l => {
    const plan = planLotWall(l.polygons[0][0], { roadSegs: segs, seed: 1, blockSeed: 1 }); return plan.ok && plan.collisions.length > 1;
  });
  const plan = planLotWall(lot.polygons[0][0], { roadSegs: segs, seed: 1, blockSeed: 1 });
  manager.lotWallPlans.set(`${lot.feature.id}:0`, plan);
  const seg = plan.collisions[0], mid = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
  const hit = pickWall(manager, mid);
  ok(hit?.kind === "wall" && hit.lotKey === `${lot.feature.id}:0`, "clique sobre um trecho de muro seleciona o muro do lote certo");
  ok(describeObject(hit, manager).some(l => l[0] === "trecho"), "descrição do muro traz o comprimento do trecho");
  ok(pickWall(manager, { x: mid.x + 200, y: mid.y + 200 }) === null, "longe do muro não seleciona");
  const lotLines = describeObject(pickLot(manager, { x: lot.polygons[0][0].reduce((s, q) => s + q.x, 0) / lot.polygons[0][0].length, y: lot.polygons[0][0].reduce((s, q) => s + q.y, 0) / lot.polygons[0][0].length }) || { kind: "lot", item: lot, polygonIndex: 0, chunkKey: "x" }, manager);
  ok(lotLines.some(l => l[0] === "muro" && l[1].startsWith("sim")), "o lote informa que tem muro (lido do cache de planos do jogo)");

  const road = [...manager.loaded.values()].flatMap(c => c.record.roads)[0];
  const line = road.lines[0], rp = { x: (line[0].x + line[1].x) / 2, y: (line[0].y + line[1].y) / 2 };
  const rh = pickRoad(manager, rp);
  ok(rh && rh.item.feature.id === road.feature.id || rh?.kind === "road", "clique no eixo de uma rua seleciona uma rua");
  ok(describeObject(rh, manager).some(l => l[0] === "largura"), "descrição da rua traz a largura");
}

// ---- 7) chunks: informar sem forçar carga
{
  const unloaded = [...available].find(k => !manager.loaded.has(k));
  const [ux, uy] = unloaded.split("_").map(Number);
  const info = describeChunk(manager, ux, uy);
  ok(info.exists && !info.loaded && info.counts === null, `chunk existente e não carregado (${unloaded}): informa isso sem contagens`);
  ok([...manager.loaded.keys()].sort().join(",") === loadedBefore, "consultar chunks não carrega nenhum chunk novo");
  const loaded = describeChunk(manager, -2, -1);
  ok(loaded.loaded && loaded.counts.lotes === c0.record.lots.length && loaded.counts.construções === c0.record.buildings.length, "chunk carregado traz as contagens reais de lotes e construções");
  const ghost = describeChunk(manager, 9999, 9999);
  ok(!ghost.exists && !ghost.loaded, "chunk que nem existe no manifesto é marcado como inexistente");
  const cc = chunkCoordsAt(-1024.5, 511.9, 512);
  ok(cc.cx === -3 && cc.cy === 0 && cc.key === "-3_0", "chunk sob o cursor: -1024,5 / 511,9 -> -3_0");
}

// ---- 8) propriedades: só o que existe
{
  const p = featureProps({ id: "a", name: "", zone: "mixed", n: 3, x: null, poly: [1], ok: true });
  ok(p.length === 4 && !p.some(r => r[0] === "name" || r[0] === "x" || r[0] === "poly"), "propriedades vazias, nulas ou aninhadas não aparecem");
}

console.log(failed ? `\n${failed} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
process.exit(failed ? 1 : 0);
