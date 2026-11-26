#!/usr/bin/env node
// Garante UM muro por divisa compartilhada entre lotes.
//
// Para cada lote com muro automático, calcula o plano real (planLotWall, o mesmo do jogo)
// e, onde o muro coincide com o de um vizinho "dono", grava (em wall-ownership.json) o trecho que
// este lote deve ceder. O dono é o lote de menor ID entre os que realmente têm muro; assim
// um vizinho especial (sem muro) ou sem plano nunca deixa a divisa descoberta.
//
// Depende de split_map_chunks.py + build_road_index.py já terem rodado (lê os anéis dos
// chunks, exatamente como o jogo, e as vias de roads-index.json). Grava
// public/data/wall-ownership.json (amarrado ao hash do map.json); o split_map_chunks.py
// aplica esse arquivo, como `wall_skip`, aos lotes dos chunks, e só se o hash bater.
//
// Uso: node scripts/compute_wall_ownership.mjs [--check]
//   --check  não grava; sai com erro se wall-ownership.json estiver ausente/desatualizado.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PPM, buildRoadSegments, planLotWall } from "../src/scenes/lotWalls.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "public", "data");

export const OWNERSHIP_TOL_M = 0.6;      // distância máxima entre eixos para contar como a mesma divisa
export const OWNERSHIP_ANGLE_DEG = 8;    // paralelismo máximo
export const MIN_SKIP_M = 0.5;           // trechos cedidos menores que isso são ignorados

// Mesmo hash do WorldChunkManager (seed de cor/portão): precisa ser idêntico.
export const hash = value => {
  let h = 2166136261;
  const text = String(value);
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

const toMeters = p => [Math.round(p.x / PPM * 100) / 100, Math.round(-p.y / PPM * 100) / 100];

// Anéis completos dos lotes como o jogo os vê (source_polygons ou polígono inteiro no chunk).
export function loadLotRings(chunkDir) {
  const rings = new Map();
  for (const file of fs.readdirSync(chunkDir)) {
    if (!file.endsWith(".json")) continue;
    const chunk = JSON.parse(fs.readFileSync(path.join(chunkDir, file), "utf8"));
    for (const lot of chunk.lots || []) {
      for (const src of lot.source_polygons || []) rings.set(`${lot.id}:${src.index}`, src.rings);
      for (const index of lot.full_polygon_indices || []) {
        const local = lot.polygon_indices.indexOf(index);
        if (local >= 0) rings.set(`${lot.id}:${index}`, lot.polygons[local]);
      }
    }
  }
  return rings;
}

// lots: [{id, block_id, wall_policy}]; rings: Map("id:idx" -> polygon). Retorna { skips, plans }.
export function computeWallOwnership(lots, rings, roadSegs) {
  const plans = new Map();
  for (const lot of lots) {
    if (lot.wall_policy === "none") continue;
    const polygon = rings.get(`${lot.id}:0`);
    if (!polygon || polygon.length !== 1 || polygon[0].length < 4) continue;
    // O jogo converte metros -> pixels (y invertido) antes de planejar; aqui é igual.
    const ringPx = polygon[0].map(([x, y]) => ({ x: x * PPM, y: -y * PPM }));
    const result = planLotWall(ringPx, {
      roadSegs, seed: hash(lot.id), blockSeed: hash(lot.block_id ?? ""), skipSegs: []
    });
    if (result.ok) plans.set(lot.id, result);
  }

  // índice espacial dos eixos de muro (px)
  const ids = [...plans.keys()].sort();
  const rank = new Map(ids.map((id, i) => [id, i]));
  const CELL = 160;
  const grid = new Map();
  const segs = [];
  for (const id of ids) {
    for (const c of plans.get(id).collisions) {
      const seg = { id, rank: rank.get(id), a: c.a, b: c.b };
      segs.push(seg);
      const x0 = Math.floor(Math.min(c.a.x, c.b.x) / CELL), x1 = Math.floor(Math.max(c.a.x, c.b.x) / CELL);
      const y0 = Math.floor(Math.min(c.a.y, c.b.y) / CELL), y1 = Math.floor(Math.max(c.a.y, c.b.y) / CELL);
      for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
        const k = gx + "," + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(seg);
      }
    }
  }

  const tol = OWNERSHIP_TOL_M * PPM;
  const cosMin = Math.cos(OWNERSHIP_ANGLE_DEG * Math.PI / 180);
  const skips = new Map();
  for (const s of segs) {
    const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    if (len < 1e-6) continue;
    const ux = (s.b.x - s.a.x) / len, uy = (s.b.y - s.a.y) / len;
    const cand = new Set();
    const x0 = Math.floor((Math.min(s.a.x, s.b.x) - tol) / CELL), x1 = Math.floor((Math.max(s.a.x, s.b.x) + tol) / CELL);
    const y0 = Math.floor((Math.min(s.a.y, s.b.y) - tol) / CELL), y1 = Math.floor((Math.max(s.a.y, s.b.y) + tol) / CELL);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) for (const t of grid.get(gx + "," + gy) || []) cand.add(t);
    const covered = [];
    for (const t of cand) {
      if (t.rank >= s.rank) continue; // só cede para quem tem menor ID
      const tl = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y);
      if (tl < 1e-6) continue;
      if (Math.abs(((t.b.x - t.a.x) * ux + (t.b.y - t.a.y) * uy) / tl) < cosMin) continue;
      // distância perpendicular (com sinal) dos extremos de t à reta de s
      const d0 = (t.a.x - s.a.x) * uy - (t.a.y - s.a.y) * ux;
      const d1 = (t.b.x - s.a.x) * uy - (t.b.y - s.a.y) * ux;
      // faixa de t onde |d| <= tol
      let lo = 0, hi = 1;
      const dd = d1 - d0;
      if (Math.abs(dd) < 1e-9) { if (Math.abs(d0) > tol) continue; }
      else {
        const l1 = (-tol - d0) / dd, l2 = (tol - d0) / dd;
        lo = Math.max(lo, Math.min(l1, l2)); hi = Math.min(hi, Math.max(l1, l2));
        if (lo >= hi) continue;
      }
      const pa = { x: t.a.x + (t.b.x - t.a.x) * lo, y: t.a.y + (t.b.y - t.a.y) * lo };
      const pb = { x: t.a.x + (t.b.x - t.a.x) * hi, y: t.a.y + (t.b.y - t.a.y) * hi };
      const q0 = (pa.x - s.a.x) * ux + (pa.y - s.a.y) * uy;
      const q1 = (pb.x - s.a.x) * ux + (pb.y - s.a.y) * uy;
      const c0 = Math.max(0, Math.min(q0, q1)), c1 = Math.min(len, Math.max(q0, q1));
      if (c1 - c0 > 1e-6) covered.push([c0, c1]);
    }
    if (!covered.length) continue;
    covered.sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const iv of covered) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    for (const [c0, c1] of merged) {
      if ((c1 - c0) / PPM < MIN_SKIP_M) continue;
      const a = { x: s.a.x + ux * c0, y: s.a.y + uy * c0 };
      const b = { x: s.a.x + ux * c1, y: s.a.y + uy * c1 };
      if (!skips.has(s.id)) skips.set(s.id, []);
      skips.get(s.id).push([toMeters(a), toMeters(b)]);
    }
  }
  return { skips, plans };
}

export function loadWorld() {
  const map = JSON.parse(fs.readFileSync(path.join(DATA, "map.json"), "utf8"));
  const roadIndex = JSON.parse(fs.readFileSync(path.join(DATA, "roads-index.json"), "utf8"));
  return { map, roadSegs: buildRoadSegments(roadIndex), rings: loadLotRings(path.join(DATA, "chunks")) };
}

export const OWNERSHIP_FILE = path.join(DATA, "wall-ownership.json");

// Mesmo hash que split_map_chunks.py usa para identificar o map.json (sha256, 16 hex).
export const mapHash = () => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(DATA, "map.json"))).digest("hex").slice(0, 16);

function main() {
  const check = process.argv.includes("--check");
  const { map, roadSegs, rings } = loadWorld();
  const { skips, plans } = computeWallOwnership(map.lots, rings, roadSegs);
  const skipsObject = Object.fromEntries([...skips.entries()].sort(([x], [y]) => (x < y ? -1 : 1)));
  let skipM = 0;
  for (const list of skips.values()) for (const [a, b] of list) skipM += Math.hypot(b[0] - a[0], b[1] - a[1]);
  const payload = {
    version: 1,
    source_map_hash: mapHash(),
    tolerance_m: OWNERSHIP_TOL_M,
    lots_with_wall: plans.size,
    skips: skipsObject
  };
  console.log(`lotes com muro: ${plans.size} | lotes que cedem divisa: ${skips.size} | comprimento cedido: ${skipM.toFixed(0)} m`);
  if (check) {
    let stored = null;
    try { stored = JSON.parse(fs.readFileSync(OWNERSHIP_FILE, "utf8")); } catch { /* ausente */ }
    if (!stored || stored.source_map_hash !== payload.source_map_hash ||
        JSON.stringify(stored.skips) !== JSON.stringify(payload.skips)) {
      console.error("wall-ownership.json ausente ou desatualizado: rode npm run split:lots.");
      process.exit(1);
    }
    console.log("wall-ownership.json está atualizado.");
    return;
  }
  fs.writeFileSync(OWNERSHIP_FILE, JSON.stringify(payload), "utf8");
  console.log("Gravado: " + OWNERSHIP_FILE + ". Rode split_map_chunks.py e build_road_index.py para propagar aos chunks.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
