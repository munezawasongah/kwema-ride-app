#!/usr/bin/env python3
"""Generates the Kwema Ride mark in every size the web and apps need.

The mark: a K whose upper arm runs to a marigold waypoint. It reads as the
initial and as a journey ending somewhere — which is the whole product. Drawn
programmatically rather than stored as binaries so the brand can be retuned in
one place and regenerated, and so the shapes stay exact at every size instead
of being resampled from a single export.

Run: python3 tool/generate_brand.py
"""

from pathlib import Path
from PIL import Image, ImageDraw

TANZANITE_TOP = (58, 75, 184)    # #3A4BB8
TANZANITE_BOT = (28, 37, 87)     # #1C2557
MARIGOLD = (227, 155, 31)        # #E39B1F
WHITE = (255, 255, 255)

ROOT = Path(__file__).resolve().parent.parent
SUPERSAMPLE = 4


def _rounded_mask(size: int, radius: int) -> Image.Image:
    """Anti-aliased rounded-square mask, drawn large and downsampled."""
    big = Image.new('L', (size * SUPERSAMPLE, size * SUPERSAMPLE), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        [0, 0, size * SUPERSAMPLE - 1, size * SUPERSAMPLE - 1],
        radius=radius * SUPERSAMPLE, fill=255)
    return big.resize((size, size), Image.LANCZOS)


def render(size: int = 1024, rounded: bool = True) -> Image.Image:
    S = size * SUPERSAMPLE

    # Vertical gradient. Flat colour looked inert at large sizes; the shift
    # from tanzanite to its darker tone gives the tile depth without a
    # decorative wash.
    column = Image.new('RGB', (1, S))
    for y in range(S):
        t = y / (S - 1)
        column.putpixel((0, y), tuple(
            int(TANZANITE_TOP[i] + (TANZANITE_BOT[i] - TANZANITE_TOP[i]) * t)
            for i in range(3)))
    img = column.resize((S, S))
    d = ImageDraw.Draw(img)

    stroke = int(S * 0.095)
    half = stroke // 2
    x0 = int(S * 0.33)
    top, bottom, middle = int(S * 0.27), int(S * 0.73), int(S * 0.50)

    # Upright: the road.
    d.line([(x0, top), (x0, bottom)], fill=WHITE, width=stroke)
    d.ellipse([x0 - half, top - half, x0 + half, top + half], fill=WHITE)
    d.ellipse([x0 - half, bottom - half, x0 + half, bottom + half], fill=WHITE)

    arm_up = (int(S * 0.68), int(S * 0.29))
    arm_down = (int(S * 0.70), int(S * 0.73))
    d.line([(x0, middle), arm_up], fill=WHITE, width=stroke)
    d.line([(x0, middle), arm_down], fill=WHITE, width=stroke)
    d.ellipse([arm_down[0] - half, arm_down[1] - half,
               arm_down[0] + half, arm_down[1] + half], fill=WHITE)

    # The waypoint. Marigold is reserved for money in the product UI, but here
    # it marks the destination — the one warm point the eye lands on.
    r = int(S * 0.085)
    d.ellipse([arm_up[0] - r, arm_up[1] - r, arm_up[0] + r, arm_up[1] + r],
              fill=MARIGOLD)

    img = img.resize((size, size), Image.LANCZOS)
    if not rounded:
        return img.convert('RGBA')

    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), _rounded_mask(size, int(size * 0.22)))
    return out


def main() -> None:
    brand = ROOT / 'public' / 'brand'
    brand.mkdir(parents=True, exist_ok=True)

    # Web. 16 and 32 for the tab, 180 for iOS home screen, 192/512 for
    # installable web app manifests.
    for size in (16, 32, 48, 180, 192, 512):
        render(size).save(brand / f'icon-{size}.png')

    # Multi-resolution .ico so older browsers and Windows pin correctly.
    render(64).save(brand / 'favicon.ico',
                    sizes=[(16, 16), (32, 32), (48, 48)])

    # Flutter launcher icon source. Square, unrounded: Android and iOS apply
    # their own mask, and pre-rounding produces a visible double corner.
    icon_dir = ROOT / 'mobile' / 'assets' / 'icon'
    icon_dir.mkdir(parents=True, exist_ok=True)
    render(1024, rounded=False).save(icon_dir / 'icon.png')

    # Adaptive-icon foreground for Android: the launcher crops heavily, so the
    # mark sits in the safe centre with generous padding.
    fg = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    inner = render(620, rounded=False)
    fg.paste(inner, (202, 202))
    fg.save(icon_dir / 'icon_foreground.png')

    print('brand assets written to public/brand and mobile/assets/icon')


if __name__ == '__main__':
    main()
