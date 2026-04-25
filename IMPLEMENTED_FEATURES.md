# GreenHouse App - Implementation Ledger

This document records what has already been implemented. Keep `README.md` focused on setup, architecture, and operations; use this file as the detailed feature ledger so current behavior has one obvious place to live.

Maintenance guidelines:

- Prefer short, verifiable facts over broad roadmap language.
- Keep security-sensitive behavior explicit, especially auth, RLS, storage, ownership, and rate limits.
- Avoid duplicating setup instructions from `README.md`; link concepts here to concrete implemented files and flows.
- When behavior changes, update the affected section and the current behavior summary in the same change.

## Tech Stack and Base Setup

- Next.js app (App Router) with TypeScript.
- Supabase (PostgreSQL + Storage); **browser no longer queries tables directly**.
- Typed client API wrapper: `src/lib/api.ts` (calls `POST /api/secure`, `POST /api/rooms/upload`, `POST /api/rooms/analyze`, `POST /api/plants/upload`, and `POST /api/plants/analyze`). Secure actions include household list/create/set-active/`deleteHousehold`/`renameHousehold`, room create/`renameRoom`/`deleteRoom`, and existing room/plant flows (see `SecureAction` in `src/app/api/secure/route.ts`).
- Server-side Supabase admin client: `src/lib/server/supabaseAdmin.ts` (service role, lazy init).
- Telegram auth helper: `src/lib/server/telegramAuth.ts` (`initData` HMAC verification; optional local dev mode).
- Environment variables (see also `.env.example`):
  - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY` (server only)
  - `TELEGRAM_BOT_TOKEN` (production / real Mini App)
  - `GEMINI_API_KEY` (Google AI Studio, optional; enables AI detection for plant and room photos)
  - Optional local browser debug: `DEV_BROWSER_MODE=true`, `DEV_TELEGRAM_ID` (only with `npm run dev`)
- `src/lib/supabase.ts` remains for potential non-UI use; **main UI does not use it for data access**.
- Last known lint baseline is clean (`npm run lint` passes).
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
- Current invite-code generator (`api_generate_invite_code`) produces 10-character uppercase codes from a non-ambiguous alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`).
- Join by invite code is protected from brute-force attempts via persistent DB-backed rate limiting (`api_check_join_invite_rate_limit`, `api_register_join_invite_failure`, `api_clear_join_invite_failures`): 5 failed attempts per 15 minutes -> 15-minute block.
- Household creation is protected with DB-backed rate limits via `api_assert_household_create_allowed` and `household_create_events`:
  - max 3 home creations per 1 hour
  - max 10 home creations per 24 hours
  - both manual create and auto-bootstrap fallback creation are counted
- Room creation is protected with DB-backed rate limits via `api_assert_room_create_allowed` and `room_create_events`:
  - max 10 room creations per 1 hour
  - max 50 room creations per 24 hours
  - limit is intentionally higher than household-create limit
- Plant creation is protected with DB-backed rate limits via `api_assert_plant_create_allowed` and `plant_create_events`:
  - max 30 plant creations per 1 hour
  - max 150 plant creations per 24 hours
  - limit is intentionally higher than room-create limit
- AI photo requests are protected with DB-backed rate limits via `api_register_ai_photo_request` and `ai_photo_request_events`:
  - max 30 AI photo requests per 1 hour
  - max 150 AI photo requests per 24 hours
  - applied for `POST /api/plants/upload` (AI mode), `POST /api/plants/analyze`, and `POST /api/rooms/analyze`
  - temporary runtime fallback added: if Supabase reports missing `public.api_register_ai_photo_request(...)` in schema cache, endpoints continue without rate-limit check and log warning server-side (prevents user-facing hard failure on `AI detected` actions)
- Bot task ingestion is protected with DB-backed rate limits via `api_register_bot_task_ingest` and `bot_task_ingest_events`:
  - max 40 bot-task ingests per 1 hour
  - max 200 bot-task ingests per 24 hours
  - applied in `POST /api/bot/webhook` before draft create/merge logic
- Optional owner approval for join-by-invite:
  - Household owner can enable `require_join_approval` in Settings.
  - Default policy is enabled: homes require owner approval for joins unless owner disables it.
  - Join attempts create pending requests instead of instant membership.
  - Owner sees pending requests in Settings (`Telegram ID`, `username`, home name, invite code) and can approve/reject.
  - Bot notifies owner about each pending request and provides inline `Approve` / `Reject` buttons in Telegram.
  - Owner sees household members grouped by each owned home in Settings and can remove participants.
- Join home in UI:
  - Homes section shows invite code with **copy to clipboard** action.
  - User can join another home via invite code modal (`Join with code`).
- **Multi-household** behavior after `multi_household_delete_room.sql`:
  - `profiles.active_household_id` drives `listRooms` and other room/plant RPCs.
  - `api_list_households`, `api_create_household`, and `api_set_active_household` support home management.
  - `api_join_household` adds membership and sets the joined home active, so a user can belong to several homes.
  - Legacy unique-on-`user_id` alone on `household_members` must be dropped in favor of `UNIQUE (household_id, user_id)`.
  - The migration attempts common legacy constraint/index names, including `household_members_user_id_unique`.
  - PL/pgSQL uses dynamic `EXECUTE ... USING` where needed so `RETURNS TABLE (household_id, ...)` output names do not shadow column names.
  - UI supports create home, rename home (`api_rename_household`), delete owned home (`api_delete_household`), and leave non-owned home (`leaveHousehold` secure action).
  - If the user deletes/leaves their last home, `loadHouseholds` runs `bootstrapUser` again so a default home is recreated.

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
  - Room photos are compressed client-side before upload (same compression helper used for plant photos), with UI status reflecting size reduction when available.
  - Room photo upload applies a strict client-side payload ceiling (`~4 MB` after compression/downscale). If file is still too large, request is blocked client-side with explicit guidance.
  - Display: `listRooms` / `createRoom` / **`renameRoom`** responses include **`signed_background_url`** (short-lived signed URL from Storage).
  - **Legacy rows** with only `background_url` (old public URL) and empty `background_path`: server tries to derive storage path from the public URL and sign it so images keep working after bucket goes private.

## Stage 4 - Plants and Markers

- Plants: `household_id`, `room_id`, `name`, `species`, `status`, `last_watered_at`, etc.
- Plant photos: add flow now supports either **taking a photo** or **uploading from gallery** in `Add Plant`; image is uploaded via `POST /api/plants/upload`, stored in Supabase Storage, and shown on plant cards and edit modal through signed URLs. `Edit Plant` also supports **Replace photo** and **Remove photo**.
- **Edit Plant photo actions:** in `Edit Plant`, user can also **take a new photo** directly (camera capture) in addition to gallery replacement.
- **Edit Plant camera parity:** `Take photo` in `Edit Plant` now uses the same in-app camera modal flow (`getUserMedia` preview + `Capture`) as `Add Plant`, instead of opening the system file picker.
- **Edit Plant AI analyze action:** in `Edit Plant`, user can run **Analyze with AI** on the current plant photo to refresh editable fields (name + watering thresholds) even if the plant was initially filled manually.
- **Android camera fallback:** `Add Plant` includes in-app camera capture via `getUserMedia` + frame capture, so Telegram Android/WebView `file input` quirks no longer block taking photos.
- **Photo compression before AI/upload:** client compresses selected/captured images (downscale + JPEG quality) before sending to AI Studio and storage upload; UI shows compression result (`Compressed: X -> Y` or `No compression gain`).
- **Unified upload-size guardrails:** shared client helper now handles compression + max-size validation for room and plant photo upload flows (including Add Plant, Replace Plant Photo, and pre-save AI analyze). Limit target is `~4 MB` after compression.
- **AI analyze flow in Add Plant:** after photo selection, user can run a single explicit **Analyze with AI** action; UI shows `Analyzing...`, success autofill, precise error messages, retry, and **Apply anyway** for low-confidence suggestions.
- **Add Plant browser resilience:** if client-side image compression/decode fails for a specific photo format, upload falls back to the original file instead of aborting add flow (`Compression skipped... uploading original`).
- **Add Plant partial-success behavior:** if plant row is created but photo upload fails, plant creation is kept (no full rollback), and user gets explicit status that plant was added without photo.
- **AI auto-detection on plant photo upload:** when `GEMINI_API_KEY` is configured, `POST /api/plants/upload` sends the photo to Google AI Studio (Gemini) and auto-updates plant name + per-plant watering thresholds from model output.
- **Dedicated AI analyze endpoint:** `POST /api/plants/analyze` analyzes the photo before save and returns `ai_status`, `ai_error`, and optional `ai_profile` for controlled autofill UX.
- **Room-level AI plant detection:** room header includes `AI Detect Plants` (next to `Add Plant`) that calls `POST /api/rooms/analyze`, shows a preview list of detected plants (with per-item selection), then creates selected plant rows and auto-places markers.
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

## Stage 6 - Tasks (Bot)

- Added SQL migration `tasks_bot_reminders.sql`:
  - `tasks` table with household scope, source message metadata, AI parse metadata, and status/priority fields.
  - `task_reminders_log` table for reminder deduplication history.
  - RPCs: `api_list_tasks`, `api_create_task`, `api_update_task_status`, `api_delete_task`.
- Added SQL migration `tasks_scope_and_bot_choice.sql`:
  - Task visibility fields: `tasks.task_scope` (`personal`/`household`) and `tasks.assignee_profile_id`.
  - `bot_task_drafts` table for two-step bot flow.
  - Updated `api_list_tasks` visibility filter (personal tasks only for assignee, shared tasks for household members).
- Added SQL migration `tasks_personal_separate_from_households.sql`:
  - `tasks.household_id` is nullable for personal tasks and required for household tasks via DB check constraint.
  - Existing personal tasks are detached from homes (`household_id = NULL`).
  - RPC access rules for `api_list_tasks`, `api_create_task`, `api_update_task_status`, `api_delete_task` now enforce:
    - personal tasks -> only assignee access;
    - household tasks -> only members of that household.
- Added SQL migration `task_message_mode_settings.sql`:
  - `profiles.task_message_mode` (`single`/`combine`) for bot ingestion behavior.
- `/api/secure` now supports task actions: `listTasks`, `createTask`, `updateTaskStatus`, `deleteTask`.
- `/api/secure` also supports:
  - `updateTask` (edit title, deadline, scope, household)
  - `getTaskSettings` / `setTaskSettings` (task message mode in settings)
- `/tasks` page is now functional (no longer a placeholder):
  - Loads personal tasks for current user and household tasks from member homes.
  - Supports manual task creation in-page (title, deadline, scope; target home only for household tasks).
  - Creation form includes quick deadline presets (`+1h`, `Today 20:00`, `Tomorrow 09:00`).
  - `New task` and `Filters` sections are collapsible for a compact Inbox view.
  - `Task type` filter supports `All`, `Personal`, and specific homes.
  - Last selected `Task type` filter is persisted in local storage and restored on next open.
  - Lets user toggle task status between `open` and `done`.
  - Shows task scope badges (`Личная` / `Дом: <name>`), AI badges, and due date.
  - Supports filtering/sorting by scope and deadline, plus date-range calendar controls and reset.
  - Supports task details modal (including original forwarded message and source ids for Telegram tasks).
  - Supports task editing (title, deadline, scope; home only for household tasks).
- Added Telegram bot webhook endpoint `POST /api/bot/webhook`:
  - Accepts Telegram updates, validates optional secret token, and asks user to choose task scope via inline buttons.
  - Scope choice flow: **Personal** or **Shared household**; when user has multiple homes, webhook asks for explicit home selection.
  - Uses draft table + source keys to safely process message -> choice -> task creation.
  - Fast UX: immediate callback acknowledgment (`Обрабатываю...`) and deferred AI parsing after user choice.
  - Supports message ingestion modes:
    - `single`: one message -> one draft/task flow
    - `combine`: multiple messages merged into one pending draft before finalization
    - `combine` merged draft is capped at `20,000` characters with explicit truncation notice.
    - combine follow-up confirmation is minimal (`Принял. Обработка уже идет, можно закрывать бота.`).
  - Media without caption is supported with fallback titles (`Задача из фото`, `...из файла`, etc.).
  - Link messages default to title `Задача из ссылки` (URL content parsing postponed to backlog).

## Stage 7 - Reminders

- Added scheduled reminders endpoint `POST /api/jobs/send-reminders`:
  - Scans open tasks with `due_at` in reminder window.
  - Reminder scheduler is configured to run every 5 minutes.
  - Due-soon selection uses a near-deadline window (`now-5m .. now+15m`) to avoid overly early reminders.
  - Sends `due_soon` / `overdue` notifications through Telegram Bot API.
  - Uses `task_reminders_log` to avoid duplicate sends within reminder windows.
  - Supports optional job secret header (`x-job-secret`) via env.

## UI / Design System Work

- Stitch-style layout, Lucide SVG icons, cards, mobile shell (unchanged intent).
- **Button interaction clarity:** global button states in `src/app/globals.css` now have stronger hover/active/focus-visible feedback (clearer press depth, contrast, and keyboard focus ring).
- **Add Plant submit feedback:** `Add Plant` now has explicit pending state (`Adding plant...` + spinner), disables repeat clicks while request/upload is running, and keeps action state visible during network delay.
- **Room-screen runtime status visibility:** room detail now shows current `message` in-page (compact status card above room photo), so API/validation/upload errors are visible where user is acting.
- **Main-screen home switcher compact mode:** card-based home picker was replaced with a compact dropdown select showing active home name; tap opens household list for quick switch with less vertical space.
- **Bottom navigation** (`src/components/MobileShell.tsx`): `Link` routes — **Rooms** `/`, **Inbox** `/tasks`, **Settings** `/settings` (active tab from pathname). Main rooms experience stays on `/`.
- **Route pages:** `src/app/tasks/page.tsx` is the functional task inbox; `src/app/settings/page.tsx` owns settings, household management, invite codes, and task message mode.
- Overview header **settings** icon links to `/settings`.
- **Fonts:** `next/font/google` (Plus Jakarta Sans) was removed so **production build does not depend on Google Fonts at fetch time**; app font stack is set in `src/app/globals.css` (system / web-safe stack under `--font-plus-jakarta`).
- **Visual foundation refresh:** global UI polish in `src/app/globals.css` adds a softer layered background, improved font rendering, accessible link focus states, and shared form control typography inheritance.
- **Bottom nav refresh:** `MobileShell` navigation got larger touch targets, clearer active/inactive states, stronger elevation/backdrop blur, and explicit `aria-label` for primary navigation.
- **Overview UX refresh:** rooms overview now has a stronger hero/introduction block, clearer hierarchy, and status presented as a compact chip/card instead of competing with main headings.
- **Room cards UX refresh:** room cards are now keyboard-openable (`role="button"`, `tabIndex`, Enter/Space handling), have better visual hierarchy, clearer “open room” affordance, and friendlier no-photo state.
- **Room image upload compact flow:** room cards now show a compact `Room photo` action that opens a modal with `Take photo` and `Choose photo`.
- **Room camera flow parity with plants:** `Take photo` for room images now opens in-app camera preview (`getUserMedia` + `Capture`) similar to plant camera flow, avoiding Telegram/WebView file-input camera quirks.
- **Room photo auto-upload after capture:** when capturing room photo in camera modal, upload starts immediately and room-photo modal closes after successful upload.
- **Empty states refresh:** both overview (no rooms) and room detail (no plants) now include guided copy and immediate primary actions to reduce first-use friction.
- **Room detail visual refresh:** selected-room header/back button/add-plant CTA and plant list cards were updated with larger hit areas, improved spacing, and stronger contrast hierarchy.
- **Home screen bootstrap cleanup:** initial success toast/message (`User initialized`) was removed from `src/app/page.tsx` so the main screen starts cleaner after auth bootstrap.
- **Settings invite-code UX update:** `Active home invite code` standalone block was removed; each home card in `src/app/settings/page.tsx` now shows its own invite code with an inline `Copy` button.

## Known Technical Debt

- No icon-font technical debt at the moment: Material Symbols custom font link and related ESLint suppression were removed, and UI icons now render via local React SVG components (`lucide-react`).
- Migration application is still manual through SQL files. For production operations, the next maintainability step is a repeatable migration runner or deployment checklist that records which migrations have been applied per environment.
- AI plant thresholds still rely on model output plus server safety rails. The planned deterministic species catalog should reduce inconsistent recommendations for common plants.

## Planned Work (Backlog)

### Deterministic species watering catalog (planned)

Goal: stop relying on generative AI to produce watering thresholds on every photo and make thresholds predictable for the same species.

Scope and plan:

1. Split AI responsibilities:
   - Keep AI for vision/classification and short care text only.
   - Return canonical species identity (`plant_id`, `plant_name`, `confidence`, `is_plant`) from AI.
2. Add a deterministic species catalog:
   - Create a versioned catalog source (`JSON` or DB table) with canonical `plant_id`, aliases, and baseline thresholds.
   - Store `thirsty_after_hours`, `overdue_after_hours`, and default `water_volume` per species under standard indoor assumptions (living room, average humidity, ~20-22C).
3. Resolve species IDs reliably:
   - Add alias normalization (`peace lily`, `spathiphyllum`, etc. -> same canonical `plant_id`).
   - Apply confidence gates for auto-apply vs. review-needed cases.
4. Runtime decision flow:
   - If species is found in catalog: apply deterministic thresholds from catalog.
   - If species is unknown: use current AI threshold fallback + existing safety rails.
5. Data model and observability:
   - Track threshold source per plant (`catalog`, `ai_fallback`, `manual`).
   - Track catalog version used for each applied threshold set.
6. Catalog population process:
   - Seed top frequently used species first (80/20 approach).
   - Use AI suggestions only as draft input; finalize by human review.
   - Periodically review unknown/fallback species and promote to catalog.
7. Migration and UX:
   - Keep existing plants unchanged by default.
   - Optionally add a user action to re-apply catalog values to selected plants/species later.

## SQL / Migration Files Present

- `rooms.sql` — initial rooms table, index, bucket creation, **historical** public storage policies (superseded by `security_hardening.sql` when applied).
- `plants.sql` — plants + `plant_markers` + indexes.
- `households_join.sql` — `invite_code` on `households` + unique index.
- `security_hardening.sql` — RLS, revoke direct table access from anon/auth, `public.api_*` RPCs, private `rooms` storage, `rooms.background_path`, grants for RPC execution.
- Migration caution: on databases that already use the newer `api_join_household` return shape (from `household_join_approval.sql`), rerunning full `security_hardening.sql` can fail with `cannot change return type of existing function`; use targeted patch SQL for missing objects instead.
- `multi_household_delete_room.sql` — **run after** `security_hardening.sql`: `active_household_id` on `profiles`, relax single-home `household_members` uniqueness, replace `api_household_id_by_profile` / `api_bootstrap_user` / `api_join_household`, add `api_list_households`, `api_create_household`, `api_set_active_household`, `api_delete_room`, `api_rename_household`, `api_rename_room`, `api_delete_household` (optional tasks cleanup when `public.tasks` exists), and grants. Required for multi-home UI, renames, room/household delete. If the file was applied in parts, see incremental comments at the end of the SQL file for missing RPCs.
- `watering_undo_history.sql` — persistent `plant_watering_events` history used by secure API to support global undo of the latest watering per plant.
- `plant_photos.sql` — adds `plants.photo_path` and updates `api_room_details` payload to include plant photo metadata for signed URL rendering.
- `plant_watering_thresholds.sql` — adds `plants.thirsty_after_minutes` + `plants.overdue_after_minutes`, updates room details payload, and extends plant create/update RPCs to persist thresholds per plant.
- `plant_ai_inference_flag.sql` — adds `plants.ai_inferred_at` and extends room details payload so UI can show `AI detected`.
- `plant_ai_manual_override.sql` — updates `api_update_plant` to clear `ai_inferred_at` on manual save.
- `plant_ai_watering_amount.sql` — adds `plants.watering_amount_recommendation`, migrates legacy values (`little`/`a_lot`), and extends room details payload.
- `plant_ai_watering_summary.sql` — adds `plants.watering_summary` and extends room details payload.
- `tasks_bot_reminders.sql` — adds `tasks` + `task_reminders_log`, task RPCs, and grants used by secure API and reminder worker.
- `tasks_scope_and_bot_choice.sql` — adds personal/shared task scope, bot drafts, and task visibility logic for multi-home users.
- `task_message_mode_settings.sql` — adds per-profile bot task ingestion mode (`single`/`combine`).
- `household_join_approval.sql` — adds owner-approval flow for invite joins (enabled by default), pending join requests, bot approval callbacks, and owner-only members management RPCs (`api_list_household_members`, `api_remove_household_member`).

## Current Behavior Summary

- **Production:** open only from Telegram Mini App (menu / `web_app` button). Server requires valid `initData` + `TELEGRAM_BOT_TOKEN`.
- **Local browser debug:** `npm run dev` + `DEV_BROWSER_MODE=true` + `DEV_TELEGRAM_ID` + `SUPABASE_SERVICE_ROLE_KEY` (not available on deployed Vercel preview/prod by design).
- All data access: `POST /api/secure`, `POST /api/rooms/upload`, `POST /api/rooms/analyze`, `POST /api/plants/upload`, `POST /api/plants/analyze`; RLS + RPC enforce household scope (active household from `profiles.active_household_id` when migration applied).
- **Households:** members can **rename** (`api_rename_household`) a home they belong to; owner can **delete** (`api_delete_household`) it, while non-owner can only **leave** (`leaveHousehold` secure action). Delete removes shared data for everyone; leave removes only current member access. Empty membership after delete/leave is healed by **`bootstrapUser`** inside `loadHouseholds` (default home again).
- Room thumbnails and detail images use **signed URLs**; legacy public URLs are supported via path extraction when needed.
- Upload API error mapping now converts HTTP `413` responses to a clear message (`Uploaded file is too large. Please choose a smaller photo.`) instead of exposing raw non-JSON payload text.
- **Opening a room** scrolls the page to the **top** before paint (`useLayoutEffect` in `src/app/page.tsx`) so watering markers on the image are usable without scrolling up from the list position.
- Deletions (home, room, plant) use an in-app warning modal with explicit **Continue** / **Cancel** actions instead of browser `confirm()`.
