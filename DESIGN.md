# Design System

## Theme

Native Windows dark glass: a compact top-center capsule on a transparent canvas. The island is an event layer, not a page, card stack, or dashboard.

## Color

- Glass surfaces: existing `--glass-bg` and `--glass-bg-strong`.
- Borders/highlights: existing `--glass-border` and `--glass-highlight`.
- Primary text: existing `--text`; secondary and quiet text use `--text-dim` and `--text-faint`.
- Accent: existing `--accent` / `--accent-soft`.
- Semantic states add restrained success, disconnect, warning, and error tokens. Every state also carries an icon and explicit text.
- Native-glass and opaque fallback modes remain first-class. Forced colors uses system colors and visible outlines.

## Typography

Use the existing `"Segoe UI", "Microsoft YaHei", system-ui` stack. Product UI uses fixed rem sizes, 600–700 weights for compact labels/readouts, tabular numerals for percentages, and single-line ellipsis for device names. Do not introduce display fonts.

## Shape and Layout

- Preserve the 220×38 collapsed, 260×38 hover, 300×46 transient HUD, and 520px expanded geometry vocabulary.
- Use 4px-derived spacing, tight 8–12px notice groupings, and the existing radii.
- Bluetooth is rendered only as a compact transient icon/text/battery notice.
  Expanded home contains no Bluetooth row, summary, count, placeholder, or gap.
- Never add nested cards, device lists, management controls, or connection history.

## Components

- **Notice pill:** monochrome inline SVG icon, privacy-safe device label, explicit state, optional battery, optional single dismiss action.
- **Settings rows:** existing switch vocabulary for notifications, battery visibility, and device-name privacy.
- **Windows escape action:** one low-emphasis Settings-only action; never place it
  on expanded home or inside a device-management surface.
- Interactive states cover default, hover, focus-visible, active, disabled, loading/degraded, and error.

## Motion

Use 150–250ms purposeful state morphs with ease-out-quart/quint curves, no bounce. Content crossfades while the capsule morphs. Reduced motion removes spatial movement; forced colors removes translucent material dependence.

## Iconography

Use one coherent monochrome inline-SVG vocabulary for audio, mouse, keyboard,
pen, gamepad, phone, wearable, generic Bluetooth, and semantic states. Privacy
aliases retain the category while hiding the public device name. Do not mix emoji
inside the same M7 notice or status component.
