# Project Backlog

## Notes (Current Behavior Alignment)

- Household action label/behavior in `Settings` is intentionally role-based:
  - owner: `Delete` -> deletes household
  - non-owner: `Leave` -> leaves household without deleting it

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
