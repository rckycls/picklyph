# Concept C brand assets

Editable vector adaptations of the user's Concept C reference boards: court
blue `#1E3F7C`, ball yellow `#D6F22E`, court green `#2E9A4B`, deep green
`#1B7A3C`, and line white `#FFFFFF`. The reference sheets are design guidance,
not images stretched into the interface.

- `mark`: blue paddle-pin with a yellow perforated ball, for light surfaces.
- `mark-white`: true transparent one-color mark, for dark surfaces.
- `mark-small`: simplified one-color mark for the Discover tab.
- `court-pin`: simplified blue/yellow mark with a white rim; selected colors
  invert. Checked-in 1x/2x/3x PNGs use a 32 × 48 logical size.
- `app-icon`: 1024 × 1024 opaque blue square with the yellow/blue paddle-pin.
  The operating system supplies rounded corners.

Headers use real text in Bricolage Grotesque ExtraBold with tight tracking;
supporting text uses Medium and control labels use SemiBold. Font files ship
locally through the pinned `@expo-google-fonts/bricolage-grotesque` package,
including its SIL Open Font License. There is no font-network request at runtime.

To regenerate PNGs, run `node scripts/generate-brand-assets.cjs` with Sharp
available locally. Alternatively set `PICKLY_BRAND_SHARP_MODULE` to an installed
Sharp module's absolute path. Sharp is a maintainer tool, not an app dependency.

Reload Metro for UI changes. A new EAS binary is required only to see the updated
home-screen icon. Native identifiers, URL scheme and hosted accounts remain
`picklyph`/`com.rckycls.picklyph`.
