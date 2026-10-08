# Profile details, photo and preferences (2026-10-08)

The Account tab shows a profile for every signed-in account, in both Player and Owner mode:

- **Hero:** profile photo (or the pickleball with initials), name, masked email, chips. **Edit** opens **Edit profile**.
- **Personal details:** first name, last name, mobile number and email. Mobile number and email are masked (`r******@gmail.com`, `+63 *** *** **67`) with an eye button to show or hide each; the email in the hero follows the email's eye. Tapping a detail opens **Edit profile**. Email is read-only. The old "Signed in with" row is gone.
- **Settings:** **Preferences** (`/preferences`) and **Location access** (current permission; opens iPhone Settings). Guests see the same Settings group.

Name shown in the hero: display name, else first + last name, else a guess from the email.

## Data (`20261008180000_profile_details.sql`)

- `public.profiles` gains `first_name`, `last_name` (trimmed, 1–50 characters, no control characters), `phone` (Philippine mobile, `+639XXXXXXXXX`) and `avatar_path`. The app accepts `0917 123 4567`, `9171234567`, `+63 917…` and normalizes. Column grants let `authenticated` update only these plus `display_name`, on their own row (T08 RLS). Nothing new is exposed to reviewers, owners or other players: `ownership_submitter` still returns `display_name` only.
- Profile photos live in the private `avatars` bucket (5 MiB, JPEG/PNG) as `<user id>/<uuid>.jpg|png`. Storage policies let a signed-in user insert, read (signed links) and delete objects in **their own folder only**; `avatar_path` must point into the same folder. The app uploads a new object, points the profile at it, then deletes the previous one (or deletes the new upload if the profile update fails).
- Photos come from the system picker (square crop, quality 0.7, `exif: false`, HEIC delivered as JPEG). They are not re-encoded, so leftover metadata is possible, but only the uploader can read the file.
- **T47 must delete `avatars/<user id>/` on account deletion**; storage objects don't cascade from `auth.users`.

## Preferences

Stored on the phone only (AsyncStorage `pickly.discover.view.v1`): whether Discover opens on the map or the list. It applies the next time pickly starts, unless the player has already switched views. Location access is read with `readForegroundPermission` (never prompts) on focus and on return from Settings.

## Verification

```powershell
npm run test:account          # masking, phone normalization, names, photo checks
npm run test:directory        # includes profile.test.cjs (PGlite)
npm run test:profile:local    # Docker profile.sql + real Auth/PostgREST/Storage via the local stack
```

`test:profile:local` creates two throwaway accounts, checks own-only details, refuses an invalid phone, uploads/signs/fetches/removes a photo, and confirms another account and a guest cannot read, sign, list, upload into or delete it. It removes its accounts and photos.

Rollout: apply the migration to staging (`supabase db push`), then reload Metro. No new native module: `expo-image-picker` and AsyncStorage were already in the build.
