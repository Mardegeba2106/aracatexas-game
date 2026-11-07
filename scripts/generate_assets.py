#!/usr/bin/env python3
"""Gera tiles e sprite-sheet pixelados do protótipo usando Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw
import random

ROOT = Path(__file__).resolve().parents[1] / "public" / "assets"
ROOT.mkdir(parents=True, exist_ok=True)
random.seed(20261106)


def make_tile(base, accents, filename, density=28):
    image = Image.new("RGBA", (32, 32), base)
    draw = ImageDraw.Draw(image)
    for _ in range(density):
        x, y = random.randrange(32), random.randrange(32)
        color = random.choice(accents)
        draw.rectangle((x, y, x + random.choice([0, 1]), y), fill=color)
    image.save(ROOT / filename)


def make_tileset():
    sheet = Image.new("RGBA", (128, 32), (0, 0, 0, 0))
    palettes = [
        ((65, 105, 64, 255), [(84, 128, 71, 255), (49, 87, 55, 255), (116, 139, 75, 255)]),
        ((137, 111, 74, 255), [(163, 137, 91, 255), (111, 87, 60, 255), (180, 150, 103, 255)]),
        ((160, 158, 135, 255), [(194, 187, 157, 255), (128, 132, 119, 255), (220, 211, 178, 255)]),
        ((76, 83, 79, 255), [(88, 96, 91, 255), (63, 70, 67, 255), (101, 105, 94, 255)])
    ]
    for i, (base, accents) in enumerate(palettes):
        tile = Image.new("RGBA", (32, 32), base)
        d = ImageDraw.Draw(tile)
        for _ in range(36):
            x, y = random.randrange(32), random.randrange(32)
            c = random.choice(accents)
            d.rectangle((x, y, x + random.choice([0, 1]), y), fill=c)
        if i == 2:
            d.line((0, 2, 31, 2), fill=(216, 208, 180, 255), width=1)
            d.line((0, 29, 31, 29), fill=(113, 117, 105, 255), width=1)
        if i == 3:
            for x in (5, 17, 27):
                d.point((x, 9), fill=(119, 123, 113, 255))
                d.point((x + 1, 22), fill=(47, 54, 51, 255))
        sheet.paste(tile, (i * 32, 0))
    sheet.save(ROOT / "tileset.png")


def draw_character(draw, frame, direction, ox, oy):
    # Cada frame ocupa 32x48; silhueta compacta, com contorno escuro.
    walk = [-1, 0, 1][frame]
    bob = 1 if frame == 1 else 0
    # sombra
    draw.ellipse((ox + 7, oy + 39 + bob, ox + 25, oy + 44 + bob),
                 fill=(25, 34, 28, 130))
    # pernas e botas
    leg_shift = walk * 2
    draw.rectangle((ox + 10, oy + 29 + bob, ox + 15 + leg_shift, oy + 39 + bob),
                   fill=(39, 52, 67, 255), outline=(24, 31, 39, 255))
    draw.rectangle((ox + 17 - leg_shift, oy + 29 + bob, ox + 22, oy + 39 + bob),
                   fill=(44, 59, 72, 255), outline=(24, 31, 39, 255))
    draw.rectangle((ox + 9, oy + 38 + bob, ox + 16 + leg_shift, oy + 41 + bob),
                   fill=(69, 48, 37, 255))
    draw.rectangle((ox + 16 - leg_shift, oy + 38 + bob, ox + 23, oy + 41 + bob),
                   fill=(69, 48, 37, 255))
    # tronco
    draw.rectangle((ox + 8, oy + 18 + bob, ox + 24, oy + 31 + bob),
                   fill=(65, 102, 123, 255), outline=(31, 48, 57, 255))
    draw.rectangle((ox + 10, oy + 20 + bob, ox + 22, oy + 28 + bob),
                   fill=(83, 130, 146, 255))
    # mochila
    draw.rectangle((ox + 5, oy + 21 + bob, ox + 9, oy + 29 + bob),
                   fill=(145, 91, 47, 255), outline=(66, 48, 33, 255))
    # braços
    draw.rectangle((ox + 5, oy + 20 + bob, ox + 8, oy + 29 + bob),
                   fill=(183, 125, 87, 255), outline=(79, 54, 42, 255))
    draw.rectangle((ox + 24, oy + 20 + bob, ox + 27, oy + 29 + bob),
                   fill=(183, 125, 87, 255), outline=(79, 54, 42, 255))
    # cabeça
    draw.rectangle((ox + 10, oy + 6 + bob, ox + 22, oy + 19 + bob),
                   fill=(195, 143, 105, 255), outline=(69, 47, 38, 255))
    # cabelo
    draw.rectangle((ox + 9, oy + 5 + bob, ox + 23, oy + 10 + bob),
                   fill=(54, 43, 35, 255))
    draw.point((ox + 10, oy + 12 + bob), fill=(54, 43, 35, 255))
    draw.point((ox + 22, oy + 12 + bob), fill=(54, 43, 35, 255))
    # rosto conforme direção
    if direction == "down":
        draw.point((ox + 13, oy + 14 + bob), fill=(38, 41, 39, 255))
        draw.point((ox + 19, oy + 14 + bob), fill=(38, 41, 39, 255))
    elif direction == "left":
        draw.point((ox + 11, oy + 14 + bob), fill=(38, 41, 39, 255))
        draw.rectangle((ox + 8, oy + 13 + bob, ox + 10, oy + 16 + bob),
                       fill=(195, 143, 105, 255))
    elif direction == "right":
        draw.point((ox + 21, oy + 14 + bob), fill=(38, 41, 39, 255))
        draw.rectangle((ox + 22, oy + 13 + bob, ox + 24, oy + 16 + bob),
                       fill=(195, 143, 105, 255))
    else:
        draw.rectangle((ox + 10, oy + 6 + bob, ox + 22, oy + 18 + bob),
                       fill=(54, 43, 35, 255))
        draw.rectangle((ox + 10, oy + 15 + bob, ox + 22, oy + 18 + bob),
                       fill=(54, 43, 35, 255))


def make_player():
    image = Image.new("RGBA", (96, 192), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    directions = ["down", "left", "right", "up"]
    for row, direction in enumerate(directions):
        for frame in range(3):
            draw_character(draw, frame, direction, frame * 32, row * 48)
    image.save(ROOT / "player.png")


if __name__ == "__main__":
    make_tileset()
    make_player()
    print(f"Tiles e sprites criados em: {ROOT}")
