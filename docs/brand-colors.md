# PicklyPH colors

Use the user's pickleball court photograph as the app's color reference. The
palette follows the blue and green court, lime ball, navy shadows, and white
court lines. These are curated flat UI colors; supporting shades improve
readability rather than reproducing the photograph's lighting.

| Color | Hex | Use |
| --- | --- | --- |
| Court blue | `#466E9E` | Primary buttons, links, court pins, active controls |
| Court green | `#4EA473` | Secondary accents and decorative details |
| Ball lime | `#E5FC35` | Featured booking actions and selected court pins |
| Deep navy | `#14264D` | Headings, body text, icons, text on lime |
| White | `#FFFFFF` | Cards, sheets, navigation, text on blue buttons |

Import semantic tokens from `src/theme/colors.ts` instead of adding hex values
to individual components. The app has not been scaffolded yet; these tokens are
ready for the future React Native screens.

## Application

- Use a light interface: white cards and bottom sheets over a mist background.
- Use court blue for the main action, with white labels.
- Use lime sparingly for featured actions and selection, with navy labels.
- Use court green as an accent, with navy labels; use the darker success green
  for status text and open-play pins.
- Keep Google Maps' standard roads and geographic features readable; apply
  these colors to the app's controls, court markers, and overlays.
- Players and owners share this palette. Distinguish their modes with labels
  and navigation rather than different brand colors.
- Pair booking statuses with text or icons so color is never the only cue.
- Keep muted red for errors and destructive actions, rather than using lime or
  green to signal a problem.

Text/foreground pairings target at least 4.5:1 contrast. The pale border is a
decorative separator, not the sole indication of an interactive control.

Palette preview: `docs/color-palette.svg`.
