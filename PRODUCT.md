# Product

## Register

product

## Users

Windows productivity users who need glanceable, non-interruptive feedback while remaining focused in another application.

## Product Purpose

Provide a restrained top-center event and short-status layer for trustworthy lifecycle changes outside the user's current task. Notices should be understood at a glance, require at most one low-emphasis escape action, and restore the prior island content automatically.

## Brand Personality

Restrained, precise, lightweight. Native-feeling rather than decorative, calm rather than attention-seeking.

## Anti-references

Dense control panels, nested cards, duplicate Windows settings, device-management dashboards, persistent histories, and speculative system state.

## Design Principles

- Show only trustworthy events with a clear lifecycle.
- Preempt briefly, then restore the user's prior context.
- Prefer transient lifecycle notices over persistent status, controls, or configuration.
- Make degraded and unknown states explicit; never fabricate certainty.
- Preserve focus, privacy, and near-zero idle cost.
- Cover paired external Bluetooth devices across classic and low-energy
  AssociationEndpoints, including audio, mouse, keyboard, pen, gamepad, phone,
  wearable, and a truthful generic fallback.
- Never infer a connection from activity or invent battery data; unknown remains
  explicit and short HID sleep/wake changes are debounced.
- Bluetooth never appears as a persistent expanded-home module, summary, count,
  recent-device row, or placeholder when no event is active.

## Accessibility & Inclusion

WCAG 2.2 AA. Keyboard and focus-visible support, non-color state cues, readable overflow handling, reduced-motion behavior, and usable forced-colors fallbacks are required.
