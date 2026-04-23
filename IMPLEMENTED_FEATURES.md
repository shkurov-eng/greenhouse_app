# GreenHouse App - Implemented Features (Current State)

This document summarizes what has already been implemented in the project.

## Tech Stack and Base Setup

- Next.js app (App Router) with TypeScript.
- Supabase (PostgreSQL + Storage); **browser no longer queries tables directly**.
- Typed client API wrapper: `src/lib/api.ts` (calls `POST /api/secure` and `POST /api/rooms/upload`).
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
  - Current home card shows invite code
  - User can join another home via invite code modal
  - Membership is updated server-side with membership checks

## Stage 3 - Rooms

- Rooms data model:
  - `rooms` with `household_id`, `name`, `background_url`, `background_path` (after `security_hardening.sql`), timestamps
  - index on `household_id`
- Storage bucket `rooms`:
  - After hardening: **private** bucket; policies for `service_role` only (see `security_hardening.sql`).
  - Legacy `rooms.sql` described public policies; **effective production shape** is private + signed URLs.
- Rooms UI:
  - Rooms list, room detail, FAB add room, add room modal
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
- **Fonts:** `next/font/google` (Plus Jakarta Sans) was removed so **production build does not depend on Google Fonts at fetch time**; app font stack is set in `src/app/globals.css` (system / web-safe stack under `--font-plus-jakarta`).

## SQL / Migration Files Present

- `rooms.sql` — initial rooms table, index, bucket creation, **historical** public storage policies (superseded by `security_hardening.sql` when applied).
- `plants.sql` — plants + `plant_markers` + indexes.
- `households_join.sql` — `invite_code` on `households` + unique index.
- `security_hardening.sql` — RLS, revoke direct table access from anon/auth, `public.api_*` RPCs, private `rooms` storage, `rooms.background_path`, grants for RPC execution.

## Current Behavior Summary

- **Production:** open only from Telegram Mini App (menu / `web_app` button). Server requires valid `initData` + `TELEGRAM_BOT_TOKEN`.
- **Local browser debug:** `npm run dev` + `DEV_BROWSER_MODE=true` + `DEV_TELEGRAM_ID` + `SUPABASE_SERVICE_ROLE_KEY` (not available on deployed Vercel preview/prod by design).
- All data access: `POST /api/secure`, `POST /api/rooms/upload`; RLS + RPC enforce household scope.
- Room thumbnails and detail images use **signed URLs**; legacy public URLs are supported via path extraction when needed.
