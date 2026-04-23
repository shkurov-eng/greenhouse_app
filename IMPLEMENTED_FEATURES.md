# GreenHouse App - Implemented Features (Current State)

This document summarizes what has already been implemented in the project.

## Tech Stack and Base Setup

- Next.js app (App Router) with TypeScript.
- Supabase (PostgreSQL + Storage); **browser no longer queries tables directly**.
- Typed client API wrapper: `src/lib/api.ts` (calls `POST /api/secure` and `POST /api/rooms/upload`). Secure actions include household list/create/set-active, `deleteRoom`, and existing room/plant flows (see `SecureAction` in `src/app/api/secure/route.ts`).
- Server-side Supabase admin client: `src/lib/server/supabaseAdmin.ts` (service role, lazy init).
- Telegram auth helper: `src/lib/server/telegramAuth.ts` (`initData` HMAC verification; optional local dev mode).
- Environment variables (see also `.env.example`):
  - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY` (server only)
  - `TELEGRAM_BOT_TOKEN` (production / real Mini App)
  - Optional local browser debug: `DEV_BROWSER_MODE=true`, `DEV_TELEGRAM_ID` (only with `npm run dev`)
- `src/lib/supabase.ts` remains for potential non-UI use; **main UI does not use it for data access**.
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
  - UI: card-style **home picker** (horizontal scroll when multiple homes), **Create new home** modal, same secure API patterns.

## Stage 3 - Rooms

- Rooms data model:
  - `rooms` with `household_id`, `name`, `background_url`, `background_path` (after `security_hardening.sql`), timestamps
  - index on `household_id`
- Storage bucket `rooms`:
  - After hardening: **private** bucket; policies for `service_role` only (see `security_hardening.sql`).
  - Legacy `rooms.sql` described public policies; **effective production shape** is private + signed URLs.
- Rooms UI:
  - Rooms list, room detail, FAB add room, add room modal
  - **Delete room** from overview card (confirm dialog); RPC `api_delete_room` (cascade removes plants/markers per schema).
- Room images:
  - Upload: `POST /api/rooms/upload` (service role uploads file, RPC attaches path to room).
  - Display: `listRooms` / `createRoom` responses include **`signed_background_url`** (short-lived signed URL from Storage).
  - **Legacy rows** with only `background_url` (old public URL) and empty `background_path`: server tries to derive storage path from the public URL and sign it so images keep working after bucket goes private.

## Stage 4 - Plants and Markers

- Plants: `household_id`, `room_id`, `name`, `species`, `status`, `last_watered_at`, etc.
- `plant_markers`: normalized `x`, `y` in `0..1`, unique per `plant_id`
- Plant CRUD, marker placement, edit-from-plant-dialog flows as before (all via `/api/secure` + RPC).

## Stage 5 - Watering

- Watering updates `last_watered_at` and `status` via secure API / RPC.
- Marker tap still waters plant; flash animation unchanged.
- Plant **status in UI** follows values returned from the API (no client-side time-based recalculation from `last_watered_at` in the current build).

## UI / Design System Work

- Stitch-style layout, Material Symbols, cards, mobile shell (unchanged intent).
- **Bottom navigation** (`src/components/MobileShell.tsx`): `Link` routes — **Rooms** `/`, **Inbox** `/tasks`, **Settings** `/settings` (active tab from pathname). Main rooms experience stays on `/`.
- **Placeholder pages:** `src/app/tasks/page.tsx` (tasks / inbox stub), `src/app/settings/page.tsx` (settings stub), each with back link to `/`.
- Overview header **settings** icon links to `/settings`.
- **Fonts:** `next/font/google` (Plus Jakarta Sans) was removed so **production build does not depend on Google Fonts at fetch time**; app font stack is set in `src/app/globals.css` (system / web-safe stack under `--font-plus-jakarta`).

## SQL / Migration Files Present

- `rooms.sql` — initial rooms table, index, bucket creation, **historical** public storage policies (superseded by `security_hardening.sql` when applied).
- `plants.sql` — plants + `plant_markers` + indexes.
- `households_join.sql` — `invite_code` on `households` + unique index.
- `security_hardening.sql` — RLS, revoke direct table access from anon/auth, `public.api_*` RPCs, private `rooms` storage, `rooms.background_path`, grants for RPC execution.
- `multi_household_delete_room.sql` — **run after** `security_hardening.sql`: `active_household_id` on `profiles`, relax single-home `household_members` uniqueness, replace `api_household_id_by_profile` / `api_bootstrap_user` / `api_join_household`, add `api_list_households`, `api_create_household`, `api_set_active_household`, `api_delete_room`, and grants. Required for multi-home UI and room delete in the app.

## Current Behavior Summary

- **Production:** open only from Telegram Mini App (menu / `web_app` button). Server requires valid `initData` + `TELEGRAM_BOT_TOKEN`.
- **Local browser debug:** `npm run dev` + `DEV_BROWSER_MODE=true` + `DEV_TELEGRAM_ID` + `SUPABASE_SERVICE_ROLE_KEY` (not available on deployed Vercel preview/prod by design).
- All data access: `POST /api/secure`, `POST /api/rooms/upload`; RLS + RPC enforce household scope (active household from `profiles.active_household_id` when migration applied).
- Room thumbnails and detail images use **signed URLs**; legacy public URLs are supported via path extraction when needed.
