# Project Backlog

## Notes (Current Behavior Alignment)

- Household action label/behavior in `Settings` is intentionally role-based:
  - owner: `Delete` -> deletes household
  - non-owner: `Leave` -> leaves household without deleting it
- Room/plant photo upload `413 FUNCTION_PAYLOAD_TOO_LARGE` issue is closed:
  - unified client compression helper is used across room + plant flows
  - uploads are capped to ~4 MB after compression/downscale
  - if still too large, UI shows explicit guidance before request
  - backend `413` is mapped to a readable client error text

## Epic: Deterministic Species Watering Catalog

Status: Planned  
Priority: P0

Goal: make watering thresholds predictable for the same species by moving threshold authority from per-request AI generation to a deterministic species catalog.

### P0 - Architecture and contract

- [ ] **Split AI responsibilities**
  - AI returns only vision/classification payload: `plant_id`, `plant_name`, `confidence`, `is_plant`.
  - Keep AI-generated care text as optional descriptive output.
- [ ] **Define canonical species model**
  - Canonical key: `plant_id`.
  - Add aliases/synonyms map (`peace lily`, `spathiphyllum`, etc.).
- [ ] **Define threshold source model**
  - Persist source on plant: `catalog | ai_fallback | manual`.
  - Persist `catalog_version` used at assignment time.

### P0 - Catalog implementation

- [ ] **Create catalog storage**
  - Start with versioned JSON in repo or DB table (decide one source of truth).
  - Record per species: `thirsty_after_hours`, `overdue_after_hours`, `water_volume`.
- [ ] **Implement resolver**
  - Resolve canonical `plant_id` via alias normalization.
  - If found in catalog, apply deterministic thresholds.
  - If not found, use AI fallback thresholds + existing safety rails.
- [ ] **Add confidence gates**
  - High confidence: auto-apply.
  - Medium confidence: allow apply with review warning.
  - Low confidence: do not auto-apply.

### P1 - Data and migration

- [ ] **Seed initial catalog (80/20)**
  - Add top 20-40 common indoor species first.
  - Set baseline for standard indoor conditions (living room, average humidity, ~20-22C).
- [ ] **Prepare migration strategy**
  - Keep existing plants unchanged by default.
  - Optional action later: "re-apply catalog thresholds" per plant/species.
- [ ] **Backfill analytics metadata**
  - For existing plants, set best-effort `threshold_source` where possible.

### P1 - Operational process

- [ ] **Unknown-species queue**
  - Log unknown/fallback species events for review.
- [ ] **Human review workflow**
  - Use AI suggestions only as draft; human approves catalog entries.
- [ ] **Catalog release discipline**
  - Version catalog updates (`v1`, `v2`, ...).
  - Keep change log of threshold updates and rationale.

### P2 - UX improvements

- [ ] **Explain threshold origin in UI**
  - Show subtle label: `From species catalog` / `AI fallback` / `Manual`.
- [ ] **Bulk apply utility**
  - Add action: apply current species defaults to selected plants.
- [ ] **Settings controls**
  - Optional toggle for default behavior on medium-confidence matches.

## Epic: Task Ingestion and Link Parsing

Status: Planned  
Priority: P1

Goal: improve incoming task quality for forwarded content, including URLs.

### P1 - Link-aware task parsing

- [ ] **Fetch and summarize URL content for task parsing**
  - If message includes URL, server fetches page title + short excerpt (with timeout and size limits).
  - Pass fetched context to AI parser to infer better title/deadline/priority.
- [ ] **Safety and reliability**
  - Only allow `http/https`.
  - Block private/localhost IP ranges.
  - Graceful fallback when URL is inaccessible or requires auth.

### Done criteria

- [ ] New plants of the same canonical species receive stable deterministic thresholds.
- [ ] AI fallback is used only for species missing in catalog.
- [ ] Threshold source and version are visible in data and debuggable.
- [ ] First catalog release covers majority of common user plants.

## Epic: Admin Panel Hardening and Operations

Status: Planned  
Priority: P0

Goal: move current admin MVP to production-grade security, reliability, and operator ergonomics.

### P0 - Security hardening

- [ ] **Replace password-only login with Supabase Auth**
  - Add magic link or OAuth login for admins.
  - Keep `admin_users` allowlist as second gate after auth.
- [ ] **Add optional 2FA for privileged roles**
  - Require step-up auth for `owner` and `security`.
- [ ] **Add account lockout/rate limit for admin login**
  - Throttle by IP/email fingerprint and log all failed attempts.
- [ ] **Rotate and version admin session secrets**
  - Support active/previous `ADMIN_SESSION_SECRET` during rotation window.

### P0 - Platform safety and controls

- [ ] **Extend block model beyond temporary/permanent**
  - Add `readonly` and feature-scoped blocks (`ai`, `bot`, `join`).
- [ ] **Add admin notes and escalation workflow**
  - Structured notes on profile blocks and incident context.
- [ ] **Require mandatory reason taxonomy**
  - Standard reasons (spam, abuse, compromised account, etc.) for analytics quality.

### P1 - Observability and incident response

- [ ] **Security events filters and saved views**
  - Filter by severity/source/action/profile and persist common views.
- [ ] **Add simple alerting pipeline**
  - Trigger alerts for spikes in blocked requests, login failures, and critical events.
- [ ] **Incident timeline view**
  - Per user timeline that merges API events, blocks, and admin actions.

### P1 - Admin UX and governance

- [ ] **Manage admin users from UI**
  - Invite/deactivate admins and change roles with owner-only permissions.
- [ ] **Audit log viewer in admin panel**
  - Read/search/export `admin_audit_log` without direct SQL.
- [ ] **Safer block/unblock UX**
  - Confirmation dialogs, expiry presets, and undo window for accidental actions.

### P2 - Data quality and retention

- [ ] **Retention policy for telemetry tables**
  - Define TTL/archival for `api_request_events`, `security_events`, and `admin_audit_log`.
- [ ] **PII minimization review**
  - Re-validate hashed metadata strategy and remove unnecessary fields.
- [ ] **Materialized KPI views**
  - Add daily/hourly rollups for low-cost dashboard rendering at scale.
