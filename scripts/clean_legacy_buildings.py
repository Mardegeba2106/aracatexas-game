#!/usr/bin/env python3
"""Remove a camada antiga de edifícios do mapa ativo e arquiva seus polígonos."""
from __future__ import annotations
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAP_FILE = ROOT / "public" / "data" / "map.json"
ARCHIVE_FILE = ROOT / "archive" / "legacy-buildings-2026-11-21.json"


def main() -> None:
    data = json.loads(MAP_FILE.read_text(encoding="utf-8"))
    buildings = data.get("buildings")
    if not isinstance(buildings, list):
        raise ValueError("Camada 'buildings' ausente ou inválida em map.json")
    if buildings:
        ARCHIVE_FILE.parent.mkdir(parents=True, exist_ok=True)
        if ARCHIVE_FILE.exists():
            raise FileExistsError(f"Arquivo de segurança já existe: {ARCHIVE_FILE}")
        archive = {
            "format": "aracatexas-legacy-buildings-archive",
            "archived_at": "2026-11-21",
            "source_map_meta": data.get("meta", {}),
            "count": len(buildings),
            "buildings": buildings,
        }
        ARCHIVE_FILE.write_text(
            json.dumps(archive, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
    count = len(buildings)
    data["buildings"] = []
    data.setdefault("meta", {}).setdefault("counts", {})["buildings"] = 0
    MAP_FILE.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Edifícios retirados do mapa ativo: {count}")
    print(f"Arquivo histórico: {ARCHIVE_FILE}")
    print(f"Lotes preservados: {len(data.get('lots', []))}")
    print(f"Ruas preservadas: {len(data.get('roads', []))}")


if __name__ == "__main__":
    main()
