"""Génère les icônes de la PWA (usage ponctuel, pas partie du runtime de l'app).
Exécuter une fois : python3 tests/gen_icons.py
"""
from PIL import Image, ImageDraw

BLUE = (37, 99, 235, 255)
WHITE = (255, 255, 255, 255)


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_icon(size, path, maskable_padding_ratio=0.0):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = int(size * maskable_padding_ratio)
    bg_box = [pad, pad, size - pad, size - pad]
    rounded_rect(draw, bg_box, radius=int(size * 0.22), fill=BLUE)

    # "Page" de calendrier, centrée.
    m = size * 0.24
    page_box = [m + pad * 0, m, size - m, size - m * 0.7]
    rounded_rect(draw, page_box, radius=int(size * 0.06), fill=WHITE)

    # Barre du haut (reliure du calendrier).
    bar_h = size * 0.10
    draw.rectangle([page_box[0], page_box[1], page_box[2], page_box[1] + bar_h], fill=BLUE)

    # Quelques "jours" (petits carrés) sous la barre.
    grid_top = page_box[1] + bar_h + size * 0.06
    cell = size * 0.09
    gap = size * 0.05
    start_x = page_box[0] + size * 0.06
    for row in range(2):
        for col in range(3):
            x = start_x + col * (cell + gap)
            y = grid_top + row * (cell + gap)
            draw.rounded_rectangle([x, y, x + cell, y + cell], radius=int(cell * 0.3), fill=BLUE)

    img.save(path)
    print("écrit", path)


make_icon(192, "icons/icon-192.png")
make_icon(512, "icons/icon-512.png")
make_icon(512, "icons/icon-512-maskable.png", maskable_padding_ratio=0.1)
make_icon(180, "icons/apple-touch-icon.png")
