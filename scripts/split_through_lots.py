#!/usr/bin/env python3
"""Divide os lotes que atravessam a quadra de uma rua até a rua oposta.

Cada lote passante e regular vira dois terrenos independentes (`<id>_a` e `<id>_b`),
cortados no meio da profundidade, cada um com frente para uma das ruas.
Lotes de formato irregular NÃO são divididos e ficam marcados como especiais
(`lot_kind: "special"`, `wall_policy: "none"`): não recebem muro automático.

Regras (constantes em RULES):
  - profundidade mínima de 18 m por metade (o corte é no meio, então vão >= 36 m);
  - largura mínima de 8 m;
  - área mínima de 200 m² por metade.

Pipeline: roda depois de prepare_map.py e antes de split_map_chunks.py. É idempotente:
lotes que já têm `lot_kind` (metades e especiais) não são reprocessados.

Uso:
    python scripts/split_through_lots.py            # reescreve public/data/map.json
    python scripts/split_through_lots.py --dry-run  # só mostra o resumo
"""
from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path

try:
    from shapely.geometry import LineString, Polygon
    from shapely.geometry.polygon import orient
    from shapely.ops import split
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "A divisão de lotes requer Shapely. Execute: python -m pip install -r requirements.txt"
    ) from exc

ROOT = Path(__file__).resolve().parents[1]
MAP_PATH = ROOT / "public" / "data" / "map.json"
REPORT_PATH = ROOT / "public" / "data" / "lot-split-report.json"

RULES = {
    "min_half_depth_m": 18.0,
    "min_width_m": 8.0,
    "min_half_area_m2": 200.0,
    # Uma aresta conta como "voltada para a rua" se >= 80% dela estiver sobre a divisa da quadra.
    "street_edge_fraction": 0.8,
    "street_edge_tolerance_m": 0.6,
    "min_edge_m": 3.0,
    "min_street_edge_m": 5.0,
    "max_front_angle_deg": 25.0,
    # Forma: retângulo mínimo >= 92% da área para polígonos de até 6 vértices.
    "min_rectangularity": 0.92,
    "max_vertices": 6,
    "simplify_m": 0.4,
}
COORD_DECIMALS = 3
LOT_SPLIT_VERSION = 1


def _unit(vector):
    length = math.hypot(*vector)
    return (vector[0] / length, vector[1] / length)


def _angle_between(u, v):
    """Ângulo (graus) entre duas direções não orientadas."""
    cosine = abs(u[0] * v[0] + u[1] * v[1])
    return math.degrees(math.acos(min(1.0, cosine)))


def lot_ring(lot):
    ring = lot["polygons"][0][0]
    return ring[:-1] if ring[0] == ring[-1] else ring


def classify_shape(polygon, rules=RULES):
    """retangular | trapezoidal | quadrilatero | poligono-regular | irregular."""
    rectangularity = polygon.area / polygon.minimum_rotated_rectangle.area
    simplified = list(polygon.simplify(rules["simplify_m"]).exterior.coords)[:-1]
    convex = polygon.convex_hull.area / polygon.area > 0.985
    if len(simplified) == 4 and convex:
        sides = [
            (simplified[(i + 1) % 4][0] - simplified[i][0], simplified[(i + 1) % 4][1] - simplified[i][1])
            for i in range(4)
        ]
        if min(math.hypot(*s) for s in sides) < 1e-6:
            return "irregular", rectangularity, len(simplified)
        units = [_unit(s) for s in sides]
        angles = []
        for i in range(4):
            a, b = units[i - 1], units[i]
            cosine = max(-1.0, min(1.0, -(a[0] * b[0] + a[1] * b[1])))
            angles.append(math.degrees(math.acos(cosine)))
        parallel = [_angle_between(units[0], units[2]) <= 6, _angle_between(units[1], units[3]) <= 6]
        if all(abs(a - 90) <= 8 for a in angles):
            return "retangular", rectangularity, 4
        if any(parallel) and all(60 <= a <= 120 for a in angles):
            return "trapezoidal", rectangularity, 4
        if all(60 <= a <= 120 for a in angles) and rectangularity >= 0.9:
            return "quadrilatero", rectangularity, 4
    elif (len(simplified) <= rules["max_vertices"] and convex
          and rectangularity >= rules["min_rectangularity"]):
        return "poligono-regular", rectangularity, len(simplified)
    return "irregular", rectangularity, len(simplified)


def street_edges(polygon, ring, block_polygon, rules=RULES):
    """Arestas do lote que estão sobre a divisa da quadra (= voltadas para uma rua)."""
    tolerance = block_polygon.exterior.buffer(rules["street_edge_tolerance_m"])
    counter_clockwise = polygon.exterior.is_ccw
    edges = []
    for i, a in enumerate(ring):
        b = ring[(i + 1) % len(ring)]
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        if length < rules["min_edge_m"]:
            continue
        if LineString([a, b]).intersection(tolerance).length / length < rules["street_edge_fraction"]:
            continue
        d = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
        normal = (d[1], -d[0]) if counter_clockwise else (-d[1], d[0])  # aponta para fora do lote
        edges.append({"a": a, "b": b, "length": length, "d": d, "n": normal,
                      "mid": ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)})
    return edges


def opposite_pair(edges, rules=RULES):
    """Par de arestas voltadas para lados opostos (ruas opostas); o de maior frente."""
    best, best_len = None, 0.0
    for i in range(len(edges)):
        for j in range(i + 1, len(edges)):
            x, y = edges[i], edges[j]
            if x["n"][0] * y["n"][0] + x["n"][1] * y["n"][1] >= -0.6:
                continue
            if x["length"] < rules["min_street_edge_m"] or y["length"] < rules["min_street_edge_m"]:
                continue
            shortest = min(x["length"], y["length"])
            if shortest > best_len:
                best, best_len = (x, y), shortest
    return best


def cut_at_mid_depth(polygon, pair, rules=RULES):
    """Corta no meio da profundidade, paralelo às frentes. Retorna (metades, info) ou (None, motivo)."""
    edge_a, edge_b = pair
    d_a = edge_a["d"]
    d_b = edge_b["d"] if (d_a[0] * edge_b["d"][0] + d_a[1] * edge_b["d"][1]) >= 0 else (-edge_b["d"][0], -edge_b["d"][1])
    if _angle_between(d_a, d_b) > rules["max_front_angle_deg"]:
        return None, "frentes não paralelas"
    direction = _unit((d_a[0] + d_b[0], d_a[1] + d_b[1]))
    normal = (-direction[1], direction[0])
    offset_a = sum(normal[0] * p[0] + normal[1] * p[1] for p in (edge_a["a"], edge_a["b"])) / 2
    offset_b = sum(normal[0] * p[0] + normal[1] * p[1] for p in (edge_b["a"], edge_b["b"])) / 2
    depth_total = abs(offset_b - offset_a)
    middle = (offset_a + offset_b) / 2
    base = (normal[0] * middle, normal[1] * middle)
    line = LineString([
        (base[0] - direction[0] * 5000, base[1] - direction[1] * 5000),
        (base[0] + direction[0] * 5000, base[1] + direction[1] * 5000),
    ])
    parts = [g for g in split(polygon, line).geoms if g.area > 1 and g.geom_type == "Polygon"]
    if len(parts) != 2:
        return None, "corte não gerou duas partes"
    chord = line.intersection(polygon).length
    info = {
        "depth_total": depth_total,
        "half_depth": depth_total / 2,
        "chord": chord,
        "min_width": min(chord, edge_a["length"], edge_b["length"]),
        "areas": [g.area for g in parts],
    }
    return parts, info


def _ring_coords(geometry, counter_clockwise):
    oriented = orient(geometry, sign=1.0 if counter_clockwise else -1.0)
    return [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in oriented.exterior.coords]


def decide_lot(lot, block_polygon, rules=RULES):
    """Decide o destino de um lote. Retorna dict com `decision` em dividido|preservado|especial."""
    ring = lot_ring(lot)
    polygon = Polygon(ring)
    if len(lot["polygons"]) != 1 or len(lot["polygons"][0]) != 1 or not polygon.is_valid or polygon.area <= 1:
        return {"decision": "preservado", "reason": "geometria não suportada"}
    shape, rectangularity, vertices = classify_shape(polygon, rules)
    base = {"shape": shape, "rectangularity": rectangularity, "vertices": vertices, "area": polygon.area}
    if shape == "irregular":
        return {**base, "decision": "especial", "reason": "forma irregular"}
    edges = street_edges(polygon, ring, block_polygon, rules) if block_polygon is not None else []
    pair = opposite_pair(edges, rules)
    if pair is None:
        return {**base, "decision": "preservado", "reason": "não atravessa a quadra"}
    parts, info = cut_at_mid_depth(polygon, pair, rules)
    if parts is None:
        return {**base, "decision": "preservado", "reason": info}
    failed = []
    if info["half_depth"] < rules["min_half_depth_m"]:
        failed.append("profundidade")
    if info["min_width"] < rules["min_width_m"]:
        failed.append("largura")
    if min(info["areas"]) < rules["min_half_area_m2"]:
        failed.append("área")
    if failed:
        return {**base, "decision": "preservado", "reason": "abaixo do mínimo: " + ", ".join(failed), "info": info}
    # metade "a" = a que fica junto da primeira frente do par
    mid_a = pair[0]["mid"]
    from shapely.geometry import Point
    half_a = min(parts, key=lambda g: g.distance(Point(mid_a)))
    half_b = next(g for g in parts if g is not half_a)
    return {**base, "decision": "dividido", "reason": "", "info": info, "halves": (half_a, half_b)}


def process_map(map_data, rules=RULES):
    """Aplica a divisão ao mapa (em memória). Retorna (novo_mapa, relatório)."""
    blocks = {}
    for block in map_data.get("blocks", []):
        polygons = block.get("polygons") or []
        if polygons and polygons[0]:
            blocks[block["id"]] = Polygon(polygons[0][0], polygons[0][1:])

    new_lots, decisions, reasons = [], Counter(), Counter()
    for lot in map_data.get("lots", []):
        if lot.get("lot_kind"):  # já processado (idempotência)
            new_lots.append(lot)
            decisions["já processado"] += 1
            continue
        result = decide_lot(lot, blocks.get(lot.get("block_id")), rules)
        decisions[result["decision"]] += 1
        if result["decision"] == "dividido":
            counter_clockwise = Polygon(lot_ring(lot)).exterior.is_ccw
            rings = [_ring_coords(g, counter_clockwise) for g in result["halves"]]
            valid = all(Polygon(r).is_valid for r in rings)
            area_after = sum(Polygon(r).area for r in rings)
            if not valid or abs(area_after - result["area"]) > 0.5:
                decisions["dividido"] -= 1
                decisions["preservado"] += 1
                reasons[("preservado", "falha de arredondamento do corte")] += 1
                new_lots.append(lot)
                continue
            for side, ring in zip(("a", "b"), rings):
                half = {k: v for k, v in lot.items() if k not in ("id", "polygons", "area_m2")}
                half = {
                    "id": f"{lot['id']}_{side}",
                    "polygons": [[ring]],
                    **{k: v for k, v in half.items()},
                    "area_m2": round(Polygon(ring).area, 1),
                    "parent_lot_id": lot["id"],
                    "split_side": side,
                    "lot_kind": "split",
                }
                new_lots.append(half)
        elif result["decision"] == "especial":
            reasons[("especial", result["reason"])] += 1
            new_lots.append({**lot, "lot_kind": "special", "wall_policy": "none"})
        else:
            reasons[("preservado", result["reason"])] += 1
            new_lots.append(lot)

    new_map = {**map_data, "lots": new_lots}
    meta = dict(new_map.get("meta", {}))
    counts = dict(meta.get("counts", {}))
    counts["lots"] = len(new_lots)
    meta["counts"] = counts
    meta["lot_split"] = {"version": LOT_SPLIT_VERSION, **{k: rules[k] for k in
                         ("min_half_depth_m", "min_width_m", "min_half_area_m2")}}
    new_map["meta"] = meta
    report = {
        "version": LOT_SPLIT_VERSION,
        "rules": rules,
        "lots_before": len(map_data.get("lots", [])),
        "lots_after": len(new_lots),
        "dividido": decisions["dividido"],
        "novos_terrenos": 2 * decisions["dividido"],
        "preservado": decisions["preservado"],
        "especial": decisions["especial"],
        "ja_processado": decisions["já processado"],
        "motivos": {f"{kind}: {reason}": n for (kind, reason), n in sorted(reasons.items())},
    }
    return new_map, report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--map", type=Path, default=MAP_PATH, help="map.json de entrada/saída")
    parser.add_argument("--report", type=Path, default=REPORT_PATH, help="relatório (contagens) em JSON")
    parser.add_argument("--dry-run", action="store_true", help="não grava nada; só imprime o resumo")
    args = parser.parse_args()

    map_data = json.loads(args.map.read_text(encoding="utf-8"))
    new_map, report = process_map(map_data)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.dry_run:
        print("(dry-run: nada foi gravado)")
        return 0
    args.map.write_text(json.dumps(new_map, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Mapa gravado: {args.map}")
    print(f"Relatório: {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
