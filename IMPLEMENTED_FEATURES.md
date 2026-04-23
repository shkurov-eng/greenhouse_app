# GreenHouse App - Implemented Features (Current State)

This document summarizes what has already been implemented in the project.

## Tech Stack and Base Setup

- Next.js app with TypeScript.
- Supabase client is simplified to a single client file:
  - `src/lib/supabase.ts`
- Environment variables used:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Git repository initialized for the project.

## Stage 1 - Foundation

- Telegram Mini App integration is implemented in `src/app/page.tsx`.
- Telegram SDK script is loaded in `src/app/layout.tsx`:
  - `https://telegram.org/js/telegram-web-app.js`
- Telegram user handling:
  - Reads `window.Telegram?.WebApp?.initDataUnsafe?.user`
  - Saves user to `profiles` table (`telegram_id`, `username`)
- Debug mode support:
  - If Telegram user is missing, mock user can be used in development.
  - Query flag support: `?debugTelegram=1`
- Console debug logging and runtime checks were implemented and then cleaned up where needed.

## Stage 2 - Households

- Household logic implemented in app flow:
  - Fetch profile by `telegram_id`
  - Check membership in `household_members`
  - If missing:
    - Create household (`My Home`)
    - Link user to household
  - If existing:
    - Reuse existing household
- Join-home functionality implemented:
  - `households.invite_code` support added
  - Current home card shows invite code
  - User can join another home via invite code modal
  - Membership is switched by updating current user's `household_members.household_id`

## Stage 3 - Rooms

- Rooms database setup:
  - `rooms` table with `household_id`, `name`, `background_url`, timestamps
  - index on `household_id`
- Rooms Storage setup:
  - Supabase Storage bucket `rooms`
  - Storage RLS policies for public read/insert/update on `rooms` bucket
- Rooms UI:
  - Rooms list view
  - Room detail view
  - Floating add-room button (`+`) in mobile UI
  - Add room modal
- Room image upload:
  - Upload image per room to Supabase Storage
  - Save public URL into `rooms.background_url`
  - Show upload status in UI
- Image display behavior:
  - Room detail uses `object-contain` to avoid clipping on mobile

## Stage 4 - Plants and Markers

- Plants schema support:
  - `plants` table used with fields:
    - `household_id`, `room_id`, `name`, `species`, `status`
    - `last_watered_at` support added
- Markers schema support:
  - `plant_markers` table with normalized coordinates:
    - `x`, `y` in range `0..1`
  - One marker per plant via unique index on `plant_id`
- Plant features:
  - Add plant modal in room detail
  - Plant list in room detail
  - Edit plant dialog:
    - edit `name`, `species`, `status`
    - action button to edit marker
- Marker placement flow was simplified:
  - Marker selection dropdown was removed from room detail
  - Marker editing is now initiated from `Edit Plant`
  - `Edit marker` inside the plant edit dialog enables marker placement mode
- Marker features:
  - Markers rendered as pins on top of room image
  - Marker tooltip with plant name and status
  - Marker colors based on status:
    - healthy / thirsty / overdue
  - Marker position is locked by default
  - Marker position changes only in explicit marker edit mode
  - Marker edit mode can be canceled
- UX flow:
  - After adding a plant, app automatically enters marker placement mode for that new plant
  - User can tap image to place marker immediately

## Stage 5 - Watering

- Watering action implemented:
  - `Watered` button on each plant
  - Updates:
    - `last_watered_at = now()`
    - `status = healthy`
- Marker tap behavior:
  - Tapping a marker marks that plant as watered
- Visual feedback:
  - Marker shows short highlight/flash animation when watered
- Status automation (debug thresholds currently enabled):
  - Status is recalculated from `last_watered_at` on room load
  - Current debug timing:
    - `thirsty` after 5 minutes
    - `overdue` after 1 hour

## UI / Design System Work

- Main screens were refactored to match the Stitch mockup style (`_ui_mockups`):
  - Warm color palette
  - Plus Jakarta Sans typography
  - Material Symbols icons
  - Rounded cards, soft shadows, mobile-first spacing
- Added structured app shell behavior:
  - Header styles for overview and detail
  - Bottom navigation visual layer
  - Mobile floating action button
- Mobile modal fixes:
  - Add Room and Add Plant dialogs are now above bottom nav
  - Extra bottom padding and scroll handling to keep action buttons accessible

## SQL / Migration Files Present

- `rooms.sql`
  - rooms table, index, storage bucket creation, storage policies
- `plants.sql`
  - plants table and updates (including status and last_watered_at)
  - plant_markers table and indexes
- `households_join.sql`
  - adds `invite_code` to `households`
  - unique index for invite code
- `security_hardening.sql`
  - enables RLS for core tables
  - revokes direct `anon/authenticated` table access
  - adds `SECURITY DEFINER` RPC functions (`public.api_*`)
  - switches `rooms` Storage bucket to private policies for `service_role`
  - adds `rooms.background_path` for private image flow

## Current Behavior Summary

- User opens app via Telegram Mini App (or local browser debug mode).
- Identity is resolved server-side:
  - Telegram `initData` verification (signature check)
  - or dev fallback from server env when `DEV_BROWSER_MODE=true`.
- Browser uses secure API endpoints instead of direct table queries:
  - `POST /api/secure`
  - `POST /api/rooms/upload`
- Household/rooms/plants/markers operations run through RPC functions with membership and ownership checks.
- Room images are uploaded to private Storage and returned via signed URLs.
