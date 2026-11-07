import importlib.util
import math
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "prepare_map.py"
spec = importlib.util.spec_from_file_location("prepare_map", MODULE_PATH)
prepare_map = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_map)


class MapPreparationTests(unittest.TestCase):
    def test_origin_is_zero_in_local_frame(self):
        point = prepare_map.local_xy(
            prepare_map.CENTER_LON, prepare_map.CENTER_LAT
        )
        self.assertAlmostEqual(point[0], 0.0, delta=0.02)
        self.assertAlmostEqual(point[1], 0.0, delta=0.02)

    def test_utm_coordinates_are_reasonable_for_aracatuba(self):
        x, y = prepare_map.wgs84_to_utm22s(-50.43568, -21.22224)
        self.assertGreater(x, 500000)
        self.assertLess(x, 600000)
        self.assertGreater(y, 7600000)
        self.assertLess(y, 7700000)

    def test_circle_clip_keeps_inside_segment(self):
        clipped = prepare_map.clip_polyline_to_circle(
            [[-100.0, 0.0], [100.0, 0.0]], 50.0
        )
        self.assertEqual(len(clipped), 1)
        self.assertAlmostEqual(clipped[0][0][0], -50.0, delta=0.01)
        self.assertAlmostEqual(clipped[0][-1][0], 50.0, delta=0.01)

    def test_circle_clip_discards_distant_segment(self):
        clipped = prepare_map.clip_polyline_to_circle(
            [[100.0, 100.0], [150.0, 150.0]], 50.0
        )
        self.assertEqual(clipped, [])

    def test_direct_way_geometry_is_supported(self):
        way = {
            "type": "way",
            "geometry": [
                {"lon": -50.43568, "lat": -21.22224},
                {"lon": -50.43500, "lat": -21.22224}
            ],
            "tags": {"highway": "residential", "name": "Rua de teste"}
        }
        points = [
            prepare_map.local_xy(p["lon"], p["lat"])
            for p in way["geometry"]
        ]
        self.assertEqual(len(points), 2)
        self.assertGreater(points[1][0], points[0][0])

    def test_polygon_centroid(self):
        center = prepare_map.ring_centroid([
            [0, 0], [10, 0], [10, 10], [0, 10], [0, 0]
        ])
        self.assertAlmostEqual(center[0], 5.0)
        self.assertAlmostEqual(center[1], 5.0)

    def test_end_to_end_export_from_knoxify_layout(self):
        import json
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "knoxify-master"
            city = root / "output" / "procedural_city"
            cache = root / "output" / "_cache" / "overpass"
            city.mkdir(parents=True)
            cache.mkdir(parents=True)

            # Pequeno polígono de teste próximo à coordenada central.
            lon0, lat0 = prepare_map.CENTER_LON, prepare_map.CENTER_LAT
            polygon = [[
                [lon0 - 0.00010, lat0 - 0.00010],
                [lon0 + 0.00010, lat0 - 0.00010],
                [lon0 + 0.00010, lat0 + 0.00010],
                [lon0 - 0.00010, lat0 + 0.00010],
                [lon0 - 0.00010, lat0 - 0.00010]
            ]]
            feature = {
                "type": "Feature",
                "properties": {"block_id": "blk_test", "lot_id": "lot_test",
                               "building_id": "bld_test", "zone": "residential",
                               "building_type": "house"},
                "geometry": {"type": "Polygon", "coordinates": polygon}
            }
            for layer in ("blocks", "lots", "buildings"):
                (city / f"{layer}.geojson").write_text(
                    json.dumps({"type": "FeatureCollection", "features": [feature]}),
                    encoding="utf-8"
                )

            osm = {
                "osm3s": {"timestamp_osm_base": "2026-11-06T03:46:08Z"},
                "elements": [{
                    "type": "way", "id": 123,
                    "geometry": [
                        {"lon": lon0 - 0.002, "lat": lat0},
                        {"lon": lon0 + 0.002, "lat": lat0}
                    ],
                    "tags": {"highway": "residential", "name": "Rua de teste"}
                }]
            }
            (cache / prepare_map.CACHE_NAME).write_text(json.dumps(osm), encoding="utf-8")

            output = Path(temp) / "map.json"
            result = prepare_map.prepare(root, output, 650)
            self.assertEqual(len(result["blocks"]), 1)
            self.assertEqual(len(result["lots"]), 1)
            self.assertEqual(len(result["buildings"]), 1)
            self.assertEqual(len(result["roads"]), 1)
            self.assertEqual(result["roads"][0]["name"], "Rua de teste")
            self.assertTrue(output.exists())
            loaded = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(loaded["meta"]["crs"], "EPSG:32722")


if __name__ == "__main__":
    unittest.main()
