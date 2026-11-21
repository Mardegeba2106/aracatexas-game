import importlib.util
import unittest
from pathlib import Path

from shapely.geometry import Polygon
from shapely.ops import unary_union

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "split_map_chunks.py"
spec = importlib.util.spec_from_file_location("split_map_chunks", MODULE_PATH)
split_map_chunks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(split_map_chunks)


def feature(feature_id, polygon, **extra):
    return {"id": feature_id, "polygons": [polygon], **extra}


def chunk_features(chunks, layer):
    return [
        (key, item)
        for key, data in chunks.items()
        for item in data[layer]
    ]


def polygon_union(items):
    pieces = []
    for _, item in items:
        for polygon in item["polygons"]:
            pieces.append(Polygon(polygon[0], polygon[1:]))
    return unary_union(pieces)


class ChunkPolygonClippingTests(unittest.TestCase):
    def test_lot_crossing_four_chunks_is_clipped_and_source_kept_once(self):
        source_polygon = [
            [[2, 2], [62, 2], [62, 62], [2, 62], [2, 2]]
        ]
        source = feature("lot_crossing", source_polygon, block_id="block-a", area_m2=3600)
        chunks = {}
        split_map_chunks.add_feature(chunks, "lots", source)

        items = chunk_features(chunks, "lots")
        self.assertEqual(len(items), 4)
        self.assertEqual(
            sum(len(item.get("source_polygons", [])) for _, item in items), 1
        )
        self.assertEqual(
            sum(len(item.get("full_polygon_indices", [])) for _, item in items), 0
        )

        owner = split_map_chunks.lot_wall_anchor_chunk(source_polygon)
        owner_item = next(item for key, item in items if key == owner)
        self.assertEqual(owner_item["source_polygons"][0]["index"], 0)
        self.assertEqual(owner_item["source_polygons"][0]["rings"], source_polygon)

        merged = polygon_union(items)
        original = Polygon(source_polygon[0])
        self.assertAlmostEqual(merged.area, original.area, places=5)
        self.assertTrue(merged.symmetric_difference(original).area < 1e-6)

        for (cx, cy), item in items:
            self.assertTrue(item["chunk_clipped"])
            self.assertEqual(item["id"], "lot_crossing")
            self.assertEqual(item["block_id"], "block-a")
            self.assertEqual(item["area_m2"], 3600)
            self.assertEqual(item["polygon_indices"], [0])
            for polygon in item["polygons"]:
                for ring in polygon:
                    for x, y in ring:
                        self.assertGreaterEqual(x, cx * 32 - 1e-6)
                        self.assertLessEqual(x, (cx + 1) * 32 + 1e-6)
                        self.assertGreaterEqual(y, -(cy + 1) * 32 - 1e-6)
                        self.assertLessEqual(y, -cy * 32 + 1e-6)

    def test_lot_inside_one_chunk_needs_no_duplicate_source(self):
        polygon = [
            [[3, 3], [15, 3], [15, 14], [3, 14], [3, 3]]
        ]
        chunks = {}
        split_map_chunks.add_feature(chunks, "lots", feature("lot-small", polygon))
        items = chunk_features(chunks, "lots")

        self.assertEqual(len(items), 1)
        item = items[0][1]
        self.assertTrue(Polygon(item["polygons"][0][0]).equals(Polygon(polygon[0])))
        self.assertEqual(item["polygon_indices"], [0])
        self.assertEqual(item["full_polygon_indices"], [0])
        self.assertNotIn("source_polygons", item)

    def test_lot_source_uses_cleaned_wall_anchor_chunk(self):
        # A very short first edge is removed by lotWalls.cleanRing. The actual
        # wall anchor therefore moves from chunk 0 to chunk 1.
        polygon = [[
            [31.8, 0], [32.1, 0], [40, 0], [40, -10],
            [31.8, -10], [31.8, 0]
        ]]
        chunks = {}
        split_map_chunks.add_feature(
            chunks, "lots", feature("lot-anchor-shift", polygon)
        )

        self.assertEqual(split_map_chunks.lot_wall_anchor_chunk(polygon), (1, 0))
        items = chunk_features(chunks, "lots")
        source_chunks = [
            key for key, item in items if item.get("source_polygons")
        ]
        self.assertEqual(source_chunks, [(1, 0)])
        self.assertTrue(any(key == (1, 0) and item["polygons"] for key, item in items))

    def test_polygon_with_hole_keeps_inner_ring(self):
        polygon = [
            [[2, 2], [28, 2], [28, 28], [2, 28], [2, 2]],
            [[8, 8], [8, 14], [14, 14], [14, 8], [8, 8]],
        ]
        chunks = {}
        split_map_chunks.add_feature(chunks, "blocks", feature("block-hole", polygon))
        items = chunk_features(chunks, "blocks")

        self.assertEqual(len(items), 1)
        self.assertEqual(len(items[0][1]["polygons"][0]), 2)
        result = Polygon(
            items[0][1]["polygons"][0][0],
            items[0][1]["polygons"][0][1:],
        )
        original = Polygon(polygon[0], polygon[1:])
        self.assertAlmostEqual(result.area, original.area, places=5)

    def test_concave_intersection_can_produce_two_fragments_in_one_chunk(self):
        # Forma em U: o recorte inferior do chunk intersecta os dois braÃ§os,
        # mas nÃ£o o topo que os conecta. O gerador deve manter dois polÃ­gonos.
        u_shape = [[
            [0, 0], [8, 0], [8, 48], [24, 48],
            [24, 0], [32, 0], [32, 64], [0, 64], [0, 0]
        ]]
        chunks = {}
        split_map_chunks.add_feature(chunks, "blocks", feature("block-u", u_shape))

        item = next(item for key, item in chunk_features(chunks, "blocks") if key == (0, -1))
        matching = [
            polygon for polygon, index in zip(item["polygons"], item["polygon_indices"])
            if index == 0
        ]
        self.assertEqual(len(matching), 2)
        self.assertEqual(item["polygon_indices"], [0, 0])
        self.assertAlmostEqual(
            sum(Polygon(poly[0], poly[1:]).area for poly in matching),
            8 * 32 * 2,
            places=5,
        )


if __name__ == "__main__":
    unittest.main()
