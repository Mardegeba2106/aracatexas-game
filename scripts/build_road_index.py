#!/usr/bin/env python3
"""Gera public/data/roads-index.json: ruas completas com highway e width_m.

Por que existe: o minimap.json guarda so name+lines. Sem highway/width_m o jogo
nao sabe a largura da pista nem da calcada, e os muros dos lotes acabam
desenhados sobre o passeio. Os chunks guardam cada rua recortada em trechos;
aqui juntamos todos os trechos (sem duplicar) numa lista unica, em metros.
"""
import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHUNKS = os.path.join(ROOT, "public", "data", "chunks")
OUT = os.path.join(ROOT, "public", "data", "roads-index.json")


def key_of(line):
    return tuple((round(p[0], 2), round(p[1], 2)) for p in line)


def main():
    files = sorted(glob.glob(os.path.join(CHUNKS, "*.json")))
    if not files:
        print("Nenhum chunk em", CHUNKS)
        return 1
    roads = {}
    seen = {}
    for path in files:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        for road in data.get("roads", []):
            rid = road["id"]
            entry = roads.setdefault(rid, {
                "id": rid,
                "name": road.get("name", ""),
                "highway": road.get("highway", ""),
                "width_m": road.get("width_m", 7),
                "lines": [],
            })
            known = seen.setdefault(rid, set())
            for line in road.get("lines", []):
                if len(line) < 2:
                    continue
                key = key_of(line)
                rev = key[::-1]
                if key in known or rev in known:
                    continue
                known.add(key)
                entry["lines"].append([[round(p[0], 3), round(p[1], 3)] for p in line])
    result = [roads[k] for k in sorted(roads, key=str)]
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, separators=(",", ":"))
    pts = sum(len(l) for r in result for l in r["lines"])
    print(f"{len(result)} ruas, {pts} pontos -> {os.path.relpath(OUT, ROOT)} "
          f"({os.path.getsize(OUT) // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
