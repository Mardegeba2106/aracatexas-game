#!/usr/bin/env python3
"""
Prepara o recorte jogável do Araçatexas a partir dos arquivos Knoxify/OSM.
Não altera os arquivos de origem.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Iterable

CENTER_LON = -50.43568
CENTER_LAT = -21.22224
RADIUS_M = 650.0
CACHE_NAME = "1d7eb5974fa95dec318ef69f8bbf92fed48f7663.json"
DEFAULT_SOURCE = Path(r"C:\Users\guilh\Desktop\python\knoxify-master")
OUTPUT = Path(__file__).resolve().parents[1] / "public" / "data" / "map.json"

# Fallback WGS84 -> UTM 22S se o pyproj não estiver instalado.
A = 6378137.0
E2 = 0.0066943799901413165
EP2 = E2 / (1 - E2)
K0 = 0.9996
LON0 = math.radians(-51.0)


def wgs84_to_utm22s(lon: float, lat: float) -> tuple[float, float]:
    try:
        from pyproj import Transformer
        transformer = Transformer.from_crs("EPSG:4326", "EPSG:32722", always_xy=True)
        x, y = transformer.transform(lon, lat)
        return float(x), float(y)
    except ImportError:
        phi = math.radians(lat)
        lam = math.radians(lon)
        sin_phi, cos_phi = math.sin(phi), math.cos(phi)
        tan_phi = math.tan(phi)
        n = A / math.sqrt(1 - E2 * sin_phi * sin_phi)
        t = tan_phi * tan_phi
        c = EP2 * cos_phi * cos_phi
        aa = cos_phi * (lam - LON0)
        e4, e6 = E2 * E2, E2 * E2 * E2
        m = A * (
            (1 - E2/4 - 3*e4/64 - 5*e6/256) * phi
            - (3*E2/8 + 3*e4/32 + 45*e6/1024) * math.sin(2*phi)
            + (15*e4/256 + 45*e6/1024) * math.sin(4*phi)
            - (35*e6/3072) * math.sin(6*phi)
        )
        x = 500000 + K0 * n * (
            aa + (1-t+c)*aa**3/6
            + (5-18*t+t*t+72*c-58*EP2)*aa**5/120
        )
        y = 10000000 + K0 * (
            m + n*t * (
                aa*aa/2 + (5-t+9*c+4*c*c)*aa**4/24
                + (61-58*t+t*t+600*c-330*EP2)*aa**6/720
            )
        )
        return x, y


ORIGIN_X, ORIGIN_Y = wgs84_to_utm22s(CENTER_LON, CENTER_LAT)


def local_xy(lon: float, lat: float) -> list[float]:
    x, y = wgs84_to_utm22s(float(lon), float(lat))
    # Y cresce para norte; o renderer converte norte para cima na tela.
    return [round(x - ORIGIN_X, 3), round(y - ORIGIN_Y, 3)]


def distance(point: tuple[float, float] | list[float]) -> float:
    return math.hypot(point[0], point[1])


def iter_coords(value) -> Iterable[list]:
    if not isinstance(value, (list, tuple)):
        return
    if len(value) >= 2 and isinstance(value[0], (int, float)):
        yield value
        return
    for child in value:
        yield from iter_coords(child)


def ring_centroid(ring: list[list[float]]) -> tuple[float, float]:
    if len(ring) < 3:
        if not ring:
            return (0.0, 0.0)
        return (
            sum(p[0] for p in ring) / len(ring),
            sum(p[1] for p in ring) / len(ring)
        )
    area2 = cx = cy = 0.0
    for i, a in enumerate(ring[:-1] if ring[0] == ring[-1] else ring):
        b = ring[(i + 1) % len(ring)]
        cross = a[0] * b[1] - b[0] * a[1]
        area2 += cross
        cx += (a[0] + b[0]) * cross
        cy += (a[1] + b[1]) * cross
    if abs(area2) < 1e-8:
        return (
            sum(p[0] for p in ring) / len(ring),
            sum(p[1] for p in ring) / len(ring)
        )
    return (cx / (3 * area2), cy / (3 * area2))


def geometry_polygons(geometry: dict) -> list[list[list[list[float]]]]:
    kind = geometry.get("type")
    coords = geometry.get("coordinates") or []
    if kind == "Polygon":
        source_polygons = [coords]
    elif kind == "MultiPolygon":
        source_polygons = coords
    else:
        return []
    result = []
    for polygon in source_polygons:
        rings = []
        for ring in polygon:
            converted = [local_xy(p[0], p[1]) for p in ring]
            if len(converted) >= 3:
                rings.append(converted)
        if rings:
            result.append(rings)
    return result


def geometry_center(polygons) -> tuple[float, float]:
    centroids = []
    for polygon in polygons:
        if polygon:
            centroids.append(ring_centroid(polygon[0]))
    if not centroids:
        return (0.0, 0.0)
    return (
        sum(p[0] for p in centroids) / len(centroids),
        sum(p[1] for p in centroids) / len(centroids)
    )


def min_distance_to_segment(point, a, b) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    denom = dx*dx + dy*dy
    if denom == 0:
        return math.hypot(point[0] - a[0], point[1] - a[1])
    t = max(0.0, min(1.0, ((point[0]-a[0])*dx + (point[1]-a[1])*dy) / denom))
    q = (a[0] + t*dx, a[1] + t*dy)
    return math.hypot(point[0] - q[0], point[1] - q[1])


def geometry_intersects_radius(polygons, radius: float) -> bool:
    origin = (0.0, 0.0)
    for polygon in polygons:
        if not polygon:
            continue
        outer = polygon[0]
        if any(distance(p) <= radius for p in outer):
            return True
        if distance(ring_centroid(outer)) <= radius:
            return True
        for i, a in enumerate(outer[:-1]):
            b = outer[i+1]
            if min_distance_to_segment(origin, a, b) <= radius:
                return True
    return False


def simplify(points: list[list[float]], tolerance: float) -> list[list[float]]:
    """Ramer-Douglas-Peucker, preservando início e fim da linha."""
    if len(points) <= 3:
        return points
    a, b = points[0], points[-1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    denom = dx*dx + dy*dy
    best, best_i = -1.0, 0
    for i, p in enumerate(points[1:-1], start=1):
        t = 0.0 if denom == 0 else max(
            0.0, min(1.0, ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / denom)
        )
        q = (a[0] + t*dx, a[1] + t*dy)
        d = math.hypot(p[0] - q[0], p[1] - q[1])
        if d > best:
            best, best_i = d, i
    if best <= tolerance:
        return [a, b]
    left = simplify(points[:best_i+1], tolerance)
    right = simplify(points[best_i:], tolerance)
    return left[:-1] + right


def clip_polyline_to_circle(points: list[list[float]], radius: float) -> list[list[list[float]]]:
    """Recorta os segmentos de uma way ao círculo sem depender de nodes separados."""
    result = []
    current = None
    for p, q in zip(points, points[1:]):
        dx, dy = q[0] - p[0], q[1] - p[1]
        aa = dx*dx + dy*dy
        if aa == 0:
            continue
        bb = 2 * (p[0]*dx + p[1]*dy)
        cc = p[0]*p[0] + p[1]*p[1] - radius*radius
        disc = bb*bb - 4*aa*cc
        lo, hi = 0.0, 1.0
        dp, dq = distance(p), distance(q)
        if cc > 0 and dp > radius and dq > radius and disc < 0:
            if current:
                result.append(current)
                current = None
            continue
        if disc >= 0:
            root = math.sqrt(disc)
            t1, t2 = (-bb-root)/(2*aa), (-bb+root)/(2*aa)
            if cc > 0:
                lo = max(lo, t1)
            if dq > radius:
                hi = min(hi, t2)
        if lo > hi or hi < 0 or lo > 1:
            if current:
                result.append(current)
                current = None
            continue
        lo, hi = max(0.0, lo), min(1.0, hi)
        start = [p[0] + lo*dx, p[1] + lo*dy]
        end = [p[0] + hi*dx, p[1] + hi*dy]
        if current is None or math.dist(current[-1], start) > 0.2:
            if current:
                result.append(current)
            current = [start, end]
        else:
            current.append(end)
        if hi < 1.0 - 1e-8:
            result.append(current)
            current = None
    if current:
        result.append(current)
    cleaned = []
    for line in result:
        line = simplify(line, 0.8)
        if len(line) >= 2:
            cleaned.append([[round(x, 3), round(y, 3)] for x, y in line])
    return cleaned


def resolve_inputs(source: Path) -> tuple[Path, Path]:
    source = source.expanduser().resolve()
    city_candidates = [
        source / "output" / "procedural_city",
        source / "procedural_city",
        source
    ]
    city_dir = next(
        (p for p in city_candidates if all(
            (p / name).exists() for name in
            ("blocks.geojson", "lots.geojson", "buildings.geojson")
        )),
        None
    )
    if city_dir is None:
        raise FileNotFoundError(
            "Não encontrei blocks.geojson, lots.geojson e buildings.geojson. "
            "Use --source apontando para a raiz do Knoxify ou para procedural_city."
        )

    cache_candidates = [
        source / "output" / "_cache" / "overpass" / CACHE_NAME,
        source / "_cache" / "overpass" / CACHE_NAME,
        city_dir.parent.parent / "_cache" / "overpass" / CACHE_NAME,
        city_dir.parent.parent / "output" / "_cache" / "overpass" / CACHE_NAME,
    ]
    cache_file = next((p for p in cache_candidates if p.exists()), None)
    if cache_file is None:
        # Fallback controlado: procura somente o cache com nome exato dentro da raiz informada.
        try:
            cache_file = next(source.rglob(CACHE_NAME))
        except StopIteration:
            raise FileNotFoundError(
                f"Não encontrei o cache OSM {CACHE_NAME}.json na árvore informada."
            )
    return city_dir, cache_file


def road_width(highway: str, tags: dict) -> float:
    explicit = tags.get("width")
    if explicit:
        try:
            return max(4.0, min(35.0, float(str(explicit).replace(" m", "").replace(",", "."))))
        except ValueError:
            pass
    if highway in ("motorway", "motorway_link", "trunk", "trunk_link"):
        return 22.0
    if highway in ("primary", "primary_link"):
        return 16.0
    if highway in ("secondary", "secondary_link", "tertiary", "tertiary_link"):
        return 12.0
    if highway in ("residential", "living_street", "service", "unclassified"):
        return 8.0
    if highway in ("footway", "path", "pedestrian", "cycleway"):
        return 3.0
    return 6.0


def prepare(source: Path, output: Path, radius: float = RADIUS_M) -> dict:
    city_dir, cache_file = resolve_inputs(source)

    collections = {}
    for name in ("blocks", "lots", "buildings"):
        with (city_dir / f"{name}.geojson").open("r", encoding="utf-8") as fh:
            collections[name] = json.load(fh)
        if collections[name].get("type") != "FeatureCollection":
            raise ValueError(f"{name}.geojson não é uma FeatureCollection GeoJSON.")

    with cache_file.open("r", encoding="utf-8") as fh:
        osm = json.load(fh)
    elements = osm.get("elements")
    if not isinstance(elements, list):
        raise ValueError("O cache Overpass não contém a lista elements.")

    result = {
        "meta": {
            "title": "Araçatexas · Araçatuba Shopping / Avenida Brasília",
            "crs": "EPSG:32722",
            "origin_lonlat": [CENTER_LON, CENTER_LAT],
            "origin_utm": [round(ORIGIN_X, 3), round(ORIGIN_Y, 3)],
            "radius_m": radius,
            "units": "meters relative to origin; x east, y north",
            "source": "Knoxify procedural_city + OpenStreetMap Overpass cache",
            "osm_base_timestamp": (osm.get("osm3s") or {}).get("timestamp_osm_base"),
            "attribution": "© OpenStreetMap contributors · ODbL",
        },
        "blocks": [],
        "lots": [],
        "buildings": [],
        "roads": [],
        "trees": [],
    }

    for layer in ("blocks", "lots", "buildings"):
        for feature in collections[layer].get("features", []):
            polygons = geometry_polygons(feature.get("geometry") or {})
            if not polygons or not geometry_intersects_radius(polygons, radius):
                continue
            props = feature.get("properties") or {}
            item = {
                "id": props.get({
                    "blocks": "block_id",
                    "lots": "lot_id",
                    "buildings": "building_id",
                }[layer]) or f"{layer}_{len(result[layer])}",
                "polygons": polygons,
            }
            if layer == "blocks":
                item["zone"] = props.get("zone", "residential")
            elif layer == "lots":
                item.update({
                    "block_id": props.get("block_id", ""),
                    "zone": props.get("zone", "residential"),
                    "area_m2": props.get("area_m2"),
                })
            else:
                item.update({
                    "lot_id": props.get("lot_id", ""),
                    "block_id": props.get("block_id", ""),
                    "building_type": props.get("building_type", "unknown"),
                    "source": props.get("source", ""),
                    "name": props.get("name", ""),
                    "area_m2": props.get("area_m2"),
                    "fixed": props.get("fixed", False),
                })
            result[layer].append(item)

    way_count = 0
    for element in elements:
        if element.get("type") != "way":
            continue
        tags = element.get("tags") or {}
        highway = tags.get("highway")
        geometry = element.get("geometry")
        # No cache fornecido, a geometria está diretamente no elemento way.
        if not highway or not isinstance(geometry, list) or len(geometry) < 2:
            continue
        points = [
            local_xy(p["lon"], p["lat"])
            for p in geometry if "lon" in p and "lat" in p
        ]
        lines = clip_polyline_to_circle(points, radius)
        if not lines:
            continue
        result["roads"].append({
            "id": element.get("id"),
            "name": tags.get("name") or tags.get("ref") or "",
            "highway": highway,
            "width_m": road_width(highway, tags),
            "oneway": tags.get("oneway", ""),
            "lanes": tags.get("lanes", ""),
            "surface": tags.get("surface", ""),
            "maxspeed": tags.get("maxspeed", ""),
            "lines": lines,
        })
        way_count += 1

    for element in elements:
        if element.get("type") != "node":
            continue
        tags = element.get("tags") or {}
        if tags.get("natural") != "tree":
            continue
        if "lon" not in element or "lat" not in element:
            continue
        point = local_xy(element["lon"], element["lat"])
        if distance(point) <= radius:
            result["trees"].append({
                "id": element.get("id"),
                "point": point,
                "name": tags.get("name", ""),
                "height": tags.get("height", ""),
                "leaf_type": tags.get("leaf_type", ""),
            })

    # Ponto inicial: ponto da via mais próximo do centro, sem inventar uma rua nova.
    best = (float("inf"), [0.0, 0.0])
    for road in result["roads"]:
        for line in road["lines"]:
            for point in line:
                d = distance(point)
                if d < best[0]:
                    best = (d, point)
    result["meta"]["spawn"] = best[1]
    result["meta"]["counts"] = {
        "blocks": len(result["blocks"]),
        "lots": len(result["lots"]),
        "buildings": len(result["buildings"]),
        "roads": len(result["roads"]),
        "trees": len(result["trees"]),
        "osm_elements": len(elements),
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, separators=(",", ":"))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepara o mapa real do Araçatexas.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE,
                        help="Raiz do Knoxify, pasta procedural_city ou cópia local dos dados.")
    parser.add_argument("--output", type=Path, default=OUTPUT,
                        help="Destino do map.json (padrão: public/data/map.json).")
    parser.add_argument("--radius", type=float, default=RADIUS_M,
                        help="Raio do recorte em metros (padrão: 650).")
    args = parser.parse_args()

    try:
        result = prepare(args.source, args.output, args.radius)
    except Exception as exc:
        print(f"ERRO: {exc}", file=sys.stderr)
        return 1

    print("Mapa preparado com sucesso.")
    print(f"CRS: {result['meta']['crs']}")
    print(f"Raio: {result['meta']['radius_m']:.0f} m")
    for key, value in result["meta"]["counts"].items():
        print(f"{key}: {value}")
    print(f"Arquivo: {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
