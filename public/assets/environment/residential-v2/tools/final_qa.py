from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CATEGORIES = {
    "properties": sorted((ROOT / "properties").rglob("*.png")),
    "roofs": sorted((ROOT / "roofs").rglob("*.png")),
    "objects": sorted((ROOT / "objects").glob("*.png")),
    "samples": sorted((ROOT / "textures" / "samples").glob("*.png")),
    "tiles": sorted((ROOT / "textures" / "tiles").glob("*.png")),
}
expected = {"properties": 10, "roofs": 4, "objects": 15, "samples": 12, "tiles": 9}
issues = []
total = 0
size_bytes = 0
for category, paths in CATEGORIES.items():
    print(category, len(paths), "expected", expected[category])
    if len(paths) != expected[category]:
        issues.append(f"{category}: expected {expected[category]}, got {len(paths)}")
    for path in paths:
        total += 1
        size_bytes += path.stat().st_size
        try:
            with Image.open(path) as im:
                im.verify()
            with Image.open(path) as im:
                if im.format != "PNG" or im.width < 1 or im.height < 1:
                    issues.append(f"invalid PNG: {path.relative_to(ROOT)}")
        except Exception as exc:
            issues.append(f"unreadable: {path.relative_to(ROOT)} ({exc})")
print("CANONICAL_PNG_TOTAL", total, "expected 50")
print("ASSET_SIZE_MB", round(size_bytes / 1024 / 1024, 2))
print("ISSUES", issues)
if total != 50:
    issues.append(f"expected 50 canonical assets, got {total}")
if issues:
    raise SystemExit(1)
