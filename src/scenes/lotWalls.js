// Muros de lote do Araçatexas.
// Geometria pura (sem Phaser) para poder ser testada em Node com os dados reais.
//
// Regras que este módulo garante:
//  1. O muro acompanha o PERÍMETRO DO LOTE (nunca o contorno da casa).
//  2. Nenhuma parte do muro (eixo, espessura, topo, pilar) entra na faixa
//     desenhada da rua + calçada + meio-fio. O recuo é calculado com a largura
//     real de cada rua (width_m / highway) vindos de roads-index.json.
//  3. Em projeção oblíqua o topo do muro sobe na tela. Por isso a folga também
//     é testada com o ponto deslocado para cima (altura do muro + pilar).
//  4. O muro é montado como prisma 2D (face externa, topo e face interna) a
//     partir do polígono. Nenhum sprite é girado ou esticado.

export const PPM = 16;

export const WALL_CFG = {
  thickness: 4,          // px: largura do topo do muro (≈ 0,25 m)
  height: 24,            // px: altura aparente do muro na tela
  pillarHalf: 3.5,       // px: meia-largura do pilar
  pillarExtra: 3,        // px: o pilar é um pouco mais alto que o muro
  // Folga mínima entre a borda DESENHADA da calçada e o eixo do muro.
  // 3,5 * raiz(2) = 4,95 (diagonal do pilar) + 0,7 de arredondamento + 0,55 de ar.
  clearance: 6.2,
  curbPx: 2.5,           // meio-fio desenhado além da calçada (largura + 5) / 2
  asphaltHaloPx: 4.5,    // contorno do asfalto em ruas sem calçada (largura + 9) / 2
  maxInsetRatio: 0.5,    // recuo máximo = 40% da profundidade do lote
  minAreaM2: 45,
  minWidthPx: 4.5 * PPM,   // largura minima util do terreno (faixas mais estreitas nao sao lotes de casa)
  minEdgePx: 24,         // arestas menores que ~1,5 m sao fundidas (invertem o recuo)
  maxAreaM2: 3500,
  maxVertices: 14,
  gateMinEdge: 90,       // px: só abre portão em frente com pelo menos ~5,6 m
  gateMin: 28,
  gateMax: 48,
  frontageReach: 14 * PPM
};

const OUTLINE = 0x2b1c15;

// Vias sem cal?ada que o OSM desenha atravessando lotes (vielas, acessos internos,
// caminhos). N?o empurram o muro: ele ? interrompido onde cruzaria o asfalto.
const SOFT_HIGHWAYS = ["service", "services", "footway", "path", "track", "cycleway", "steps", "pedestrian"];

// ---------------------------------------------------------------- utilidades
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const rnd = p => ({ x: Math.round(p.x), y: Math.round(p.y) });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-9 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export function ringArea2(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

function boundsOf(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function segmentsCross(p1, p2, p3, p4) {
  const d = (a, b, c) => (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function isSimple(ring) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return false;
    }
  }
  return true;
}

// ------------------------------------------------------------------- ruas
export function sidewalkMetersFor(road) {
  const highway = String(road?.highway || "").toLowerCase();
  const name = String(road?.name || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (name.includes("avenida brasilia")) return 6.0;
  if (["service", "services", "footway", "path", "busway", "cycleway",
    "steps", "pedestrian", "track", "motorway", "motorway_link",
    "trunk", "trunk_link"].includes(highway)) return 0;
  if (highway === "primary") return 4.0;
  if (highway === "primary_link") return 3.0;
  if (highway === "secondary") return 3.2;
  if (highway === "secondary_link") return 2.6;
  if (highway === "tertiary" || highway === "tertiary_link") return 2.5;
  if (highway === "residential" || highway === "unclassified") return 1.8;
  return 0;
}

// Converte roads-index.json (metros, y para o norte) em segmentos em pixels
// do mundo, cada um com a distância do eixo até a borda desenhada.
export function buildRoadSegments(roads, cfg = WALL_CFG) {
  const segs = [];
  for (const road of roads || []) {
    const sw = sidewalkMetersFor(road);
    const half = (road.width_m || 7) * PPM / 2;
    const clear = sw > 0 ? half + sw * PPM + cfg.curbPx : half + cfg.asphaltHaloPx;
    for (const line of road.lines || []) {
      for (let j = 0; j < line.length - 1; j++) {
        const ax = line[j][0] * PPM, ay = -line[j][1] * PPM;
        const bx = line[j + 1][0] * PPM, by = -line[j + 1][1] * PPM;
        segs.push({
          ax, ay, bx, by, clear, sidewalk: sw > 0,
          soft: sw === 0 && SOFT_HIGHWAYS.includes(String(road.highway || "").toLowerCase()),
          minX: Math.min(ax, bx) - clear, maxX: Math.max(ax, bx) + clear,
          minY: Math.min(ay, by) - clear, maxY: Math.max(ay, by) + clear
        });
      }
    }
  }
  return segs;
}

export function makeField(segs) {
  // Espaço livre: menor (distância ao eixo - borda desenhada). Negativo = dentro.
  return (x, y) => {
    let best = Infinity;
    for (const s of segs) {
      const v = segDist(x, y, s.ax, s.ay, s.bx, s.by) - s.clear;
      if (v < best) best = v;
    }
    return best;
  };
}

// ------------------------------------------------------------------ anéis
export function cleanRing(src, collinearDeg = 4, minEdge = 3) {
  const ring = src.map(p => ({ x: p.x, y: p.y }));
  if (ring.length > 1 && dist(ring[0], ring[ring.length - 1]) < 1e-3) ring.pop();
  const sinTol = Math.sin(collinearDeg * Math.PI / 180);
  let changed = true;
  while (changed && ring.length > 3) {
    changed = false;
    for (let i = 0; i < ring.length; i++) {
      const prev = ring[(i - 1 + ring.length) % ring.length];
      const cur = ring[i];
      const next = ring[(i + 1) % ring.length];
      const l1 = dist(prev, cur), l2 = dist(cur, next);
      if (l1 < minEdge || l2 < minEdge) { ring.splice(i, 1); changed = true; break; }
      const cross = Math.abs((cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x));
      const dot = (cur.x - prev.x) * (next.x - cur.x) + (cur.y - prev.y) * (next.y - cur.y);
      if (dot > 0 && cross / (l1 * l2) < sinTol) { ring.splice(i, 1); changed = true; break; }
    }
  }
  return ring;
}

// offsets[i] > 0 empurra a aresta i para DENTRO do lote; < 0 para fora.
// Requer anel com ringArea2 > 0 (normal interna = (-dy, dx)).
export function offsetRing(ring, offsets) {
  const n = ring.length;
  const lines = ring.map((a, i) => {
    const b = ring[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len, o = offsets[i];
    return { ax: a.x + nx * o, ay: a.y + ny * o, bx: b.x + nx * o, by: b.y + ny * o, nx, ny, o };
  });
  return ring.map((v, i) => {
    const p = lines[(i - 1 + n) % n], c = lines[i];
    const rx = p.bx - p.ax, ry = p.by - p.ay, sx = c.bx - c.ax, sy = c.by - c.ay;
    const cross = rx * sy - ry * sx;
    const limit = Math.max(Math.abs(p.o), Math.abs(c.o), 2) * 4;
    if (Math.abs(cross) > 1e-6 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) {
      const t = ((c.ax - p.ax) * sy - (c.ay - p.ay) * sx) / cross;
      const pt = { x: p.ax + rx * t, y: p.ay + ry * t };
      if (dist(pt, v) <= limit) return pt;
    }
    return { x: v.x + p.nx * p.o + c.nx * c.o, y: v.y + p.ny * p.o + c.ny * c.o };
  });
}

function ringIsValid(ring, refArea2, minRatio) {
  const a = ringArea2(ring);
  return a > 0 && a >= refArea2 * minRatio && isSimple(ring);
}

// ------------------------------------------------------------------ paletas
export const mixColor = (c, f) => {
  const r = clamp(Math.round(((c >> 16) & 255) * f), 0, 255);
  const g = clamp(Math.round(((c >> 8) & 255) * f), 0, 255);
  const b = clamp(Math.round((c & 255) * f), 0, 255);
  return (r << 16) | (g << 8) | b;
};

export function makeWallPalette(base) {
  const cap = mixColor(base, 1.12);
  return {
    face: base,
    faceShadow: mixColor(base, 0.8),
    base: mixColor(base, 0.6),
    cap,
    capHi: mixColor(base, 1.3),
    capShade: mixColor(cap, 0.78),
    pillar: mixColor(base, 0.94),
    outline: OUTLINE
  };
}

// Cores tiradas dos sprites de muro do V4 (reboco creme, ocre, rosa, verde-água...).
const FRONT_COLORS = [0xd9c09c, 0xd9c09c, 0xe4dfd2, 0xe4dfd2, 0xb7b3a8, 0xc99b5e,
  0xd3978a, 0x7fb4a8, 0x6a6d6c, 0xd6b24a];
const SIDE_COLORS = [0xd9c09c, 0xe4dfd2, 0xb7b3a8];

// -------------------------------------------------------------- planejamento
function skip(reason, extra) { return { ok: false, reason, ...extra }; }

export function requiredInset(a, b, n, field, cfg, maxInset) {
  const len = dist(a, b);
  const count = Math.max(2, Math.ceil(len / 10) + 1);
  const ups = [0, -(cfg.height + cfg.pillarExtra)];
  const ok = d => {
    for (let k = 0; k < count; k++) {
      // S? o miolo (20%..80%): as pontas s?o aparadas pelo recuo das arestas vizinhas.
      const t = 0.2 + 0.6 * k / (count - 1);
      const x = a.x + (b.x - a.x) * t + n.x * d;
      const y = a.y + (b.y - a.y) * t + n.y * d;
      for (const up of ups) if (field(x, y + up) < cfg.clearance) return false;
    }
    return true;
  };
  if (ok(0)) return 0;
  for (let d = 2; d <= maxInset + 2; d += 2) {
    if (!ok(d)) continue;
    let lo = d - 2;
    while (lo + 0.5 < d && !ok(lo + 0.5)) lo += 0.5;
    return Math.min(d, lo + 0.5);
  }
  return Infinity;
}

// Pontos do eixo (e do topo deslocado) que ainda ficam dentro da faixa da rua.
function deficitPoints(a, b, field, cfg) {
  const count = Math.max(2, Math.ceil(dist(a, b) / 8) + 1);
  const ups = [0, -(cfg.height + cfg.pillarExtra)];
  const out = [];
  for (let k = 0; k < count; k++) {
    const t = k / (count - 1);
    const p = lerp(a, b, t);
    for (const up of ups) {
      const d = cfg.clearance - field(p.x, p.y + up);
      if (d > 0.01) {
        // Dire??o em que o espa?o livre cresce (afastando da rua mais pr?xima).
        const e = 1.5;
        const gx = field(p.x + e, p.y + up) - field(p.x - e, p.y + up);
        const gy = field(p.x, p.y + up + e) - field(p.x, p.y + up - e);
        const gl = Math.hypot(gx, gy) || 1;
        out.push({ t, d, p, g: { x: gx / gl, y: gy / gl } });
      }
    }
  }
  return out;
}

/**
 * Planeja o muro de um lote.
 * @param ringSrc  anel externo do lote em pixels do mundo (y para baixo)
 * @param ctx      { roadSegs, seed, blockSeed, cfg? }
 * @returns {ok:true, ...plano} ou {ok:false, reason}
 */
// ---- Divisas compartilhadas -------------------------------------------------
// Quando dois lotes vizinhos têm muro na mesma divisa, só um deles (o "dono") desenha.
// O outro recebe em `ctx.skipSegs` os trechos que deve ceder ({a,b} em px). Calculado
// offline por scripts/compute_wall_ownership.mjs e guardado em `wall_skip` no lote.
export const SKIP_TOLERANCE_PX = 3;

// Intervalos [t0,t1] da aresta ca->cb cobertos por algum segmento de skipSegs.
export function skipIntervals(ca, cb, skipSegs, tol = SKIP_TOLERANCE_PX) {
  const len = Math.hypot(cb.x - ca.x, cb.y - ca.y);
  if (!skipSegs?.length || len < 1e-6) return [];
  const ux = (cb.x - ca.x) / len, uy = (cb.y - ca.y) / len;
  const perp = p => Math.abs((p.x - ca.x) * uy - (p.y - ca.y) * ux);
  const along = p => ((p.x - ca.x) * ux + (p.y - ca.y) * uy) / len;
  const out = [];
  for (const s of skipSegs) {
    if (perp(s.a) > tol || perp(s.b) > tol) continue;
    const t0 = Math.max(0, Math.min(along(s.a), along(s.b)));
    const t1 = Math.min(1, Math.max(along(s.a), along(s.b)));
    if (t1 - t0 > 1e-6) out.push([t0, t1]);
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const iv of out) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

export function subtractIntervals(pieces, cover) {
  let out = pieces.map(p => [p[0], p[1]]);
  for (const [c0, c1] of cover) {
    const next = [];
    for (const [p0, p1] of out) {
      if (c1 <= p0 || c0 >= p1) { next.push([p0, p1]); continue; }
      if (c0 > p0) next.push([p0, c0]);
      if (c1 < p1) next.push([c1, p1]);
    }
    out = next;
  }
  return out;
}

export function planLotWall(ringSrc, ctx) {
  const cfg = ctx.cfg || WALL_CFG;
  let ring = cleanRing(ringSrc, 4, cfg.minEdgePx);
  if (ring.length < 3 || ring.length > cfg.maxVertices) return skip("vertices");
  let s2 = ringArea2(ring);
  if (s2 < 0) { ring = ring.reverse(); s2 = -s2; }
  const areaM2 = s2 / 2 / (PPM * PPM);
  if (areaM2 < cfg.minAreaM2 || areaM2 > cfg.maxAreaM2) return skip("area");
  if (!isSimple(ring)) return skip("anel-invalido");

  const n = ring.length;
  const bb = boundsOf(ring);
  const near = ctx.roadSegs.filter(s =>
    s.maxX >= bb.minX - 160 && s.minX <= bb.maxX + 160 &&
    s.maxY >= bb.minY - 160 && s.minY <= bb.maxY + 160);
  const hard = near.filter(s => !s.soft);
  const softSegs = near.filter(s => s.soft);
  const field = makeField(hard);
  const softField = softSegs.length ? makeField(softSegs) : null;

  const edges = ring.map((a, i) => {
    const b = ring[(i + 1) % n];
    const len = dist(a, b) || 1;
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    let depth = 0;
    for (const v of ring) depth = Math.max(depth, (v.x - a.x) * nx + (v.y - a.y) * ny);
    return { a, b, len, n: { x: nx, y: ny }, maxInset: depth * cfg.maxInsetRatio };
  });

  // Come?a sem recuo; o la?o abaixo recua a aresta que realmente afasta cada ponto da rua.
  const minDepth = Math.min(...edges.map(e => e.maxInset)) / cfg.maxInsetRatio;
  if (minDepth < cfg.minWidthPx) return skip("lote-estreito");

  const inset = edges.map(() => 0);

  let center = null, converged = false;
  for (let it = 0; it < 24; it++) {
    center = offsetRing(ring, inset);
    if (!ringIsValid(center, s2, 0.3)) return skip("anel-invalido", { it, inset: inset.slice(), edges: edges.map(e => e.len), areaM2 });
    const target = inset.slice();
    let any = false;
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      for (const pt of deficitPoints(center[i], center[next], field, cfg)) {
        any = true;
        // Qual aresta, ao recuar, tira este ponto da faixa da rua com o MENOR custo?
        // Pode ser a propria aresta i (rua paralela) ou outra aresta que "apara" a
        // ponta (rua vindo de lado, esquinas).
        let bestE = -1, bestVal = Infinity;
        for (let e = 0; e < n; e++) {
          const dot = edges[e].n.x * pt.g.x + edges[e].n.y * pt.g.y;
          if (dot < 0.3) continue;
          const val = e === i
            ? inset[i] + (pt.d / dot) * 1.1 + 0.3
            : Math.max(inset[e], (pt.p.x - ring[e].x) * edges[e].n.x + (pt.p.y - ring[e].y) * edges[e].n.y + 1);
          if (val - inset[e] < bestVal - (bestE >= 0 ? inset[bestE] : 0)) { bestVal = val; bestE = e; }
        }
        if (bestE < 0) return skip("sem-direcao");
        target[bestE] = Math.max(target[bestE], bestVal);
      }
    }
    if (!any) { converged = true; break; }
    for (let i = 0; i < n; i++) {
      inset[i] = Math.min(edges[i].maxInset, target[i]);
    }
  }
  if (!converged) return skip("recuo-nao-converge", { inset: inset.slice(), edges: edges.map(e => e.len), maxInset: edges.map(e => e.maxInset), areaM2 });

  center = center.map(rnd);
  // Arredondar pode estragar um canto muito agudo; confirma que continua simples.
  if (!ringIsValid(center, s2, 0.3)) return skip("anel-invalido");
  const half = cfg.thickness / 2;
  const outer = offsetRing(center, new Array(n).fill(-half)).map(rnd);
  const inner = offsetRing(center, new Array(n).fill(half)).map(rnd);
  if (!ringIsValid(inner, 1, 0) || !ringIsValid(outer, 1, 0)) return skip("lote-estreito");

  // ---- frente do lote e portão
  let frontIdx = -1, frontFree = Infinity;
  const sidewalkSegs = near.filter(s => s.sidewalk);
  for (let i = 0; i < n; i++) {
    const m = lerp(edges[i].a, edges[i].b, 0.5);
    for (const s of sidewalkSegs) {
      const free = segDist(m.x, m.y, s.ax, s.ay, s.bx, s.by) - s.clear;
      if (free < frontFree) { frontFree = free; frontIdx = i; }
    }
  }
  if (frontFree > cfg.frontageReach) frontIdx = -1;

  let gate = null;
  if (frontIdx >= 0) {
    const lc = dist(center[frontIdx], center[(frontIdx + 1) % n]);
    if (lc >= cfg.gateMinEdge) {
      const gap = clamp(lc * 0.3, cfg.gateMin, cfg.gateMax);
      const tc = 0.5 + (((ctx.seed >>> 3) % 7) - 3) * 0.05;
      gate = {
        edge: frontIdx,
        t0: clamp(tc - gap / (2 * lc), 0.1, 0.88),
        t1: clamp(tc + gap / (2 * lc), 0.12, 0.9)
      };
    }
  }

  const frontPal = makeWallPalette(FRONT_COLORS[ctx.seed % FRONT_COLORS.length]);
  const sidePal = makeWallPalette(SIDE_COLORS[ctx.blockSeed % SIDE_COLORS.length]);
  const H = cfg.height;
  const up = p => ({ x: p.x, y: p.y - H });

  const faces = [], tops = [], pillars = [], collisions = [];
  const pillarSeen = new Set();
  // `edge` e `gate` identificam o pilar para o World Editor (campos aditivos).
  const addPillar = (p, pal, edge = null, isGate = false) => {
    const q = rnd(p), key = `${q.x}:${q.y}`;
    if (pillarSeen.has(key)) return;
    pillarSeen.add(key);
    pillars.push({ x: q.x, y: q.y, pal, edge, gate: isGate });
  };

  // Divide [t0,t1] da aresta em trechos que n?o passam por cima de via de servi?o.
  const carvePiece = (ca, cb, t0, t1) => {
    if (!softField) return [[t0, t1]];
    const len = dist(ca, cb);
    const steps = Math.max(1, Math.ceil(len * (t1 - t0) / 2));
    const runs = [];
    let start = null, prevT = t0;
    for (let k = 0; k <= steps; k++) {
      const t = t0 + (t1 - t0) * k / steps;
      const p = lerp(ca, cb, t);
      const blocked = softField(p.x, p.y) < cfg.pillarHalf + 1;
      if (!blocked && start === null) start = t;
      if (blocked && start !== null) { runs.push([start, prevT]); start = null; }
      prevT = t;
    }
    if (start !== null) runs.push([start, t1]);
    return runs.filter(([r0, r1]) => (r1 - r0) * len >= 6);
  };

  for (let i = 0; i < n; i++) {
    const e = edges[i];
    const pal = i === frontIdx ? frontPal : sidePal;
    const ca = center[i], cb = center[(i + 1) % n];
    const oa = outer[i], ob = outer[(i + 1) % n];
    const ia = inner[i], ib = inner[(i + 1) % n];
    let pieces = gate && gate.edge === i
      ? [[0, gate.t0], [gate.t1, 1]] : [[0, 1]];
    // Divisa compartilhada: o vizinho dono desenha este trecho; aqui ele é cedido.
    if (ctx.skipSegs?.length) pieces = subtractIntervals(pieces, skipIntervals(ca, cb, ctx.skipSegs));
    const side = Math.abs(e.n.x);
    const shade = 1 - 0.14 * side;
    addPillar(ca, pal, i);
    if (gate && gate.edge === i) {
      addPillar(lerp(ca, cb, gate.t0), pal, i, true);
      addPillar(lerp(ca, cb, gate.t1), pal, i, true);
    }

    const carved = [];
    for (const [q0, q1] of pieces) {
      for (const [r0, r1] of carvePiece(ca, cb, q0, q1)) {
        carved.push([r0, r1]);
        if (r0 > q0 + 1e-6) addPillar(lerp(ca, cb, r0), pal, i);
        if (r1 < q1 - 1e-6) addPillar(lerp(ca, cb, r1), pal, i);
      }
    }

    let pieceNo = 0;
    for (const [t0, t1] of carved) {
      if (dist(ca, cb) * (t1 - t0) < 1.5) continue;
      // `piece` ("aresta.trecho") é o ID estável do trecho de muro para o World Editor.
      const piece = `${i}.${pieceNo++}`;
      collisions.push({ a: rnd(lerp(ca, cb, t0)), b: rnd(lerp(ca, cb, t1)), piece });

      const O0 = rnd(lerp(oa, ob, t0)), O1 = rnd(lerp(oa, ob, t1));
      const I0 = rnd(lerp(ia, ib, t0)), I1 = rnd(lerp(ia, ib, t1));
      tops.push({ pts: [up(O0), up(O1), up(I1), up(I0)], pal, sortY: (O0.y + O1.y) / 2, piece });

      // Face externa: aparece quando a normal externa aponta para o sul da tela.
      if (e.n.y < -0.1) {
        faces.push({ role: "outer", p0: O0, p1: O1, pal, shade, sortY: (O0.y + O1.y) / 2, piece });
      }
      // Face interna: aparece quando a normal interna aponta para o sul da tela.
      if (e.n.y > 0.1) {
        faces.push({ role: "inner", p0: I0, p1: I1, pal, shade: shade * 0.92, sortY: (I0.y + I1.y) / 2, piece });
      }
    }
  }

  for (const p of pillars) p.sortY = p.y;
  faces.sort((a, b) => a.sortY - b.sortY);
  tops.sort((a, b) => a.sortY - b.sortY);
  pillars.sort((a, b) => a.sortY - b.sortY);

  return {
    ok: true,
    anchor: ring[0],
    bbox: boundsOf(outer),
    areaM2,
    rings: { lot: ring, center, outer, inner },
    insetMax: Math.max(...inset),
    insets: inset.slice(),
    frontIdx,
    gate,
    gateSegment: gate ? {
      a: rnd(lerp(center[gate.edge], center[(gate.edge + 1) % n], gate.t0)),
      b: rnd(lerp(center[gate.edge], center[(gate.edge + 1) % n], gate.t1))
    } : null,
    faces, tops, pillars, collisions
  };
}
