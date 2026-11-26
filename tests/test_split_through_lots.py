import copy
import importlib.util
import json
import unittest
from pathlib import Path

from shapely.geometry import Polygon
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "split_through_lots.py"
spec = importlib.util.spec_from_file_location("split_through_lots", MODULE_PATH)
split_through_lots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(split_through_lots)


def rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


def make_map(lots, block_ring):
    return {
        "meta": {"counts": {"lots": len(lots)}},
        "blocks": [{"id": "blk", "polygons": [[block_ring]]}],
        "lots": lots,
    }


def lot(lot_id, ring, **extra):
    return {"id": lot_id, "polygons": [[ring]], "block_id": "blk", "zone": "residential",
            "area_m2": round(Polygon(ring).area, 1), **extra}


def strip_block(span, width=12.0, count=3):
    """Quadra com `count` faixas lado a lado; cada faixa vai de uma rua (y=0) à oposta (y=span)."""
    block = rect(0, 0, width * count, span)
    lots = [lot(f"lot_{i}", rect(i * width, 0, (i + 1) * width, span)) for i in range(count)]
    return make_map(lots, block)


class SplitSyntheticTests(unittest.TestCase):
    def test_through_strip_is_split_in_the_middle_of_its_depth(self):
        result, report = split_through_lots.process_map(strip_block(60))
        halves = [l for l in result["lots"] if l.get("parent_lot_id") == "lot_1"]
        self.assertEqual(sorted(h["id"] for h in halves), ["lot_1_a", "lot_1_b"])
        self.assertEqual(sorted(h["split_side"] for h in halves), ["a", "b"])
        self.assertTrue(all(h["lot_kind"] == "split" for h in halves))
        polygons = [Polygon(h["polygons"][0][0]) for h in halves]
        original = Polygon(rect(12, 0, 24, 60))
        self.assertAlmostEqual(sum(p.area for p in polygons), original.area, places=2)
        self.assertLess(polygons[0].intersection(polygons[1]).area, 1e-6)
        self.assertLess(original.symmetric_difference(polygons[0].union(polygons[1])).area, 1e-3)
        for p in polygons:
            self.assertAlmostEqual(p.bounds[3] - p.bounds[1], 30.0, places=2)  # meio da profundidade
        self.assertEqual(report["dividido"], 3)
        self.assertEqual(report["lots_after"], 6)

    def test_each_half_fronts_a_different_street(self):
        result, _ = split_through_lots.process_map(strip_block(60))
        a = next(l for l in result["lots"] if l["id"] == "lot_1_a")
        b = next(l for l in result["lots"] if l["id"] == "lot_1_b")
        ya = Polygon(a["polygons"][0][0]).bounds
        yb = Polygon(b["polygons"][0][0]).bounds
        self.assertEqual(sorted([ya[1], yb[1]]), [0.0, 30.0])  # uma toca y=0, a outra toca y=60
        self.assertTrue(ya[1] == 0.0 and ya[3] == 30.0 or yb[1] == 0.0 and yb[3] == 30.0)

    def test_halves_keep_block_zone_and_orientation(self):
        source = strip_block(60)
        original_ccw = Polygon(source["lots"][1]["polygons"][0][0]).exterior.is_ccw
        result, _ = split_through_lots.process_map(source)
        for half in (l for l in result["lots"] if l.get("parent_lot_id")):
            self.assertEqual(half["block_id"], "blk")
            self.assertEqual(half["zone"], "residential")
            ring = half["polygons"][0][0]
            self.assertEqual(ring[0], ring[-1])
            self.assertEqual(Polygon(ring).exterior.is_ccw, original_ccw)
            self.assertNotIn("wall_policy", half)

    def test_depth_below_minimum_is_preserved(self):
        # vão de 35 m: cada metade teria 17,5 m (< 18 m)
        result, report = split_through_lots.process_map(strip_block(35))
        self.assertEqual(report["dividido"], 0)
        self.assertTrue(any("profundidade" in key for key in report["motivos"]))
        self.assertEqual(len(result["lots"]), 3)

    def test_exact_minimum_depth_is_split(self):
        _, report = split_through_lots.process_map(strip_block(36, width=12))
        self.assertEqual(report["dividido"], 3)

    def test_width_below_minimum_is_preserved(self):
        _, report = split_through_lots.process_map(strip_block(60, width=7.5))
        self.assertEqual(report["dividido"], 0)
        self.assertTrue(any("largura" in key for key in report["motivos"]))

    def test_area_below_minimum_is_preserved(self):
        # metade com 20 m x 9 m = 180 m² (< 200 m²), profundidade e largura ok
        _, report = split_through_lots.process_map(strip_block(40, width=9))
        self.assertEqual(report["dividido"], 0)
        self.assertTrue(any("área" in key for key in report["motivos"]))

    def test_irregular_lot_is_special_without_walls_and_not_split(self):
        l_shape = [[12, 0], [24, 0], [24, 60], [18, 60], [18, 30], [12, 30], [12, 0]]
        source = strip_block(60)
        source["lots"][1] = lot("lot_1", l_shape)
        result, report = split_through_lots.process_map(source)
        special = next(l for l in result["lots"] if l["id"] == "lot_1")
        self.assertEqual(special["lot_kind"], "special")
        self.assertEqual(special["wall_policy"], "none")
        self.assertEqual(special["polygons"], source["lots"][1]["polygons"])  # geometria intacta
        self.assertEqual(report["especial"], 1)
        self.assertFalse(any(l.get("parent_lot_id") == "lot_1" for l in result["lots"]))

    def test_regular_lot_not_crossing_the_block_is_untouched(self):
        block = rect(0, 0, 60, 60)
        inner = lot("lot_in", rect(20, 20, 40, 40))
        result, report = split_through_lots.process_map(make_map([inner], block))
        self.assertEqual(result["lots"][0], inner)
        self.assertEqual(report["preservado"], 1)

    def test_trapezoid_is_split_with_areas_conserved(self):
        # Quadra cuja rua de cima é inclinada (~15°): as faixas ficam trapezoidais.
        top = lambda x: 80 + x * 10 / 36
        block = [[0, 0], [36, 0], [36, top(36)], [0, top(0)], [0, 0]]
        strips = [
            lot(f"lot_{i}", [[12 * i, 0], [12 * i + 12, 0], [12 * i + 12, top(12 * i + 12)],
                              [12 * i, top(12 * i)], [12 * i, 0]])
            for i in range(3)
        ]
        result, report = split_through_lots.process_map(make_map(strips, block))
        self.assertEqual(report["dividido"], 3)
        halves = [l for l in result["lots"] if l.get("parent_lot_id") == "lot_1"]
        self.assertEqual(len(halves), 2)
        polygons = [Polygon(h["polygons"][0][0]) for h in halves]
        original = Polygon(strips[1]["polygons"][0][0])
        self.assertAlmostEqual(sum(p.area for p in polygons), original.area, places=1)
        self.assertLess(original.symmetric_difference(polygons[0].union(polygons[1])).area, 1e-2)
        # cada metade encosta numa rua diferente e as duas têm profundidade parecida
        touches_bottom = [p.bounds[1] <= 1e-6 for p in polygons]
        self.assertEqual(sorted(touches_bottom), [False, True])
        depths = sorted(p.bounds[3] - p.bounds[1] for p in polygons)
        self.assertLess(abs(depths[0] - depths[1]), 2.0)

    def test_process_is_idempotent(self):
        once, _ = split_through_lots.process_map(strip_block(60))
        twice, report = split_through_lots.process_map(copy.deepcopy(once))
        self.assertEqual(twice["lots"], once["lots"])
        self.assertEqual(report["dividido"], 0)

    def test_meta_counts_follow_the_new_lot_list(self):
        result, _ = split_through_lots.process_map(strip_block(60))
        self.assertEqual(result["meta"]["counts"]["lots"], len(result["lots"]))
        self.assertEqual(result["meta"]["lot_split"]["min_half_depth_m"], 18.0)

    def test_input_map_is_not_mutated(self):
        source = strip_block(60)
        snapshot = copy.deepcopy(source)
        split_through_lots.process_map(source)
        self.assertEqual(source, snapshot)


class SplitRealDataTests(unittest.TestCase):
    """Invariantes do mapa oficial já dividido (public/data/map.json)."""

    @classmethod
    def setUpClass(cls):
        cls.map = json.loads((ROOT / "public" / "data" / "map.json").read_text(encoding="utf-8"))
        report_path = ROOT / "public" / "data" / "lot-split-report.json"
        if not report_path.exists():
            raise unittest.SkipTest("mapa ainda não foi dividido (rode npm run split:lots)")
        cls.report = json.loads(report_path.read_text(encoding="utf-8"))
        cls.lots = cls.map["lots"]

    def test_counts_match_the_report(self):
        kinds = [l.get("lot_kind") for l in self.lots]
        self.assertEqual(kinds.count("split"), self.report["novos_terrenos"])
        self.assertEqual(kinds.count("special"), self.report["especial"])
        self.assertEqual(len(self.lots), self.report["lots_after"])
        self.assertEqual(self.map["meta"]["counts"]["lots"], len(self.lots))

    def test_ids_are_unique(self):
        ids = [l["id"] for l in self.lots]
        self.assertEqual(len(ids), len(set(ids)))

    def test_every_split_lot_has_both_halves_and_no_parent_remains(self):
        ids = {l["id"] for l in self.lots}
        for l in self.lots:
            if l.get("lot_kind") != "split":
                continue
            parent = l["parent_lot_id"]
            self.assertNotIn(parent, ids)
            self.assertIn(f"{parent}_a", ids)
            self.assertIn(f"{parent}_b", ids)

    def test_halves_respect_minimum_rules(self):
        rules = split_through_lots.RULES
        for l in self.lots:
            if l.get("lot_kind") == "split":
                self.assertGreaterEqual(l["area_m2"], rules["min_half_area_m2"] - 0.5)

    def test_specials_have_no_wall_policy_other_than_none(self):
        for l in self.lots:
            if l.get("lot_kind") == "special":
                self.assertEqual(l["wall_policy"], "none")
            else:
                self.assertNotIn("wall_policy", l)

    def test_all_polygons_valid_and_lots_do_not_overlap(self):
        polygons = []
        for l in self.lots:
            self.assertEqual(len(l["polygons"]), 1)
            self.assertEqual(len(l["polygons"][0]), 1)
            p = Polygon(l["polygons"][0][0])
            self.assertTrue(p.is_valid, l["id"])
            polygons.append(p)
        tree = STRtree(polygons)
        worst = 0.0
        for i, p in enumerate(polygons):
            for j in tree.query(p):
                if j <= i:
                    continue
                worst = max(worst, p.intersection(polygons[j]).area)
        self.assertLess(worst, 0.5, "lotes não podem se sobrepor (m²)")

    def test_split_pairs_cover_a_single_original_strip(self):
        by_parent = {}
        for l in self.lots:
            if l.get("lot_kind") == "split":
                by_parent.setdefault(l["parent_lot_id"], []).append(Polygon(l["polygons"][0][0]))
        for parent, pair in by_parent.items():
            self.assertEqual(len(pair), 2)
            union = pair[0].union(pair[1])
            self.assertEqual(union.geom_type, "Polygon", f"{parent}: metades devem ser contíguas")


if __name__ == "__main__":
    unittest.main()
