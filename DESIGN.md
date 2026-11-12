# Design System — re-minimeter

A desktop audio visual analyzer for Windows. The look is a dark, instrument-like
surface in the spirit of compact system-audio analyzers and broadcast loudness
meters: near-black panels, thin hairline grids, a single cool accent for signal,
a warm accent for peaks/alerts, and large numeric readouts. This file follows the
awesome-design-md DESIGN.md structure. Every UI change reads this file first.

## 1. Visual Theme & Atmosphere

- **Mood:** quiet, technical, always-on. The signal is the brightest thing on
  screen; chrome stays recessive.
- **Density:** high. Modules are tiles that fill the window with 6px gutters.
  No decorative whitespace, no cards-within-cards.
- **Surfaces:** flat. Depth comes from one hairline border and a slightly
  lighter title strip, never from drop shadows.
- **Motion:** only the data moves. Meters decay smoothly (~20 dB/s release),
  peak-hold lines linger ~1.5 s, spectrogram scrolls at a constant rate. UI
  transitions are ≤120 ms and only for hover/pressed states.

## 2. Color Palette & Roles

| Role | Token | Hex | Use |
| --- | --- | --- | --- |
| Window background | `--bg-0` | `#0e0f12` | behind all tiles |
| Tile background | `--bg-1` | `#16181c` | module body |
| Title strip / toolbar | `--bg-2` | `#1d2025` | module header, top bar, status bar |
| Raised control | `--bg-3` | `#262a31` | buttons, selects, panel popovers |
| Hairline | `--line` | `#2b2f36` | tile borders, grid lines (use at 100%) |
| Grid minor | `--grid` | `#23262c` | dB / frequency grid inside plots |
| Text primary | `--fg-0` | `#e6e8ec` | readouts, labels |
| Text secondary | `--fg-1` | `#9aa1ab` | axis labels, units, titles |
| Text muted | `--fg-2` | `#5f6671` | disabled, hints |
| Signal accent | `--sig` | `#2eddc4` | spectrum line/fill, scope trace, level bars, momentary loudness |
| Signal secondary | `--sig-2` | `#5b8cff` | right channel / short-term loudness / second trace |
| Peak / warm | `--peak` | `#ff9843` | peak-hold markers, true-peak readout near 0, integrated loudness |
| Danger | `--clip` | `#ff4d5e` | clip indicator, over-target, errors |
| Target line | `--target` | `#f2d16b` | loudness target reference (-14 / -23 LUFS) |
| Spectrogram map | `--map-*` | `#0e0f12 → #1b2a6b → #2eddc4 → #f2f5a0` | 4-stop ramp, dark → cool → signal → hot |

Rules: exactly one cool signal accent per trace family; the warm accent is only
for peaks, holds and integrated values; red is only for clipping or exceeding a
target. Never tint the background.

## 3. Typography Rules

Font stack: `"Inter", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif`.
Numbers use tabular figures (`font-variant-numeric: tabular-nums`) everywhere.

| Style | Size | Weight | Tracking | Use |
| --- | --- | --- | --- | --- |
| Readout XL | 40px | 600 | -0.02em | integrated / short-term LUFS hero value |
| Readout L | 24px | 600 | -0.01em | momentary, true peak, LRA |
| Readout M | 15px | 500 | 0 | level meter numbers, correlation |
| Title | 11px | 600 | +0.08em, uppercase | module titles, toolbar sections |
| Label | 11px | 400 | 0 | axis labels, units |
| Caption | 10px | 400 | 0 | status bar, hints |

Units (`LUFS`, `dB`, `Hz`, `LU`) are Label style in `--fg-1`, set 4px after the
number, never bold.

## 4. Component Stylings

- **Module tile:** `--bg-1` body, 1px `--line` border, 4px radius. Header strip
  24px tall in `--bg-2` with Title text in `--fg-1`, a drag handle on the left
  (edit mode only) and small icon buttons on the right (settings, close). Body
  is a single `<canvas>` filling the rest.
- **Toolbar (top, 36px):** `--bg-2`, hairline bottom. Left: app name (Title
  style, `--fg-0`). Middle: device select. Right: module toggles, layout
  lock/edit, reset.
- **Status bar (bottom, 22px):** `--bg-2`, Caption text: device · sample rate ·
  fps · capture state.
- **Buttons:** 26px tall, `--bg-3`, 1px `--line`, 4px radius, Label text
  `--fg-0`. Hover: border `--fg-2`. Active/toggled: background `--sig` at 18%
  alpha, text `--sig`. Icon buttons are 22×22, no border until hover.
- **Select:** same as button with a 10px chevron; options panel is `--bg-3`
  with 1px `--line`.
- **Checkbox list (module toggles):** 12px box, `--sig` fill when on.
- **Meter bars:** 10px wide, `--sig` fill from bottom; the top 3 dB zone of
  the scale is `--clip` when exceeded; peak-hold is a 2px `--peak` line.
- **Readout block (loudness):** label above (Title style), value (Readout XL/L)
  below, unit after. Blocks sit on a 2-column grid inside the tile.
- **Resize handle (edit mode):** 10×10 triangle at bottom-right in `--fg-2`.
- **Drop target highlight (edit mode):** dashed 1px `--sig` outline on the
  grid cells the dragged tile would occupy.

## 5. Layout Principles

- Base unit 4px. Gutter between tiles 6px. Window padding 6px.
- Layout grid: 24 columns × 16 rows over the content area. Tiles snap to
  whole cells; minimum tile 4×3 cells.
- Plot padding inside a canvas: 8px top/right, 28px bottom for frequency
  labels, 34px left for dB labels (0 when the module hides axes).
- Default arrangement (24×16): Spectrum 16×8 top-left; Loudness 8×8 top-right;
  Spectrogram 12×8 bottom-left; Stereo 6×8 bottom-middle; Levels 3×8 and
  Oscilloscope 3×8 bottom-right (Oscilloscope spans 6×4 over Levels by default).
- Radii: tiles 4px, controls 4px, popovers 6px. Nothing larger.

## 6. Depth & Elevation

| Level | Where | Treatment |
| --- | --- | --- |
| 0 | window | `--bg-0` |
| 1 | tiles | `--bg-1` + 1px `--line` |
| 2 | headers, bars | `--bg-2` |
| 3 | popovers, menus | `--bg-3` + 1px `--line` + `0 8px 24px rgba(0,0,0,.5)` (the only shadow) |

No inset shadows, no gradients on chrome. Gradients exist only inside plots
(spectrum fill fades from `--sig` 45% to 0%).

## 7. Do's and Don'ts

Do: keep the signal the brightest element; use hairlines for all grids; keep
numbers tabular; label every axis with units once; let modules be removed
without leaving holes (grid reflow is manual, holes are allowed but never
rendered as cards).

Don't: use pure white (`#fff`) anywhere; use more than two accents in one
module; animate chrome; put text over the spectrogram; use rounded corners
above 6px; use a light theme (not supported in v1).

## 8. Responsive Behavior

| Window width | Behavior |
| --- | --- |
| ≥ 1280 | default grid, all labels |
| 900–1279 | axis label font stays 11px, loudness readouts drop to Readout L |
| 640–899 | module headers collapse to icon-only, status bar hides sample rate |
| < 640 | not supported; window minimum is 640×400 |

Canvases always render at `devicePixelRatio`. Labels never scale below 10px.

## 9. Agent Prompt Guide

Quick colors: bg `#0e0f12/#16181c/#1d2025/#262a31`, line `#2b2f36`, text
`#e6e8ec/#9aa1ab/#5f6671`, signal `#2eddc4`, second `#5b8cff`, peak `#ff9843`,
clip `#ff4d5e`, target `#f2d16b`.

Component prompt examples:
- "Add a module tile titled 'Correlation' with a horizontal bar from -1 to +1,
  `--sig` fill right of center and `--clip` left of center, Readout M number
  centered above the bar."
- "Add a toolbar toggle button 'Edit layout' that uses the toggled style when
  active."

Repeating work: every new module = `Module` interface in `src/modules/` with
`draw(ctx, frame, size)`, registered in `src/modules/index.ts`, default size
and position added to `src/layout/defaults.ts`, colors read from CSS tokens
via `theme()` — never hard-code hex in TypeScript.
