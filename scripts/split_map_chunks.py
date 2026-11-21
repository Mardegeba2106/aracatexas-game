#!/usr/bin/env python3
"""Divide map.json em arquivos espaciais carregados sob demanda pelo jogo."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public" / "data" / "map.json"
DATA_DIR = ROOT / "public" / "data"
CHUNK_DIR = DATA_DIR / "chunks"
CHUNK_METERS = 32.0
EPS = 1e-9


def feature_bounds(feature: dict):
    xs, ys = [], []
    for polygon in feature.get("polygons", []):
        for ring in polygon:
            for x, y in ring:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def chunk_range(bounds):
    min_x, min_y, max_x, max_y = bounds
    cx0 = math.floor(min_x / CHUNK_METERS)
    cx1 = max(cx0, math.floor((max_x - EPS) / CHUNK_METERS))
    cy0 = math.floor(-max_y / CHUNK_METERS)
    cy1 = max(cy0, math.floor((-min_y - EPS) / CHUNK_METERS))
    return cx0, cy0, cx1, cy1


def empty_chunk(cx: int, cy: int):
    return {
        "cx": cx, "cy": cy,
        "blocks": [], "lots": [], "roads": [],
        "buildings": [], "trees": [], "labels": []
    }


def add_feature(chunks, layer, feature):
    bounds = feature_bounds(feature)
    if bounds is None:
        return
    cx0, cy0, cx1, cy1 = chunk_range(bounds)
    for cy in range(cy0, cy1 + 1):
        for cx in range(cx0, cx1 + 1):
            chunk = chunks.setdefault((cx, cy), empty_chunk(cx, cy))
            chunk[layer].append(feature)


def clip_segment(a, b, rect):
    x0, y0 = a
    x1, y1 = b
    dx, dy = x1 - x0, y1 - y0
    t0, t1 = 0.0, 1.0
    tests = (
        (-dx, x0 - rect[0]),
        (dx, rect[2] - x0),
        (-dy, y0 - rect[1]),
        (dy, rect[3] - y0),
    )
    for p, q in tests:
        if abs(p) < EPS:
            if q < 0:
                return None
            continue
        t = q / p
        if p < 0:
            if t > t1:
                return None
            t0 = max(t0, t)
        else:
            if t < t0:
                return None
            t1 = min(t1, t)
    return (
        [round(x0 + t0 * dx, 3), round(y0 + t0 * dy, 3)],
        [round(x0 + t1 * dx, 3), round(y0 + t1 * dy, 3)],
    )


def clipped_lines(lines, cx, cy):
    x_min = cx * CHUNK_METERS
    x_max = (cx + 1) * CHUNK_METERS
    y_min = -(cy + 1) * CHUNK_METERS
    y_max = -cy * CHUNK_METERS
    rect = (x_min, y_min, x_max, y_max)
    output = []
    for line in lines:
        current = None
        for a, b in zip(line, line[1:]):
            segment = clip_segment(a, b, rect)
            if segment is None:
                if current and len(current) >= 2:
                    output.append(current)
                current = None
                continue
            start, end = segment
            if current is None or math.dist(current[-1], start) > 0.01:
                if current and len(current) >= 2:
                    output.append(current)
                current = [start, end]
            else:
                if math.dist(current[-1], end) > 0.001:
                    current.append(end)
            if end != b:
                if current and len(current) >= 2:
                    output.append(current)
                current = None
        if current and len(current) >= 2:
            output.append(current)
    return output


def add_roads(chunks, roads):
    label_count = 0
    for road in roads:
        lines = road.get("lines") or []
        if not lines:
            continue

        # Nomes são gravados somente no chunk que contém o ponto médio escolhido.
        if road.get("name") and label_count < 37:
            label_line = next((line for line in lines if len(line) > 2), None)
            if label_line:
                midpoint = label_line[len(label_line) // 2]
                cx = math.floor(midpoint[0] / CHUNK_METERS)
                cy = math.floor(-midpoint[1] / CHUNK_METERS)
                chunks.setdefault((cx, cy), empty_chunk(cx, cy))["labels"].append({
                    "name": road["name"],
                    "x": midpoint[0] * 16,
                    "y": -midpoint[1] * 16 - 10,
                })
                label_count += 1

        # Uma via é recortada por segmento e somente a parte local fica no arquivo.
        for line in lines:
            if len(line) < 2:
                continue
            xs = [p[0] for p in line]
            ys = [p[1] for p in line]
            bounds = (min(xs), min(ys), max(xs), max(ys))
            cx0, cy0, cx1, cy1 = chunk_range(bounds)
            for cy in range(cy0, cy1 + 1):
                for cx in range(cx0, cx1 + 1):
                    parts = clipped_lines([line], cx, cy)
                    if not parts:
                        continue
                    chunk = chunks.setdefault((cx, cy), empty_chunk(cx, cy))
                    # Agrupa segmentos recortados da mesma via em um registro local.
                    local = next((item for item in chunk["roads"]
                                  if item["id"] == road.get("id")), None)
                    if local is None:
                        local = {
                            "id": road.get("id"),
                            "name": road.get("name", ""),
                            "highway": road.get("highway", ""),
                            "width_m": road.get("width_m", 7),
                            "lines": [],
                        }
                        chunk["roads"].append(local)
                    local["lines"].extend(parts)


def add_trees(chunks, trees):
    for tree in trees:
        point = tree.get("point")
        if not point or len(point) < 2:
            continue
        cx = math.floor(point[0] / CHUNK_METERS)
        cy = math.floor(-point[1] / CHUNK_METERS)
        chunks.setdefault((cx, cy), empty_chunk(cx, cy))["trees"].append(tree)


def write_chunks(map_data):
    chunks = {}
    for layer in ("blocks", "lots", "buildings"):
        for feature in map_data.get(layer, []):
            add_feature(chunks, layer, feature)
    add_roads(chunks, map_data.get("roads", []))
    add_trees(chunks, map_data.get("trees", []))

    CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    # O diretório é exclusivo do gerador; só remove arquivos JSON que ele próprio criou.
    for old_file in CHUNK_DIR.glob("*.json"):
        old_file.unlink()

    total_bytes = 0
    for (cx, cy), chunk in sorted(chunks.items()):
        path = CHUNK_DIR / f"{cx}_{cy}.json"
        encoded = json.dumps(chunk, ensure_ascii=False, separators=(",", ":"))
        path.write_text(encoded, encoding="utf-8")
        total_bytes += path.stat().st_size

    cache_version = hashlib.sha256(
        SOURCE.read_bytes() + Path(__file__).read_bytes()
    ).hexdigest()[:16]
    manifest = {
        "version": 1,
        "cache_version": cache_version,
        "chunk_size_m": CHUNK_METERS,
        "chunk_size_px": int(CHUNK_METERS * 16),
        "meta": map_data["meta"],
        "chunks": [f"{cx}_{cy}" for cx, cy in sorted(chunks)],
        "chunk_count": len(chunks),
    }
    (DATA_DIR / "world-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    # Só o minimapa mantém as linhas simplificadas de todas as vias residentes.
    minimap = {
        "roads": [
            {"name": road.get("name", ""), "lines": road.get("lines", [])}
            for road in map_data.get("roads", [])
        ]
    }
    (DATA_DIR / "minimap.json").write_text(
        json.dumps(minimap, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    print(f"Chunks gravados: {len(chunks)}")
    print(f"Dados espaciais em disco: {total_bytes / 1024:.1f} KB")
    print(f"Manifesto: {DATA_DIR / 'world-manifest.json'}")
    print(f"Minimapa: {DATA_DIR / 'minimap.json'}")
    return len(chunks), total_bytes


def main():
    if not SOURCE.exists():
        raise FileNotFoundError(f"Mapa preparado não encontrado: {SOURCE}")
    map_data = json.loads(SOURCE.read_text(encoding="utf-8"))
    required = ("meta", "blocks", "lots", "buildings", "roads", "trees")
    missing = [key for key in required if key not in map_data]
    if missing:
        raise ValueError(f"map.json incompleto: {', '.join(missing)}")
    write_chunks(map_data)


if __name__ == "__main__":
    main()
