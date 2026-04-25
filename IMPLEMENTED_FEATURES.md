# GreenHouse App - Implemented Features (Current State)

This document summarizes what has already been implemented in the project.

## Tech Stack and Base Setup

- Next.js app (App Router) with TypeScript.
- Supabase (PostgreSQL + Storage); **browser no longer queries tables directly**.
- Typed client API wrapper: `src/lib/api.ts` (calls `POST /api/secure`, `POST /api/rooms/upload`, `POST /api/plants/upload`, and `POST /api/plants/analyze`). Secure actions include household list/create/set-active/`deleteHousehold`/`renameHousehold`, room create/`renameRoom`/`deleteRoom`, and existing room/plant flows (see `SecureAction` in `src/app/api/secure/route.ts`).
- Server-side Supabase admin client: `src/lib/server/supabaseAdmin.ts` (service role, lazy init).
- Telegram auth helper: `src/lib/server/telegramAuth.ts` (`initData` HMAC verification; optional local dev mode).
- Environment variables (see also `.env.example`):
  - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY` (server only)
  - `TELEGRAM_BOT_TOKEN` (production / real Mini App)
  - `GEMINI_API_KEY` (Google AI Studio, optional; enables AI plant detection on photo upload)
  - Optional local browser debug: `DEV_BROWSER_MODE=true`, `DEV_TELEGRAM_ID` (only with `npm run dev`)
- `src/lib/supabase.ts` remains for potential non-UI use; **main UI does not use it for data access**.
- Current lint baseline is clean (`npm run lint` passes).
- Git repository initialized for the project.

## Stage 1 - Foundation

- Telegram Mini App integration in `src/app/page.tsx`.
- Telegram SDK script in `src/app/layout.tsx`:
  - `https://telegram.org/js/telegram-web-app.js`
- Bootstrap flow:
  - Reads `window.Telegram?.WebApp?.initData` (signed string) and passes it to the server on every secure request via header `x-telegram-init-data`.
  - **`telegramInitDataRef`** keeps `initData` in sync immediately so the first `listRooms` after bootstrap does not race React state (avoids missing header).
  - Username still read from `initDataUnsafe.user` when present (display/bootstrap hint only).
- Server validates `initData` with `TELEGRAM_BOT_TOKEN` and resolves Telegram user id before any DB work.
- **Overview screen debug line** (for troubleshooting): shows whether WebApp object exists, whether `initData` is present, and Telegram-like user agent.
- Optional secure API logging on failures: `src/app/api/secure/route.ts` logs `action`, `hasInitDataHeader`, `isTelegramUserAgent`, etc. (no `initData` body in logs).

## Stage 2 - Households

- Household bootstrap and join are done through RPC (`api_bootstrap_user`, `api_join_household`) invoked from `/api/secure`.
- Invite codes are generated server-side in SQL where applicable.
- Join-home in UI:
  - Homes section shows invite code with **copy to clipboard** action.
  - User can join another home via invite code modal (`Join with code`).
  - **Multi-household** (after `multi_household_delete_room.sql` on Supabase):
    - `profiles.active_household_id` — which household drives `listRooms` and other room/plant RPCs.
    - `api_list_households`, `api_create_household`, `api_set_active_household`; `api_join_household` **adds** membership and sets the joined home active (user can belong to several homes).
    - Legacy unique-on-`user_id` alone on `household_members` must be dropped in favor of `UNIQUE (household_id, user_id)` (script attempts common constraint/index names, including `household_members_user_id_unique`).
    - `INSERT ... ON CONFLICT` in PL/pgSQL uses **dynamic `EXECUTE ... USING`** where needed so `RETURNS TABLE (household_id, ...)` output names do not shadow column names.
    - UI: card-style **home picker** (horizontal scroll when multiple homes), **Create new home** modal, **rename home** (pencil → modal; `api_rename_household`), **delete home** (trash on each card; custom warning modal with **Continue/Cancel**; removes the household for all members), same secure API patterns. If the user deletes their last home, `loadHouseholds` runs `bootstrapUser` again so a default home is recreated.

## Stage 3 - Rooms

- Rooms data model:
  - `rooms` with `household_id`, `name`, `background_url`, `background_path` (after `security_hardening.sql`), timestamps
  - index on `household_id`
- Storage bucket `rooms`:
  - After hardening: **private** bucket; policies for `service_role` only (see `security_hardening.sql`).
  - Legacy `rooms.sql` described public policies; **effective production shape** is private + signed URLs.
- Rooms UI:
  - Rooms list, room detail, FAB add room, add room modal
  - **Rename room** from overview card or room header (pencil → modal); RPC `api_rename_room`; response signed like `createRoom`.
  - **Delete room** from overview card (custom warning modal with **Continue/Cancel**); RPC `api_delete_room` (cascade removes plants/markers per schema).
  - **Scroll on open:** overview and room detail share the **same document scroll**. A `useLayoutEffect` keyed on `selectedRoom?.id` resets `window` / `document.documentElement` / `document.body` scroll to the top when entering a room so the **room photo and markers** are in view immediately (no extra scroll after opening from a scrolled-down list).
- Room images:
  - Upload: `POST /api/rooms/upload` (service role uploads file, RPC attaches path to room).
  - Display: `listRooms` / `createRoom` / **`renameRoom`** responses include **`signed_background_url`** (short-lived signed URL from Storage).
  - **Legacy rows** with only `background_url` (old public URL) and empty `background_path`: server tries to derive storage path from the public URL and sign it so images keep working after bucket goes private.

## Stage 4 - Plants and Markers

- Plants: `household_id`, `room_id`, `name`, `species`, `status`, `last_watered_at`, etc.
- Plant photos: add flow now supports either **taking a photo** or **uploading from gallery** in `Add Plant`; image is uploaded via `POST /api/plants/upload`, stored in Supabase Storage, and shown on plant cards and edit modal through signed URLs. `Edit Plant` also supports **Replace photo** and **Remove photo**.
- **Android camera fallback:** `Add Plant` includes in-app camera capture via `getUserMedia` + frame capture, so Telegram Android/WebView `file input` quirks no longer block taking photos.
- **Photo compression before AI/upload:** client compresses selected/captured images (downscale + JPEG quality) before sending to AI Studio and storage upload; UI shows compression result (`Compressed: X -> Y` or `No compression gain`).
- **AI analyze flow in Add Plant:** after photo selection, user can run a single explicit **Analyze with AI** action; UI shows `Analyzing...`, success autofill, precise error messages, retry, and **Apply anyway** for low-confidence suggestions.
- **AI auto-detection on plant photo upload:** when `GEMINI_API_KEY` is configured, `POST /api/plants/upload` sends the photo to Google AI Studio (Gemini) and auto-updates plant name + per-plant watering thresholds from model output.
- **Dedicated AI analyze endpoint:** `POST /api/plants/analyze` analyzes the photo before save and returns `ai_status`, `ai_error`, and optional `ai_profile` for controlled autofill UX.
- **AI model updated:** moved from `gemini-2.0-flash` to `gemini-2.5-flash` for new-key compatibility.
- AI watering amount recommendation: photo analysis stores suggested watering amount (`light` / `moderate` / `abundant`) and shows it in plant info; legacy values are mapped (`little`→`light`, `a_lot`→`abundant`).
- AI watering summary: photo analysis stores `watering_summary` (2-3 short sentences with watering guidance + care tips like light/drainage/humidity/temperature) and shows it in plant card/edit info.
- **Non-plant and uncertain photos:** AI prompt now requires `is_plant` + `confidence`; server returns explicit statuses for `not_plant` and `low_confidence`, and UI blocks blind autofill for obvious non-plant images.
- AI detection badge: inferred results are marked in DB (`plants.ai_inferred_at`) and shown in plant list / edit modal as `AI detected`.
- Manual override behavior: saving plant edits manually (`api_update_plant`) clears `ai_inferred_at`, so the `AI detected` badge is removed after user override.
- Per-plant watering thresholds: each plant stores **thirsty-after minutes** and **overdue-after minutes** (defaults 5/60). In UI values are shown/edited in **hours** (`step=0.1`) and converted to minutes for storage.
- **AI threshold safety rails:** server normalizes AI thresholds to realistic indoor ranges (`thirsty >= 6h`, `overdue >= 12h`, minimum 6h gap) to avoid absurd minute-level watering advice.
- `plant_markers`: normalized `x`, `y` in `0..1`, unique per `plant_id`
- Marker coordinates are calculated against the **visible image content area** (for `object-contain`), so marker placement stays aligned both on real phones and in desktop mobile emulation (no offset from letterboxing).
- Plant CRUD, marker placement, edit-from-plant-dialog flows as before (all via `/api/secure` + RPC).
- **Post-add marker guidance:** after `Add Plant`, UI enters marker edit mode with a compact semi-transparent top banner (`Place marker` + selected plant name), a minimal bottom hint (`Tap on photo to place marker`), and explicit cancel action.
- **Marker placement instant feedback:** on tap, UI shows a short tap ripple plus an optimistic temporary marker with `Saving...` until RPC completes.
- Plant deletion is available from **Edit Plant** with a warning modal (**Continue/Cancel**); room markers are removed together with the plant.
- In **Plants in this room**, plants without a marker display a `no marker` badge next to the plant name.
- **Marker pin color and active-marker status chip** (in `src/app/page.tsx`) use **watering urgency derived from `last_watered_at`**, not the stored `plants.status` field, so colors track time since last water without waiting for server-side status flips.

## Stage 5 - Watering

- Watering updates `last_watered_at` and `status` via secure API / RPC.
- Marker tap starts a **3-second delayed watering** (instead of instant watering).
- Delayed watering supports **multi-tap batching**: tapping another marker does not cancel already scheduled markers; each marker keeps its own timer.
- Marker popup (during delayed watering only) shows **live countdown** (`Watering in 3s/2s/1s`) and a **Cancel** action to abort watering for that specific marker; plant name/status are hidden in this popup.
- Multiple marker popups can be visible at the same time while their independent countdowns are running.
- Closing a room does **not** cancel already scheduled marker waterings; they continue server-side and appear on next room open.
- Re-watering is allowed: tapping an already watered marker updates `last_watered_at` to the current time again (timer reset/restart).
- **Marker long-press opens `Edit Plant`** for that exact marker's plant (tap behavior still waters as before).
- **Edit Plant** includes **Undo last watering** with persistent DB history: restores `last_watered_at` to the value captured before the latest watering action, including after app reloads, and closes the edit modal right after undo.
- **Client-side urgency** (`wateringDerivedStatus` in `page.tsx`), aligned with marker colors and calculated **per plant** from its own thresholds:
  - **Green (`healthy`):** last watered less than `thirsty_after_minutes`.
  - **Yellow (`thirsty`):** from `thirsty_after_minutes` up to `overdue_after_minutes`.
  - **Red (`overdue`):** at/after `overdue_after_minutes`, or **`last_watered_at` is null** (never watered).
- Plant info now shows full **date+time** for `last_watered_at` (`toLocaleString`), not date-only.
- Plant upload route uses a loose typed DB write helper (`LooseTableApi`) for `plants.update(...)`, avoiding Supabase generated-type `never` issues in CI/build typecheck.
- **Plants-in-room list:** the small uppercase status line uses the same derivation so it matches markers.
- **Edit Plant** still reads/writes the DB `status` field; the list line and markers intentionally ignore that for display and use time since `last_watered_at` only.
- While a room is open, a **30s `setInterval`** bumps React state so colors refresh without refetch; **closing the room** clears `selectedRoom`, runs effect cleanup (interval stopped), and **reopening** recomputes from the current clock and loaded `last_watered_at`.

## UI / Design System Work

- Stitch-style layout, Lucide SVG icons, cards, mobile shell (unchanged intent).
- **Button interaction clarity:** global button states in `src/app/globals.css` now have stronger hover/active/focus-visible feedback (clearer press depth, contrast, and keyboard focus ring).
- **Add Plant submit feedback:** `Add Plant` now has explicit pending state (`Adding plant...` + spinner), disables repeat clicks while request/upload is running, and keeps action state visible during network delay.
- **Home cards** are a `div` with two side actions (rename / delete) so icon buttons are not nested inside the main “switch home” control (valid HTML, clearer hit targets).
- **Bottom navigation** (`src/components/MobileShell.tsx`): `Link` routes — **Rooms** `/`, **Inbox** `/tasks`, **Settings** `/settings` (active tab from pathname). Main rooms experience stays on `/`.
- **Placeholder pages:** `src/app/tasks/page.tsx` (tasks / inbox stub), `src/app/settings/page.tsx` (settings stub), each with back link to `/`.
- Overview header **settings** icon links to `/settings`.
- **Fonts:** `next/font/google` (Plus Jakarta Sans) was removed so **production build does not depend on Google Fonts at fetch time**; app font stack is set in `src/app/globals.css` (system / web-safe stack under `--font-plus-jakarta`).

## Known Technical Debt

- No icon-font technical debt at the moment: Material Symbols custom font link and related ESLint suppression were removed, and UI icons now render via local React SVG components (`lucide-react`).

## SQL / Migration Files Present

- `rooms.sql` — initial rooms table, index, bucket creation, **historical** public storage policies (superseded by `security_hardening.sql` when applied).
- `plants.sql` — plants + `plant_markers` + indexes.
- `households_join.sql` — `invite_code` on `households` + unique index.
- `security_hardening.sql` — RLS, revoke direct table access from anon/auth, `public.api_*` RPCs, private `rooms` storage, `rooms.background_path`, grants for RPC execution.
- `multi_household_delete_room.sql` — **run after** `security_hardening.sql`: `active_household_id` on `profiles`, relax single-home `household_members` uniqueness, replace `api_household_id_by_profile` / `api_bootstrap_user` / `api_join_household`, add `api_list_households`, `api_create_household`, `api_set_active_household`, `api_delete_room`, `api_rename_household`, `api_rename_room`, `api_delete_household` (optional tasks cleanup when `public.tasks` exists), and grants. Required for multi-home UI, renames, room/household delete. If the file was applied in parts, see incremental comments at the end of the SQL file for missing RPCs.
- `watering_undo_history.sql` — persistent `plant_watering_events` history used by secure API to support global undo of the latest watering per plant.
- `plant_photos.sql` — adds `plants.photo_path` and updates `api_room_details` payload to include plant photo metadata for signed URL rendering.
- `plant_watering_thresholds.sql` — adds `plants.thirsty_after_minutes` + `plants.overdue_after_minutes`, updates room details payload, and extends plant create/update RPCs to persist thresholds per plant.
- `plant_ai_inference_flag.sql` — adds `plants.ai_inferred_at` and extends room details payload so UI can show `AI detected`.
- `plant_ai_manual_override.sql` — updates `api_update_plant` to clear `ai_inferred_at` on manual save.
- `plant_ai_watering_amount.sql` — adds `plants.watering_amount_recommendation`, migrates legacy values (`little`/`a_lot`), and extends room details payload.
- `plant_ai_watering_summary.sql` — adds `plants.watering_summary` and extends room details payload.
- `plant_ai_watering_summary.sql` — adds `plants.watering_summary` and extends room details payload.

## Current Behavior Summary

- **Production:** open only from Telegram Mini App (menu / `web_app` button). Server requires valid `initData` + `TELEGRAM_BOT_TOKEN`.
- **Local browser debug:** `npm run dev` + `DEV_BROWSER_MODE=true` + `DEV_TELEGRAM_ID` + `SUPABASE_SERVICE_ROLE_KEY` (not available on deployed Vercel preview/prod by design).
- All data access: `POST /api/secure`, `POST /api/rooms/upload`, `POST /api/plants/upload`, `POST /api/plants/analyze`; RLS + RPC enforce household scope (active household from `profiles.active_household_id` when migration applied).
- **Households:** members can **rename** (`api_rename_household`) or **delete** (`api_delete_household`) a home they belong to; delete removes shared data for everyone; empty membership after deletes is healed by **`bootstrapUser`** inside `loadHouseholds` (default home again).
- Room thumbnails and detail images use **signed URLs**; legacy public URLs are supported via path extraction when needed.
- **Opening a room** scrolls the page to the **top** before paint (`useLayoutEffect` in `src/app/page.tsx`) so watering markers on the image are usable without scrolling up from the list position.
- Deletions (home, room, plant) use an in-app warning modal with explicit **Continue** / **Cancel** actions instead of browser `confirm()`.
