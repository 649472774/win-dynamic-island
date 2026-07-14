---
name: Windows Dynamic Island
description: Restrained top-center activity controls for Windows
colors:
  accent-blue: "#57A6FF"
  glass-base: "#121218B8"
  glass-strong: "#14141CDC"
  text-primary: "#FFFFFFF0"
  text-secondary: "#FFFFFF8C"
  text-faint: "#FFFFFF59"
  divider: "#FFFFFF12"
  success: "#56D88B"
  pomodoro: "#FF725E"
typography:
  title:
    fontFamily: "Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: "Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.2
rounded:
  control: "8px"
  row: "12px"
  pill: "19px"
  panel: "30px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.accent-blue}"
    textColor: "#06121F"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  button-ghost:
    backgroundColor: "#FFFFFF0F"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
  activity-row:
    backgroundColor: "#00000000"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.row}"
    padding: "14px 4px"
---

# Design System: Windows Dynamic Island

## Overview

**Creative North Star: "Quiet Instrument Panel"**

The island is a compact desktop instrument that stays out of the way until asked. Its dark translucent shell is inherited from the existing Win32 glass implementation; hierarchy comes from alignment, spacing, restrained accent use, and flat dividers rather than stacked cards.

Expansion reveals a calm overview before focused tools. The system explicitly rejects the rejected dense dashboard: nested cards, permanent forms, rows of equal-weight buttons, and management controls competing on the home surface.

**Key Characteristics:**
- Stable top-center geometry and tabular numeric readouts
- Flat activity rows with one obvious primary action
- Compact rail for direct activity switching
- Progressive disclosure for creation, configuration, and destructive actions
- Motion limited to 150–250ms state transitions, with reduced-motion alternatives

## Colors

The palette is a restrained near-black glass neutral with one cool blue accent and narrowly scoped semantic status colors.

### Primary
- **Signal Blue** (`#57A6FF`): current selection, primary action, and focus rings only.

### Secondary
- **Running Green** (`#56D88B`): active timer state.
- **Pomodoro Coral** (`#FF725E`): Pomodoro category identity, not general decoration.

### Neutral
- **Glass Base** (`#121218B8`): collapsed and hover shell.
- **Glass Strong** (`#14141CDC`): expanded shell.
- **Primary Ink** (`#FFFFFFF0`): names, times, and key actions.
- **Secondary Ink** (`#FFFFFF8C`): types and status.
- **Faint Ink** (`#FFFFFF59`): hints and low-priority metadata.
- **Hairline Divider** (`#FFFFFF12`): flat row separation.

### Named Rules
**The One Signal Rule.** Signal Blue occupies less than 10% of a surface and marks only selection, focus, or the single primary action.

## Typography

**Display Font:** Segoe UI (with Microsoft YaHei and system-ui fallback)
**Body Font:** Segoe UI (with Microsoft YaHei and system-ui fallback)

**Character:** Native, compact, and immediately legible. One Windows system family carries all roles; hierarchy comes from weight and contrast, not decorative pairing.

### Hierarchy
- **Headline** (700, 16px, 1.25): focused panel titles.
- **Title** (600–700, 13px, 1.25): activity names and compact primary labels.
- **Body** (400–600, 12px, 1.4): status, summaries, and controls.
- **Label** (600, 10px, 1.2): category and secondary metadata.
- **Numeric** (600–700, 13–20px, tabular): clocks, timers, and counts.

### Named Rules
**The Tabular Time Rule.** Every duration and clock uses tabular numerals and aligns to the same trailing edge within a list.

## Elevation

The native island shell owns elevation. Interior content is flat and uses tonal hover fills plus hairline dividers; nested shadows and raised cards are not part of the system.

### Shadow Vocabulary
- **Island Ambient** (`0 12px 40px rgba(0, 0, 0, 0.45)`): the outer island only.

### Named Rules
**The Flat Interior Rule.** Interior rows are never independently elevated. Hover may add a subtle neutral fill, but no card shadow.

## Components

### Buttons
- **Shape:** compact rounded rectangle (`8px`).
- **Primary:** Signal Blue, dark ink, `7px 12px`; one per activity row.
- **Hover / Focus:** neutral lift on hover; 2px Signal Blue focus-visible ring.
- **Secondary / Ghost:** transparent or `#FFFFFF0F`, secondary ink, progressively disclosed.

### Chips
- **Style:** compact rail targets use transparent backgrounds with semantic category color.
- **State:** selected receives a restrained tinted fill and short underline; inactive stays low contrast.

### Cards / Containers
- **Corner Style:** outer panel `30px`; summary entry and inline reveal `12px`.
- **Background:** transparent by default; subtle neutral tint only for hover or a disclosed form.
- **Shadow Strategy:** outer island only.
- **Border:** 1px hairlines and dividers.
- **Internal Padding:** 8/12/16px scale.

### Inputs / Fields
- **Style:** dark neutral fill, 1px neutral stroke, `8px` radius, visible label.
- **Focus:** Signal Blue border and 2px focus-visible ring.
- **Error / Disabled:** coral error copy; disabled controls retain legible text and reduce opacity.

### Navigation
- Expanded routes use a consistent back button, title, summary, rail, and contextual primary action. Escape and Back return to home; collapse always resets home.

### Dynamic Island Shell
- Collapsed remains `220x38`; hover remains `260x38` with fixed vertical baseline; expanded remains `520px` wide and content-measured. Region, glass, and drag-catcher geometry are architectural constraints.

## Do's and Don'ts

### Do:
- **Do** use flat full-width rows with `14px` vertical rhythm and `#FFFFFF12` dividers.
- **Do** keep exactly one primary action visible per activity.
- **Do** progressively reveal secondary actions, forms, laps, and Pomodoro settings.
- **Do** preserve WCAG AA contrast, focus-visible, reduced motion, and high-contrast fallback.

### Don't:
- **Don't** recreate the rejected dense dashboard: nested cards, permanent forms, rows of equal-weight buttons, or management controls competing on the home surface.
- **Don't** use side-stripe borders, gradient text, decorative glass cards, or multiple saturated accents.
- **Don't** change brand colors, native Region geometry, or glass behavior to solve content hierarchy.
- **Don't** use pin diamonds, Shift+click shortcuts, or hidden gestures for core navigation.
