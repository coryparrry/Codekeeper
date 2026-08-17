#!/usr/bin/env python3
"""Extract the selected Codekeeper raster logo and build practical assets."""

from base64 import b64encode
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "source" / "codekeeper-generated-lockup.png"
BRANCH_FIELD = ROOT / "source" / "codekeeper-branch-field-dark.png"
PNG = ROOT / "png"
SVG = ROOT / "svg"
COLLATERAL = ROOT / "collateral"

INK = (17, 24, 22, 255)
MINT = (78, 230, 168, 255)
MIST = (221, 231, 226, 255)
PAPER = (247, 249, 248, 255)
WHITE = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)
TAGLINE = "Control your own GitHub maintainer from one guided terminal."

FONT_CANDIDATES = (
    Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    Path("/Library/Fonts/Arial Bold.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
)
MONO_CANDIDATES = (
    Path("/System/Library/Fonts/SFNSMono.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
)


def luminance(pixel):
    red, green, blue = pixel[:3]
    return (299 * red + 587 * green + 114 * blue) // 1000


def extract_transparency(source):
    """Remove the baked checkerboard while retaining the source's dark texture."""
    rgb = source.convert("RGB")
    result = Image.new("RGBA", rgb.size, TRANSPARENT)
    output = []
    for pixel in rgb.get_flattened_data():
        light = luminance(pixel)
        if light >= 220:
            output.append(TRANSPARENT)
            continue
        alpha = max(0, min(255, round((245 - light) * 255 / 227)))
        if alpha < 12:
            output.append(TRANSPARENT)
        elif alpha >= 230:
            output.append((*pixel, 255))
        else:
            output.append((11, 20, 20, alpha))
    result.putdata(output)
    return result


def alpha_bbox(image, region=None):
    alpha = image.getchannel("A")
    if region is None:
        return alpha.getbbox()
    left, top, right, bottom = region
    box = alpha.crop(region).getbbox()
    if box is None:
        raise RuntimeError("No logo pixels were found in the requested region")
    return left + box[0], top + box[1], left + box[2], top + box[3]


def horizontal_content_runs(image):
    alpha = image.getchannel("A")
    occupied = [x for x in range(image.width) if alpha.crop((x, 0, x + 1, image.height)).getbbox()]
    runs = []
    for x in occupied:
        if not runs or x > runs[-1][-1] + 1:
            runs.append([])
        runs[-1].append(x)
    return [(run[0], run[-1] + 1) for run in runs]


def expand(box, padding, bounds):
    left, top, right, bottom = box
    width, height = bounds
    return max(0, left - padding), max(0, top - padding), min(width, right + padding), min(height, bottom + padding)


def square_crop(image, box, padding):
    left, top, right, bottom = box
    side = max(right - left, bottom - top) + 2 * padding
    centre_x = (left + right) / 2
    centre_y = (top + bottom) / 2
    crop = (
        round(centre_x - side / 2),
        round(centre_y - side / 2),
        round(centre_x + side / 2),
        round(centre_y + side / 2),
    )
    return image.crop(crop)


def recolour(image, colour):
    result = Image.new("RGBA", image.size, colour)
    result.putalpha(image.getchannel("A"))
    return result


def font_path(candidates):
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise RuntimeError("A supported font was not found")


def resize_width(image, width):
    height = round(image.height * width / image.width)
    return image.resize((width, height), Image.Resampling.LANCZOS)


def contain(image, size, background=TRANSPARENT, padding=0):
    width, height = size
    available = width - 2 * padding, height - 2 * padding
    scale = min(available[0] / image.width, available[1] / image.height)
    resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", size, background)
    position = ((width - resized.width) // 2, (height - resized.height) // 2)
    canvas.alpha_composite(resized, position)
    return canvas


def cover(image, size):
    width, height = size
    scale = max(width / image.width, height / image.height)
    resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    left = (resized.width - width) // 2
    top = (resized.height - height) // 2
    return resized.crop((left, top, left + width, top + height))


def place_width(canvas, asset, width, x, y):
    resized = resize_width(asset, width)
    canvas.alpha_composite(resized, (x, y))
    return resized.size


def draw_tagline(
    canvas,
    position,
    size,
    colour,
    mint_rule=True,
    font_candidates=MONO_CANDIDATES,
    max_width=None,
):
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(str(font_path(font_candidates)), size)
    if max_width is not None:
        while size > 12 and draw.textbbox((0, 0), TAGLINE, font=font)[2] > max_width:
            size -= 1
            font = ImageFont.truetype(str(font_path(font_candidates)), size)
    x, y = position
    if mint_rule:
        draw.rounded_rectangle((x, y, x + max(4, size // 5), y + round(size * 1.45)), radius=2, fill=MINT)
        x += round(size * 0.75)
    draw.text((x, y), TAGLINE, font=font, fill=colour, anchor="la")


def dark_background(size):
    field = Image.open(BRANCH_FIELD).convert("RGBA")
    canvas = cover(field, size)
    veil = Image.new("RGBA", size, (6, 14, 12, 40))
    return Image.alpha_composite(canvas, veil)


def light_background(size):
    width, height = size
    canvas = Image.new("RGBA", size, PAPER)
    overlay = Image.new("RGBA", size, TRANSPARENT)
    draw = ImageDraw.Draw(overlay)
    unit = max(1, round(min(width, height) / 420))
    quiet = (167, 190, 179, 74)
    faint = (177, 201, 190, 44)
    mint = (78, 230, 168, 165)

    draw.line(
        [(0, round(height * 0.18)), (round(width * 0.10), round(height * 0.18)),
         (round(width * 0.16), round(height * 0.08)), (round(width * 0.48), round(height * 0.08)),
         (round(width * 0.53), 0)],
        fill=quiet,
        width=unit,
        joint="curve",
    )
    draw.line(
        [(width, round(height * 0.72)), (round(width * 0.92), round(height * 0.72)),
         (round(width * 0.86), round(height * 0.82)), (round(width * 0.56), round(height * 0.82)),
         (round(width * 0.50), height)],
        fill=quiet,
        width=unit,
        joint="curve",
    )
    branch_x = round(width * 0.82)
    branch_y = round(height * 0.40)
    draw.line([(branch_x, round(height * 0.25)), (branch_x, round(height * 0.70))], fill=faint, width=unit)
    draw.line([(branch_x, branch_y), (round(width * 0.91), round(height * 0.29))], fill=mint, width=unit)
    draw.line([(branch_x, branch_y), (round(width * 0.91), round(height * 0.52))], fill=faint, width=unit)
    endpoint = max(5, unit * 4)
    for x, y, colour in (
        (round(width * 0.91), round(height * 0.29), mint),
        (round(width * 0.91), round(height * 0.52), quiet),
    ):
        draw.rectangle((x - endpoint, y - endpoint, x + endpoint, y + endpoint), fill=colour)
    return Image.alpha_composite(canvas, overlay)


def save_png(image, name):
    path = PNG / name
    image.save(path, optimize=True)
    return path


def svg_wrapper(image, name, title):
    encoded = b64encode(image_to_png_bytes(image)).decode("ascii")
    markup = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {image.width} {image.height}" '
        f'role="img" aria-label="{escape(title)}">\n'
        f'  <image width="{image.width}" height="{image.height}" '
        f'href="data:image/png;base64,{encoded}"/>\n'
        f'</svg>\n'
    )
    (SVG / name).write_text(markup, encoding="utf-8")


def image_to_png_bytes(image):
    from io import BytesIO

    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def save_icon(symbol):
    frames = []
    for size in (16, 32, 48, 64):
        frames.append(contain(recolour(symbol, INK), (size, size), PAPER, max(1, round(size * 0.06))))
    frames[-1].save(
        PNG / "favicon.ico",
        format="ICO",
        append_images=frames[:-1],
        sizes=[frame.size for frame in frames],
    )


def save_collateral(image, relative_path, *, indexed=False):
    path = COLLATERAL / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    opaque = image.convert("RGB")
    if indexed:
        opaque.quantize(colors=192, method=Image.Quantize.MAXCOVERAGE).save(path, optimize=True)
    else:
        opaque.save(path, optimize=True)
    return path


def build_collateral(lockup, symbol, wordmark):
    white_lockup = recolour(lockup, WHITE)
    ink_lockup = recolour(lockup, INK)
    white_symbol = recolour(symbol, WHITE)
    mint_symbol = recolour(symbol, MINT)
    white_wordmark = recolour(wordmark, WHITE)
    ink_wordmark = recolour(wordmark, INK)

    github = dark_background((1280, 640))
    placed = resize_width(white_lockup, 980)
    logo_x = 100
    github.alpha_composite(placed, (logo_x, 218))
    placed_runs = horizontal_content_runs(placed)
    tagline_x = logo_x + placed_runs[1][0]
    draw_tagline(
        github,
        (tagline_x, 466),
        28,
        WHITE,
        font_candidates=MONO_CANDIDATES,
        max_width=1280 - tagline_x - 80,
    )
    save_collateral(github, "github/github-social-preview-1280x640.png")

    readme = light_background((1600, 480))
    placed = resize_width(ink_lockup, 1040)
    readme.alpha_composite(placed, ((1600 - placed.width) // 2, 102))
    draw_tagline(readme, (528, 355), 20, INK)
    save_collateral(readme, "github/readme-banner-1600x480.png")

    social_landscape = dark_background((1200, 630))
    placed = resize_width(white_lockup, 900)
    social_landscape.alpha_composite(placed, (120, 225))
    draw_tagline(social_landscape, (124, 458), 20, WHITE)
    save_collateral(social_landscape, "social/social-landscape-dark-1200x630.png")

    social_square = dark_background((1080, 1080))
    icon = contain(mint_symbol, (610, 610), TRANSPARENT, 34)
    social_square.alpha_composite(icon, (235, 140))
    square_wordmark = resize_width(white_wordmark, 680)
    social_square.alpha_composite(square_wordmark, ((1080 - square_wordmark.width) // 2, 790))
    save_collateral(social_square, "social/social-square-dark-1080x1080.png")

    social_portrait = light_background((1080, 1350))
    icon = contain(recolour(symbol, INK), (600, 600), TRANSPARENT, 28)
    social_portrait.alpha_composite(icon, (240, 160))
    portrait_wordmark = resize_width(ink_wordmark, 760)
    social_portrait.alpha_composite(portrait_wordmark, ((1080 - portrait_wordmark.width) // 2, 820))
    draw_tagline(social_portrait, (211, 1070), 18, INK)
    save_collateral(social_portrait, "social/social-portrait-light-1080x1350.png")

    presentation_dark = dark_background((1920, 1080))
    placed = resize_width(white_lockup, 1260)
    presentation_dark.alpha_composite(placed, (170, 360))
    draw_tagline(presentation_dark, (180, 690), 28, WHITE)
    save_collateral(presentation_dark, "presentation/presentation-cover-dark-1920x1080.png")

    presentation_light = light_background((1920, 1080))
    placed = resize_width(ink_lockup, 1260)
    presentation_light.alpha_composite(placed, (170, 360))
    draw_tagline(presentation_light, (180, 690), 28, INK)
    save_collateral(presentation_light, "presentation/presentation-cover-light-1920x1080.png")

    wallpaper_dark = dark_background((2560, 1440))
    placed = resize_width(white_lockup, 760)
    wallpaper_dark.alpha_composite(placed, (140, 1120))
    save_collateral(wallpaper_dark, "wallpapers/codekeeper-wallpaper-dark-2560x1440.png")

    wallpaper_light = light_background((2560, 1440))
    placed = resize_width(ink_lockup, 760)
    wallpaper_light.alpha_composite(placed, (140, 1120))
    save_collateral(wallpaper_light, "wallpapers/codekeeper-wallpaper-light-2560x1440.png")

    save_collateral(dark_background((1920, 1080)), "backgrounds/branch-field-dark-1920x1080.png")
    save_collateral(light_background((1920, 1080)), "backgrounds/branch-field-light-1920x1080.png")

    meeting = dark_background((1920, 1080))
    placed = resize_width(white_lockup, 560)
    meeting.alpha_composite(placed, (90, 70))
    save_collateral(meeting, "video/meeting-background-dark-1920x1080.png")

    sheet = Image.new("RGBA", (1600, 1120), PAPER)
    draw = ImageDraw.Draw(sheet)
    title_font = ImageFont.truetype(str(font_path(FONT_CANDIDATES)), 44)
    label_font = ImageFont.truetype(str(font_path(MONO_CANDIDATES)), 18)
    draw.text((70, 55), "Codekeeper collateral kit", font=title_font, fill=INK)
    previews = [
        (github, "GitHub social preview"),
        (readme, "README banner"),
        (social_landscape, "Social landscape"),
        (social_square, "Social square"),
        (social_portrait, "Social portrait"),
        (presentation_dark, "Presentation cover, dark"),
        (presentation_light, "Presentation cover, light"),
        (wallpaper_dark, "Desktop wallpaper, dark"),
        (wallpaper_light, "Desktop wallpaper, light"),
    ]
    cell_width, cell_height = 460, 285
    for index, (preview, label) in enumerate(previews):
        column = index % 3
        row = index // 3
        x = 70 + column * 505
        y = 135 + row * 320
        thumb = contain(preview, (cell_width, cell_height), MIST, 4)
        sheet.alpha_composite(thumb, (x, y))
        draw.text((x, y + cell_height + 10), label, font=label_font, fill=INK)
    save_collateral(sheet, "codekeeper-collateral-contact-sheet-1600x1120.png")


def main():
    PNG.mkdir(parents=True, exist_ok=True)
    SVG.mkdir(parents=True, exist_ok=True)

    source = Image.open(SOURCE)
    transparent_canvas = extract_transparency(source)
    width, height = transparent_canvas.size

    lockup_box = alpha_bbox(transparent_canvas)
    symbol_box = alpha_bbox(transparent_canvas, (0, 0, round(width * 0.33), height))
    wordmark_box = alpha_bbox(transparent_canvas, (round(width * 0.33), 0, width, height))

    lockup = transparent_canvas.crop(expand(lockup_box, 48, transparent_canvas.size))
    symbol = square_crop(transparent_canvas, symbol_box, 28)
    wordmark = transparent_canvas.crop(expand(wordmark_box, 24, transparent_canvas.size))

    save_png(transparent_canvas, "codekeeper-lockup-transparent-original-canvas.png")
    save_png(lockup, "codekeeper-lockup-transparent-tight.png")
    save_png(resize_width(lockup, 1560), "codekeeper-lockup-1560w.png")
    save_png(resize_width(recolour(lockup, INK), 1560), "codekeeper-lockup-flat-ink-1560w.png")
    save_png(resize_width(recolour(lockup, WHITE), 1560), "codekeeper-lockup-reversed-1560w.png")
    save_png(wordmark, "codekeeper-wordmark-transparent.png")

    flat_symbol = recolour(symbol, INK)
    for size in (16, 24, 32, 64, 128, 256, 512):
        save_png(flat_symbol.resize((size, size), Image.Resampling.LANCZOS), f"codekeeper-symbol-{size}.png")

    save_png(contain(flat_symbol, (512, 512), PAPER, 56), "codekeeper-github-avatar-512.png")
    save_png(contain(recolour(symbol, MINT), (512, 512), INK, 56), "codekeeper-github-avatar-mint-512.png")
    save_png(contain(flat_symbol, (128, 128), PAPER, 8), "codekeeper-package-icon-128.png")
    save_png(contain(flat_symbol, (180, 180), PAPER, 12), "apple-touch-icon.png")
    save_png(contain(lockup, (1200, 630), PAPER, 90), "codekeeper-social-card-1200x630.png")
    save_icon(symbol)

    svg_wrapper(lockup, "codekeeper-lockup-exact.svg", "Codekeeper")
    svg_wrapper(recolour(lockup, INK), "codekeeper-lockup-flat-ink.svg", "Codekeeper")
    svg_wrapper(recolour(lockup, WHITE), "codekeeper-lockup-reversed.svg", "Codekeeper reversed")
    svg_wrapper(symbol, "codekeeper-symbol-exact.svg", "Codekeeper symbol")
    svg_wrapper(flat_symbol, "codekeeper-symbol-ink.svg", "Codekeeper symbol")
    svg_wrapper(recolour(symbol, MINT), "codekeeper-symbol-mint.svg", "Codekeeper symbol in Signal Mint")
    svg_wrapper(wordmark, "codekeeper-wordmark-exact.svg", "Codekeeper wordmark")
    svg_wrapper(contain(flat_symbol, (64, 64), PAPER, 4), "favicon.svg", "Codekeeper")
    build_collateral(lockup, symbol, wordmark)


if __name__ == "__main__":
    main()
