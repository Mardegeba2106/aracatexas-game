// Testa a divisão de lotes passantes no lado dos muros: um muro por divisa, terrenos
// especiais sem muro automático e muros reconstruídos nos novos limites.
// Usa os dados reais e o WorldChunkManager REAL (Phaser substituído por um stub).
// Uso: node scripts/test_wall_ownership.mjs
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const STUB = `
export default {
  Geom: { Point: class { constructor(x, y) { this.x = x; this.y = y; } } },
  Math: {
    Clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
    Linear: (a, b, t) => a + (b - a) * t,
    Distance: { Between: (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1) }
  }
};`;
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === "phaser") return { url: "data:text/javascript," + ${JSON.stringify("PLACEHOLDER")}, shortCircuit: true };
  return next(spec, ctx);
}`.replace('"PLACEHOLDER"', JSON.stringify(encodeURIComponent(STUB)))));

const { default: WorldChunkManager } = await import("../src/scenes/WorldChunkManager.js");
const lw = await import("../src/scenes/lotWalls.js");
const own = await import("./compute_wall_ownership.mjs");
const { PPM, planLotWall, buildRoadSegments, skipIntervals, subtractIntervals } = lw;

let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.log("FALHOU:", m); } else console.log("ok:", m); };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "public", "data");
const read = p => JSON.parse(fs.readFileSync(path.join(dataDir, p), "utf8"));

// ===================================================== 1) intervalos
{
  const ca = { x: 0, y: 0 }, cb = { x: 160, y: 0 };
  const iv = skipIntervals(ca, cb, [{ a: { x: 32, y: 1 }, b: { x: 96, y: -1 } }]);
  ok(iv.length === 1 && Math.abs(iv[0][0] - 0.2) < 1e-6 && Math.abs(iv[0][1] - 0.6) < 1e-6, "skipIntervals: trecho sobre a aresta vira intervalo [0.2, 0.6]");
  ok(skipIntervals(ca, cb, [{ a: { x: 32, y: 20 }, b: { x: 96, y: 20 } }]).length === 0, "skipIntervals: segmento paralelo mas afastado é ignorado");
  ok(skipIntervals(ca, cb, [{ a: { x: 32, y: 0 }, b: { x: 32, y: 80 } }]).length === 0, "skipIntervals: segmento perpendicular é ignorado");
  const merged = skipIntervals(ca, cb, [{ a: { x: 0, y: 0 }, b: { x: 64, y: 0 } }, { a: { x: 60, y: 0 }, b: { x: 120, y: 0 } }]);
  ok(merged.length === 1 && merged[0][0] === 0 && Math.abs(merged[0][1] - 0.75) < 1e-6, "skipIntervals: trechos que se tocam são unidos");
  ok(skipIntervals(ca, cb, [{ a: { x: -500, y: 0 }, b: { x: 900, y: 0 } }])[0].join() === "0,1", "skipIntervals: limitado ao tamanho da aresta");
  const sub = subtractIntervals([[0, 1]], [[0.2, 0.4], [0.6, 0.8]]);
  ok(JSON.stringify(sub) === JSON.stringify([[0, 0.2], [0.4, 0.6], [0.8, 1]]), "subtractIntervals: remove miolos e mantém as pontas");
  ok(subtractIntervals([[0, 0.5], [0.6, 1]], [[0, 1]]).length === 0, "subtractIntervals: cobertura total não deixa nada");
}

// ===================================================== 2) plano com divisa cedida (lote sintético)
const roadIndex = read("roads-index.json");
const roadSegs = buildRoadSegments(roadIndex);
{
  // lote 20 m x 50 m bem longe de qualquer via (as ruas do mapa ficam a < 700 m do centro)
  const ox = 90000, oy = 90000;
  const ring = [[0, 0], [20, 0], [20, 50], [0, 50], [0, 0]].map(([x, y]) => ({ x: ox + x * PPM, y: oy + y * PPM }));
  const base = planLotWall(ring, { roadSegs, seed: 1, blockSeed: 1, skipSegs: [] });
  ok(base.ok, "lote sintético isolado gera muro");
  const edgesOf = plan => new Set(plan.collisions.map(c => c.piece.split(".")[0]));
  ok(edgesOf(base).size === 4, "sem cessão: as 4 arestas têm muro");
  // cede toda a lateral direita (x = 20)
  const right = { a: { x: ox + 20 * PPM, y: oy }, b: { x: ox + 20 * PPM, y: oy + 50 * PPM } };
  const skipped = planLotWall(ring, { roadSegs, seed: 1, blockSeed: 1, skipSegs: [right] });
  ok(skipped.ok && skipped.collisions.length === base.collisions.length - 1, "cessão de uma aresta inteira remove só esse trecho");
  const keep = new Set(skipped.collisions.map(c => c.piece));
  ok(base.collisions.filter(c => keep.has(c.piece)).every(c => {
    const s = skipped.collisions.find(x => x.piece === c.piece);
    return s.a.x === c.a.x && s.a.y === c.a.y && s.b.x === c.b.x && s.b.y === c.b.y;
  }), "os demais trechos ficam idênticos (mesmos IDs e coordenadas)");
  ok(skipped.tops.length === base.tops.length - 1 && skipped.faces.length <= base.faces.length, "topo e faces do trecho cedido também somem");
  // cessão parcial: metade da lateral
  const half = { a: { x: ox + 20 * PPM, y: oy }, b: { x: ox + 20 * PPM, y: oy + 25 * PPM } };
  const partial = planLotWall(ring, { roadSegs, seed: 1, blockSeed: 1, skipSegs: [half] });
  const sideBase = base.collisions.find(c => Math.abs(c.a.x - (ox + 20 * PPM)) < 2 && Math.abs(c.b.x - (ox + 20 * PPM)) < 2);
  const sidePart = partial.collisions.find(c => Math.abs(c.a.x - (ox + 20 * PPM)) < 2 && Math.abs(c.b.x - (ox + 20 * PPM)) < 2);
  const len = c => Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y);
  ok(sidePart && Math.abs(len(sidePart) - len(sideBase) / 2) < 3, "cessão parcial mantém só a metade restante da aresta");
  // segmento de outro lugar não interfere
  const far = { a: { x: ox + 100 * PPM, y: oy }, b: { x: ox + 100 * PPM, y: oy + 50 * PPM } };
  ok(planLotWall(ring, { roadSegs, seed: 1, blockSeed: 1, skipSegs: [far] }).collisions.length === base.collisions.length, "cessão que não coincide com nenhuma aresta é ignorada");
  const again = planLotWall(ring, { roadSegs, seed: 1, blockSeed: 1, skipSegs: [right] });
  ok(JSON.stringify(again.collisions) === JSON.stringify(skipped.collisions), "planejamento é determinístico");
}

// ===================================================== 3) dados reais
const map = read("map.json");
const report = read("lot-split-report.json");
const stored = read("wall-ownership.json");
const rings = own.loadLotRings(path.join(dataDir, "chunks"));
const { skips, plans } = own.computeWallOwnership(map.lots, rings, roadSegs);

ok(stored.source_map_hash === own.mapHash(), "wall-ownership.json pertence ao map.json atual");
ok(JSON.stringify(Object.fromEntries([...skips.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))) === JSON.stringify(stored.skips),
  "posse de divisas gravada é exatamente a recalculada (dados atualizados)");
ok(stored.lots_with_wall === plans.size, `lotes com muro: ${plans.size}`);

const specials = map.lots.filter(l => l.wall_policy === "none");
ok(specials.length === report.especial && specials.every(l => l.lot_kind === "special"), `lotes especiais = ${specials.length} (conferem com o relatório)`);
ok(specials.every(l => !plans.has(l.id)), "nenhum lote especial entra no cálculo de muros");

// sobreposição entre eixos de muros de lotes diferentes (mesma medida da simulação)
function overlapStats(planList) {
  const segs = [];
  for (const [id, plan] of planList) for (const c of plan.collisions) segs.push({ id, a: c.a, b: c.b });
  const CELL = 160, grid = new Map();
  segs.forEach((s, i) => {
    for (let gx = Math.floor(Math.min(s.a.x, s.b.x) / CELL); gx <= Math.floor(Math.max(s.a.x, s.b.x) / CELL); gx++)
      for (let gy = Math.floor(Math.min(s.a.y, s.b.y) / CELL); gy <= Math.floor(Math.max(s.a.y, s.b.y) / CELL); gy++) {
        const k = gx + "," + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
      }
  });
  const tol = 0.6 * PPM, cosMin = Math.cos(8 * Math.PI / 180);
  let total = 0, dup = 0; const detail = [];
  segs.forEach((s, i) => {
    const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y); total += L / PPM;
    const ux = (s.b.x - s.a.x) / L, uy = (s.b.y - s.a.y) / L;
    const seen = new Set();
    for (let gx = Math.floor((Math.min(s.a.x, s.b.x) - tol) / CELL); gx <= Math.floor((Math.max(s.a.x, s.b.x) + tol) / CELL); gx++)
      for (let gy = Math.floor((Math.min(s.a.y, s.b.y) - tol) / CELL); gy <= Math.floor((Math.max(s.a.y, s.b.y) + tol) / CELL); gy++)
        for (const j of grid.get(gx + "," + gy) || []) {
          if (j <= i || seen.has(j) || segs[j].id === s.id) continue; seen.add(j);
          const t = segs[j], tl = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y);
          if (Math.abs(((t.b.x - t.a.x) * ux + (t.b.y - t.a.y) * uy) / tl) < cosMin) continue;
          const d0 = (t.a.x - s.a.x) * uy - (t.a.y - s.a.y) * ux, d1 = (t.b.x - s.a.x) * uy - (t.b.y - s.a.y) * ux;
          let lo = 0, hi = 1; const dd = d1 - d0;
          if (Math.abs(dd) < 1e-9) { if (Math.abs(d0) > tol) continue; }
          else { const l1 = (-tol - d0) / dd, l2 = (tol - d0) / dd; lo = Math.max(lo, Math.min(l1, l2)); hi = Math.min(hi, Math.max(l1, l2)); if (lo >= hi) continue; }
          const q0 = ((t.a.x + (t.b.x - t.a.x) * lo - s.a.x) * ux + (t.a.y + (t.b.y - t.a.y) * lo - s.a.y) * uy);
          const q1 = ((t.a.x + (t.b.x - t.a.x) * hi - s.a.x) * ux + (t.a.y + (t.b.y - t.a.y) * hi - s.a.y) * uy);
          const c0 = Math.max(0, Math.min(q0, q1)), c1 = Math.min(L, Math.max(q0, q1));
          if (c1 > c0 + 1e-6) { dup += (c1 - c0) / PPM; detail.push([s.id, segs[j].id, (c1 - c0) / PPM, (s.a.x + s.b.x) / 2 / PPM, -(s.a.y + s.b.y) / 2 / PPM]); }
        }
  });
  return { total, dup, detail };
}
const before = overlapStats(plans);
ok(before.dup / before.total > 0.2, `sem a regra de divisa única há muita duplicidade (${(100 * before.dup / before.total).toFixed(1)}%): a medição enxerga o problema`);

const afterPlans = new Map();
for (const lot of map.lots) {
  if (!plans.has(lot.id)) continue;
  const skipSegs = (skips.get(lot.id) || []).map(([a, b]) => ({ a: { x: a[0] * PPM, y: -a[1] * PPM }, b: { x: b[0] * PPM, y: -b[1] * PPM } }));
  const ringPx = rings.get(`${lot.id}:0`)[0].map(([x, y]) => ({ x: x * PPM, y: -y * PPM }));
  const r = planLotWall(ringPx, { roadSegs, seed: own.hash(lot.id), blockSeed: own.hash(lot.block_id ?? ""), skipSegs });
  if (r.ok) afterPlans.set(lot.id, r);
}
const after = overlapStats(afterPlans);
if (process.env.DEBUG_OVERLAP) console.log(after.detail.sort((a, b) => b[2] - a[2]).slice(0, 12).map(d => d.map(v => typeof v === 'number' ? v.toFixed(2) : v).join(' | ')).join('\n'));
console.log(`   muro antes: ${before.total.toFixed(0)} m (duplicado ${before.dup.toFixed(0)} m) | depois: ${after.total.toFixed(0)} m (duplicado ${after.dup.toFixed(1)} m)`);
ok(afterPlans.size === plans.size, "todo lote com muro continua com plano depois de ceder divisas");
const worst = Math.max(0, ...after.detail.map(d => d[2]));
ok(worst < 1.5, `nenhum trecho de muro duplicado entre lotes (maior sobreposição ${worst.toFixed(2)} m, abaixo do trecho mínimo de 1,5 m)`);
ok(after.dup < after.total * 1e-4, `sobreposição residual desprezível: ${after.dup.toFixed(1)} m de ${after.total.toFixed(0)} m (<0,01%), só fragmentos de arredondamento`);
ok(after.total < before.total * 0.7, "o comprimento total de muro cai (divisas deixam de ser desenhadas duas vezes)");

// nenhum lote perde TODO o muro por ceder divisas
const wallless = [...afterPlans.entries()].filter(([, p]) => p.collisions.length === 0);
ok(wallless.length === 0, `nenhum lote fica sem nenhum muro por causa da cessão (${wallless.length})`);

// cada trecho cedido tem um dono com muro naquele lugar: o muro do vizinho de menor ID cobre a divisa
{
  let uncovered = 0, checked = 0;
  const segsByLot = new Map([...afterPlans.entries()].map(([id, p]) => [id, p.collisions]));
  const allSegs = [...segsByLot.entries()].flatMap(([id, list]) => list.map(c => ({ id, ...c })));
  for (const [id, list] of skips) {
    for (const [a, b] of list) {
      const mid = { x: (a[0] + b[0]) / 2 * PPM, y: -(a[1] + b[1]) / 2 * PPM };
      checked++;
      const near = allSegs.some(s => s.id !== id && Math.hypot(
        mid.x - Math.max(Math.min(s.a.x, s.b.x), Math.min(Math.max(s.a.x, s.b.x), mid.x)),
        mid.y - Math.max(Math.min(s.a.y, s.b.y), Math.min(Math.max(s.a.y, s.b.y), mid.y))) <= 0.7 * PPM);
      if (!near) uncovered++;
    }
  }
  ok(uncovered === 0, `toda divisa cedida continua coberta pelo muro do vizinho dono (${checked} trechos, ${uncovered} descobertos)`);
}

// os chunks carregam `wall_skip` idêntico à posse calculada
{
  let mismatches = 0, withSkip = 0;
  for (const file of fs.readdirSync(path.join(dataDir, "chunks"))) {
    const chunk = JSON.parse(fs.readFileSync(path.join(dataDir, "chunks", file), "utf8"));
    for (const lot of chunk.lots || []) {
      const want = skips.get(lot.id) || null;
      const got = lot.wall_skip || null;
      if (got) withSkip++;
      if (JSON.stringify(want) !== JSON.stringify(got)) mismatches++;
    }
  }
  ok(mismatches === 0 && withSkip > 0, `chunks carregam wall_skip igual à posse calculada (${withSkip} fragmentos, ${mismatches} divergências)`);
}

// ===================================================== 4) WorldChunkManager real
function fakeObject() {
  const o = { depth: 0, destroyed: false };
  const proxy = new Proxy(o, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === "destroy") return () => { t.destroyed = true; };
      if (p === "setDepth") return d => { t.depth = d; return proxy; };
      if (p === "createGeometryMask") return () => ({});
      return () => proxy;
    }
  });
  return proxy;
}
const scene = {
  v4Preview: true, textures: { exists: () => true }, hudCamera: { ignore() {} },
  add: { graphics: fakeObject, tileSprite: fakeObject, image: fakeObject, text: fakeObject, rectangle: fakeObject }
};
const manifest = read("world-manifest.json");
function makeManager() {
  const m = new WorldChunkManager(scene, { chunkManifest: manifest, roads: [], roadIndex });
  m.showBuildings = false; m.retainRaw = true; m.maxBuildStepsPerFrame = 100; m.buildBudgetMs = 1e9;
  return m;
}
function loadChunk(m, raw) {
  const chunk = m.createChunk(raw.cx, raw.cy);
  chunk.state = "building"; chunk.buildRaw = raw; chunk.buildStage = 0; m.buildQueue.push(chunk);
  for (let i = 0; i < 20 && chunk.state !== "loaded"; i++) m.processReadyChunks();
  return chunk;
}
const anchored = lot => (lot.source_polygons?.length || lot.full_polygon_indices?.length);
let specialChunk = null, skipChunk = null;
for (const file of fs.readdirSync(path.join(dataDir, "chunks"))) {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "chunks", file), "utf8"));
  const lots = (raw.lots || []).filter(anchored);
  if (!specialChunk && lots.some(l => l.wall_policy === "none")) specialChunk = raw;
  if (!skipChunk && lots.some(l => l.wall_skip?.length && plans.has(l.id))) skipChunk = raw;
  if (specialChunk && skipChunk) break;
}
ok(Boolean(specialChunk && skipChunk), "há chunks reais com lote especial e com divisa cedida para testar o jogo");
{
  const m = makeManager();
  const chunk = loadChunk(m, specialChunk);
  const item = chunk.record.lots.find(i => i.feature.wall_policy === "none" && anchored(i.feature));
  ok(item && m.getLotWallPlan(item, 0) === null, "WorldChunkManager: terreno especial não gera muro automático");
  ok(m.lotWallPlans.has(`${item.feature.id}:0`) && m.lotWallPlans.get(`${item.feature.id}:0`) === null, "…e fica registrado como 'sem muro' (o Inspector mostra 'não gerado')");
}
{
  const m = makeManager();
  const chunk = loadChunk(m, skipChunk);
  const item = chunk.record.lots.find(i => i.feature.wall_skip?.length && plans.has(i.feature.id) && anchored(i.feature));
  const plan = m.getLotWallPlan(item, 0);
  const full = plans.get(item.feature.id);
  ok(plan && plan.collisions.length < full.collisions.length + 1 && plan.collisions.length <= full.collisions.length,
    `WorldChunkManager: lote com divisa cedida tem menos trechos (${plan.collisions.length} de ${full.collisions.length})`);
  const wallColl = chunk.record.collisions.find(c => c.key === `walls:${chunk.key}`);
  ok(Boolean(wallColl) && wallColl.segments.length > 0, "WorldChunkManager: colisões do chunk usam o muro já sem a divisa cedida");
  ok(JSON.stringify(plan.collisions) === JSON.stringify(afterPlans.get(item.feature.id).collisions), "plano no jogo == plano usado no cálculo de posse (mesmo resultado)");
}

console.log(failed ? `\n${failed} TESTE(S) FALHARAM` : "\nTODOS OS TESTES PASSARAM");
process.exit(failed ? 1 : 0);
