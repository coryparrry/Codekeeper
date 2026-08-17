# Codekeeper logo assets

These assets are derived directly from `source/codekeeper-generated-lockup.png`, the selected Codekeeper logo image.

## Use these files

| Use | File |
|---|---|
| Exact transparent lockup | `png/codekeeper-lockup-transparent-tight.png` |
| Original-canvas transparent lockup | `png/codekeeper-lockup-transparent-original-canvas.png` |
| Standalone symbol | `png/codekeeper-symbol-512.png` |
| Exact wordmark | `png/codekeeper-wordmark-transparent.png` |
| Dark-background lockup | `png/codekeeper-lockup-reversed-1560w.png` |
| GitHub avatar | `png/codekeeper-github-avatar-512.png` |
| npm/package icon | `png/codekeeper-package-icon-128.png` |
| Browser favicon | `png/favicon.ico` or `svg/favicon.svg` |
| Social preview | `png/codekeeper-social-card-1200x630.png` |

## Extended collateral

| Use | File |
|---|---|
| GitHub repository social preview | `collateral/github/github-social-preview-1280x640.png` |
| README header | `collateral/github/readme-banner-1600x480.png` |
| Social landscape | `collateral/social/social-landscape-dark-1200x630.png` |
| Social square | `collateral/social/social-square-dark-1080x1080.png` |
| Social portrait | `collateral/social/social-portrait-light-1080x1350.png` |
| Presentation cover, dark | `collateral/presentation/presentation-cover-dark-1920x1080.png` |
| Presentation cover, light | `collateral/presentation/presentation-cover-light-1920x1080.png` |
| Desktop wallpaper, dark | `collateral/wallpapers/codekeeper-wallpaper-dark-2560x1440.png` |
| Desktop wallpaper, light | `collateral/wallpapers/codekeeper-wallpaper-light-2560x1440.png` |
| Plain dark background | `collateral/backgrounds/branch-field-dark-1920x1080.png` |
| Plain light background | `collateral/backgrounds/branch-field-light-1920x1080.png` |
| Video-call background | `collateral/video/meeting-background-dark-1920x1080.png` |
| Collateral overview | `collateral/codekeeper-collateral-contact-sheet-1600x1120.png` |

The GitHub social preview is 1280 × 640 px with an opaque background and is exported below GitHub's 1 MB upload limit.

The primary transparent PNG retains the subtle dark texture of the selected source. Flat Keeper Ink, mint, and reversed variants use the exact extracted silhouette with solid colour.

The supporting tagline is **“Control your own GitHub maintainer from one guided terminal.”** It leads with adopter ownership and the guided installation experience.

## Important source limitation

The selected source is a raster PNG with a checkerboard baked into its pixels. It does not contain transparency, font data, or vector paths. The checkerboard has been removed with a deterministic alpha mask.

The supplied SVG files embed the high-resolution extracted PNG so that they preserve the selected letterforms exactly. They are convenient SVG containers, but they are not editable vector outlines. A genuine vector master must be redrawn and approved separately; automatic tracing would alter the typography and geometry.

## Colours

- Keeper Ink: `#111816`
- Signal Mint: `#4EE6A8`
- Repository Mist: `#DDE7E2`
- Paper: `#F7F9F8`

## Regeneration

Run:

```sh
python3 brand/scripts/build-assets.py
```

The script reads the committed source images and regenerates `brand/png/`, `brand/svg/`, and `brand/collateral/`.
