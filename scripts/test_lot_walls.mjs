// Valida os muros de lote contra TODOS os lotes e ruas reais do mapa.
// Uso: node scripts/test_lot_walls.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PPM, WALL_CFG, buildRoadSegments, planLotWall, segDist, ringArea2
} from "../src/scenes/lotWalls.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "public", "data");
const roadIndex = JSON.parse(fs.readFileSync(path.join(dataDir, "roads-index.json"), "utf8"));
const segs = buildRoadSegments(roadIndex);

// Campo de verificação independente do módulo (mesma regra, código separado).
const hardSegs = segs.filter(s => !s.soft);
const softOnly = segs.filter(s => s.soft);
const makeFree = (bb) => {
  const near = hardSegs.filter(s => s.maxX >= bb.minX - 200 && s.minX <= bb.maxX + 200 &&
    s.maxY >= bb.minY - 200 && s.minY <= bb.maxY + 200);
  return (x, y) => {
    let best = Infinity;
    for (const s of near) best = Math.min(best, segDist(x, y, s.ax, s.ay, s.bx, s.by) - s.clear);
    return best;
  };
};

const hash = str => { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const toPx = ring => ring.map(p => ({ x: p[0] * PPM, y: -p[1] * PPM }));

const lots = new Map();
for (const f of fs.readdirSync(path.join(dataDir, "chunks"))) {
  if (!f.endsWith(".json")) continue;
  const d = JSON.parse(fs.readFileSync(path.join(dataDir, "chunks", f), "utf8"));
  for (const lot of d.lots || []) {
    lot.polygons.forEach((poly, k) => {
      if (poly.length !== 1) return;
      lots.set(`${lot.id}:${k}`, { lot, ring: toPx(poly[0]) });
    });
  }
}

const H = WALL_CFG.height + WALL_CFG.pillarExtra, hp = WALL_CFG.pillarHalf;
const reasons = {}, stats = { planned: 0, gate: 0, front: 0, insetPositive: 0, vio: 0, worst: Infinity, worstLot: null };
const insets = [];
let softWorst = Infinity;
let t0 = Date.now();

for (const [key, { lot, ring }] of lots) {
  const plan = planLotWall(ring, { roadSegs: segs, seed: hash(lot.id), blockSeed: hash(lot.block_id || "") });
  if (!plan.ok) { reasons[plan.reason] = (reasons[plan.reason] || 0) + 1; continue; }
  stats.planned++;
  if (plan.gate) stats.gate++;
  if (plan.frontIdx >= 0) stats.front++;
  if (plan.insetMax > 0.4) { stats.insetPositive++; insets.push(plan.insetMax); }

  const free = makeFree(plan.bbox);
  let lotWorst = Infinity;
  const check = (x, y) => { const v = free(x, y); if (v < lotWorst) lotWorst = v; };
  // eixo, borda externa e borda interna, no chão e com o topo deslocado para cima
  for (const rg of [plan.rings.center, plan.rings.outer, plan.rings.inner]) {
    for (let i = 0; i < rg.length; i++) {
      const a = rg[i], b = rg[(i + 1) % rg.length];
      const cnt = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
      for (let k = 0; k <= cnt; k++) {
        const x = a.x + (b.x - a.x) * k / cnt, y = a.y + (b.y - a.y) * k / cnt;
        check(x, y); check(x, y - WALL_CFG.height);
      }
    }
  }
  // pilares: os 4 cantos do quadrado, no chão e no topo
  for (const p of plan.pillars) {
    for (const dx of [-hp, hp]) for (const dy of [-hp, hp]) { check(p.x + dx, p.y + dy); check(p.x + dx, p.y + dy - H); }
  }
  // eixo de cada trecho de muro n?o pode ficar sobre via de servi?o
  for (const c of plan.collisions) {
    const cnt = Math.max(2, Math.ceil(Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y) / 2));
    for (let k = 0; k <= cnt; k++) {
      const x = c.a.x + (c.b.x - c.a.x) * k / cnt, y = c.a.y + (c.b.y - c.a.y) * k / cnt;
      for (const sg of softOnly) {
        if (x < sg.minX || x > sg.maxX || y < sg.minY || y > sg.maxY) continue;
        const v = segDist(x, y, sg.ax, sg.ay, sg.bx, sg.by) - sg.clear;
        if (v < softWorst) softWorst = v;
      }
    }
  }
  if (lotWorst < stats.worst) { stats.worst = lotWorst; stats.worstLot = key; }
  if (lotWorst < -0.001) stats.vio++;
}

insets.sort((a, b) => a - b);
const q = p => insets.length ? (insets[Math.floor(insets.length * p)] / PPM).toFixed(2) + " m" : "-";
console.log(`lotes (sem furos) lidos: ${lots.size}  tempo: ${Date.now() - t0} ms`);
console.log("planejados:", stats.planned, "| pulados:", JSON.stringify(reasons));
console.log(`com frente numa rua: ${stats.front} | com portão: ${stats.gate}`);
console.log(`recuo aplicado em ${stats.insetPositive} lotes; mediana ${q(0.5)}, p90 ${q(0.9)}, máx ${q(0.999)}`);
console.log(`VIOLAÇÕES (qualquer ponto do muro dentro de calçada/meio-fio/pista, no chão ou no topo): ${stats.vio}`);
console.log(`pior folga do eixo sobre via de servi?o: ${softWorst.toFixed(2)} px (>= -4.5 aceit?vel: pilar de 3,5 + 1)`);
console.log(`pior folga encontrada: ${stats.worst.toFixed(2)} px (lote ${stats.worstLot})`);
process.exit(stats.vio ? 1 : 0);
