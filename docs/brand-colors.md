# Pickly · Concept C

Use the user's Concept C reference boards, which supersede the original
photograph palette. The lowercase wordmark is Bricolage Grotesque ExtraBold
with tight tracking; the tagline is **Find a court. Run a court.** in Medium.
Control labels use SemiBold. Static font files are bundled locally through
Expo Font, which was already present in the development binary.

| Color | Hex | Use |
| --- | --- | --- |
| Court blue | `#1E3F7C` | Wordmark, primary buttons, headings, court pins |
| Ball yellow | `#D6F22E` | Location action, selected navigation and pins |
| Court green | `#2E9A4B` | Court artwork and decorative accents |
| Deep green | `#1B7A3C` | Tagline, success text and status accents |
| Line white | `#FFFFFF` | Cards, sheets, navigation, labels on blue |

Import semantic tokens from `src/theme/colors.ts` instead of adding hex values
to individual components. Import font aliases from `src/theme/typography.ts`.
Supporting neutral/error shades preserve readable controls and status messages.

## Application

- Use a light interface: white cards and bottom sheets over a mist background.
- Use court blue for the main action, with white labels.
- Use ball yellow for featured actions and selection, with court-blue labels.
- Use court green decoratively. Dark ink is its readable foreground; deep green
  supports status text on light backgrounds.
- Keep Google Maps' standard roads and geographic features readable; apply
  these colors to the app's controls, court markers, and overlays.
- Players and owners share this palette. Distinguish their modes with labels
  and navigation rather than different brand colors.
- Pair booking statuses with text or icons so color is never the only cue.
- Keep muted red for errors and destructive actions, rather than using yellow or
  green to signal a problem.

Text/foreground pairings target at least 4.5:1 contrast. The pale border is a
decorative separator, not the sole indication of an interactive control.

The paddle-pin mark has a yellow ball with seven blue holes on light surfaces,
a transparent white one-color variant on dark surfaces, and simplified small
versions. Map pins use a white rim and invert blue/yellow when selected.
See `assets/brand/README.md` for SVG masters, PNG resolutions and regeneration.
The new opaque 1024px app icon is configured for the next native build; reload
Metro to see the UI immediately. The existing identifiers and auth setup remain.

Palette preview: `docs/color-palette.svg`.
