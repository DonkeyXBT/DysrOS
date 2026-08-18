"""
Generates the application icon from the design's brand mark.

The mark is the one in the sidebar: a rounded square with the teal-to-blue
gradient and an R. Kept as a script rather than a checked-in binary so the icon
stays in step with the palette if that ever changes.

Run: python build/make-icon.py
"""
from PIL import Image, ImageDraw, ImageFont
import os

# Palette, matching src/renderer/theme.css.
TEAL = (110, 231, 212)
BLUE = (91, 140, 255)
INK = (11, 13, 18)

SIZES = [256, 128, 64, 48, 32, 16]
RENDER = 1024


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def diagonal_gradient(size: int, start, end) -> Image.Image:
    """A 140-degree gradient, approximated on the diagonal as the design does."""
    gradient = Image.new("RGB", (size, size))
    pixels = gradient.load()
    for y in range(size):
        for x in range(size):
            # 0 at top-left, 1 at bottom-right.
            t = (x + y) / (2 * (size - 1))
            pixels[x, y] = (
                round(start[0] + (end[0] - start[0]) * t),
                round(start[1] + (end[1] - start[1]) * t),
                round(start[2] + (end[2] - start[2]) * t),
            )
    return gradient


def load_font(px: int):
    # Plus Jakarta Sans is not installed system-wide; a heavy grotesque is the
    # closest thing Windows ships, and the glyph is a single letter.
    for name in ("segoeuib.ttf", "arialbd.ttf", "seguibl.ttf"):
        path = os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts", name)
        if os.path.exists(path):
            return ImageFont.truetype(path, px)
    return ImageFont.load_default()


def build() -> Image.Image:
    base = diagonal_gradient(RENDER, TEAL, BLUE).convert("RGBA")
    base.putalpha(rounded_mask(RENDER, radius=int(RENDER * 0.22)))

    draw = ImageDraw.Draw(base)
    font = load_font(int(RENDER * 0.60))
    box = draw.textbbox((0, 0), "R", font=font)
    draw.text(
        ((RENDER - (box[2] - box[0])) / 2 - box[0],
         (RENDER - (box[3] - box[1])) / 2 - box[1]),
        "R",
        font=font,
        fill=INK + (255,),
    )
    return base


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    icon = build()

    icon.resize((512, 512), Image.LANCZOS).save(os.path.join(here, "icon.png"))
    icon.save(
        os.path.join(here, "icon.ico"),
        format="ICO",
        sizes=[(s, s) for s in SIZES],
    )
    print("wrote build/icon.ico and build/icon.png")


if __name__ == "__main__":
    main()
