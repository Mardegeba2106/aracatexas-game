#!/usr/bin/env python3
"""Divide map.json em arquivos espaciais carregados sob demanda pelo jogo."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

try:
    from shapely.geometry import Polygon, box
except ImportError as exc:
    raise SystemExit(
        "Optimized polygon clipping requires Shapely. "
        "Execute: python -m pip install -r requirements.txt"
    ) from exc

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


def polygon_bounds(polygon):
    xs = [point[0] for ring in polygon for point in ring]
    ys = [point[1] for ring in polygon for point in ring]
    if not xs or not ys:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def polygon_parts(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry] if geometry.area > EPS else []
    if geometry.geom_type == "MultiPolygon":
        return [part for part in geometry.geoms if part.area > EPS]
    if geometry.geom_type == "GeometryCollection":
        parts = []
        for part in geometry.geoms:
            parts.extend(polygon_parts(part))
        return parts
    return []


def rounded_ring(coords):
    points = [[round(float(x), 6), round(float(y), 6)] for x, y in coords]
    # Coordinates are rounded to six decimals, without shape simplification.
    # Consecutive duplicates created by rounding are removed.
    clean = []
    for point in points:
        if not clean or point != clean[-1]:
            clean.append(point)
    if clean and clean[0] != clean[-1]:
        clean.append(clean[0])
    return clean if len(clean) >= 4 else []


def polygon_to_coords(polygon):
    outer = rounded_ring(polygon.exterior.coords)
    if not outer:
        return None
    rings = [outer]
    for interior in polygon.interiors:
        hole = rounded_ring(interior.coords)
        if hole:
            rings.append(hole)
    return rings


def lot_wall_anchor_chunk(coordinates):
    """Mirror cleanRing and ring orientation from lotWalls.js to locate the wall anchor."""
    if not coordinates or not coordinates[0]:
        return (0, 0)

    ring = [
        {"x": float(x) * 16, "y": -float(y) * 16}
        for x, y in coordinates[0]
    ]
    distance = lambda a, b: math.hypot(a["x"] - b["x"], a["y"] - b["y"])

    if len(ring) > 1 and distance(ring[0], ring[-1]) < 1e-3:
        ring.pop()

    sin_tolerance = math.sin(math.radians(4))
    changed = True
    while changed and len(ring) > 3:
        changed = False
        for index in range(len(ring)):
            previous = ring[(index - 1) % len(ring)]
            current = ring[index]
            following = ring[(index + 1) % len(ring)]
            length_a = distance(previous, current)
            length_b = distance(current, following)

            if length_a < 24 or length_b < 24:
                ring.pop(index)
                changed = True
                break

            cross = abs(
                (current["x"] - previous["x"]) *
                (following["y"] - current["y"]) -
                (current["y"] - previous["y"]) *
                (following["x"] - current["x"])
            )
            dot = (
                (current["x"] - previous["x"]) *
                (following["x"] - current["x"]) +
                (current["y"] - previous["y"]) *
                (following["y"] - current["y"])
            )
            if dot > 0 and cross / (length_a * length_b) < sin_tolerance:
                ring.pop(index)
                changed = True
                break

    if len(ring) < 3:
        first = coordinates[0][0]
        return math.floor(first[0] / CHUNK_METERS), math.floor(-first[1] / CHUNK_METERS)

    area2 = sum(
        ring[index]["x"] * ring[(index + 1) % len(ring)]["y"] -
        ring[(index + 1) % len(ring)]["x"] * ring[index]["y"]
        for index in range(len(ring))
    )
    if area2 < 0:
        ring.reverse()

    anchor = ring[0]
    return math.floor(anchor["x"] / 512), math.floor(anchor["y"] / 512)


def add_clipped_polygon_feature(chunks, layer, feature):
    # Each fragment contains only geometry inside its chunk.
    # Lots keep their complete source geometry only once in the wall-anchor chunk,
    # so wall generation can use the complete perimeter.
    entries = {}
    source_by_chunk = {}

    def ensure_entry(key):
        if key not in entries:
            cx, cy = key
            chunk = chunks.setdefault(key, empty_chunk(cx, cy))
            entry = {
                **feature,
                "polygons": [],
                "polygon_indices": [],
                "full_polygon_indices": [],
                "chunk_clipped": True,
            }
            entries[key] = entry
            chunk[layer].append(entry)
        return entries[key]

    for polygon_index, coordinates in enumerate(feature.get("polygons") or []):
        if not coordinates or not coordinates[0] or len(coordinates[0]) < 4:
            continue
        geometry = Polygon(coordinates[0], coordinates[1:])
        if geometry.is_empty or geometry.area <= EPS:
            continue
        if not geometry.is_valid:
            raise ValueError(
                f"Invalid polygon in {layer} {feature.get('id')} "
                f"(index {polygon_index}); refusing to alter it silently."
            )

        bounds = polygon_bounds(coordinates)
        if bounds is None:
            continue
        cx0, cy0, cx1, cy1 = chunk_range(bounds)
        fragments = {}

        for cy in range(cy0, cy1 + 1):
            for cx in range(cx0, cx1 + 1):
                key = (cx, cy)
                rect = box(
                    cx * CHUNK_METERS,
                    -(cy + 1) * CHUNK_METERS,
                    (cx + 1) * CHUNK_METERS,
                    -cy * CHUNK_METERS,
                )
                clipped = geometry.intersection(rect)
                parts = []
                for part in polygon_parts(clipped):
                    converted = polygon_to_coords(part)
                    if converted:
                        parts.append(converted)
                if parts:
                    fragments[key] = parts

        if not fragments:
            continue

        for key, parts in fragments.items():
            entry = ensure_entry(key)
            for part in parts:
                entry["polygons"].append(part)
                entry["polygon_indices"].append(polygon_index)

        # The first vertex is the anchor used by the current wall system.
        # lotWalls.js calls cleanRing and can move the first vertex
        # when removing short/collinear edges or reversing ring orientation.
        # The single source copy must live in the exact anchor chunk.
        owner = lot_wall_anchor_chunk(coordinates) if layer == "lots" else (
            math.floor(coordinates[0][0][0] / CHUNK_METERS),
            math.floor(-coordinates[0][0][1] / CHUNK_METERS),
        )
        full_in_one_chunk = (
            len(fragments) == 1
            and owner in fragments
            and geometry.equals(
                Polygon(
                    fragments[owner][0][0],
                    fragments[owner][0][1:],
                )
            )
            and len(fragments[owner]) == 1
        )

        if layer == "lots":
            if full_in_one_chunk:
                ensure_entry(owner)["full_polygon_indices"].append(polygon_index)
            else:
                # Source geometry stays only in the anchor chunk. Other chunks
                # receive only the local geometry needed for drawing and selection.
                source_by_chunk.setdefault(owner, []).append({
                    "index": polygon_index,
                    "rings": coordinates,
                })

    if layer == "lots":
        for key, sources in source_by_chunk.items():
            ensure_entry(key)["source_polygons"] = sources


def add_feature(chunks, layer, feature):
    if layer in ("blocks", "lots"):
        add_clipped_polygon_feature(chunks, layer, feature)
        return

    # Buildings keep the current format until a dedicated implementation
    # can separate their footprints, collision and visual composition by fragment.
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

    source_bytes = SOURCE.read_bytes()
    source_hash = hashlib.sha256(source_bytes).hexdigest()[:16]
    cache_version = hashlib.sha256(
        source_bytes + Path(__file__).read_bytes()
    ).hexdigest()[:16]

    # Na primeira migra??o, preserve a identidade antiga do mapa para n?o
    # invalidar edi??es locais do World Editor por uma mera mudan?a de chunk.
    manifest_path = DATA_DIR / "world-manifest.json"
    previous = {}
    if manifest_path.exists():
        try:
            previous = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            previous = {}
    if previous.get("source_map_hash") == source_hash:
        map_version = previous.get("map_version") or previous.get("cache_version") or source_hash
    elif previous.get("source_map_hash") is None and previous.get("cache_version"):
        map_version = previous["cache_version"]
    else:
        map_version = source_hash

    manifest = {
        "version": 2,
        "map_version": map_version,
        "source_map_hash": source_hash,
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
