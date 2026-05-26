# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is loosely
[Semantic](https://semver.org/) — major bump for breaking config or behavior changes, minor for
new features, patch for fixes and docs. No git tags are published yet; versions here label
notable points in `main` history.

## [Unreleased]

### Added

- **Multi-source sync.** `CONFIG.PERSONAL_CAL_IDS` accepts an array of source calendar IDs (or
  still a single string for back-compat). All sources are merged into one set of
  `Personal - Busy` blocks on the personal target — and `OOO - {Name}` blocks on the shared
  target in team mode. Event IDs are globally unique across calendars, so blocks from different
  sources never collide. Per-run log now shows `sources=N` on the start line and
  `… events from N source(s) …` on the scan line.
- New helper `sourceCalIds()` normalizes the config to a clean array of non-empty IDs.
- `initialSetup()` now validates that at least one source ID is set.

### Changed

- **Renamed `PERSONAL_CAL_ID` → `PERSONAL_CAL_IDS`** (plural). A bare string in `PERSONAL_CAL_IDS`
  is still accepted and normalized to a one-element array, so the migration is a single rename.

### Migration

1. In `Code.gs`, rename `PERSONAL_CAL_ID:` to `PERSONAL_CAL_IDS:` in your `CONFIG`.
2. (Optional) extend to multiple sources by changing the value to an array:

   ```javascript
   PERSONAL_CAL_IDS: ['me@gmail.com', 'shared@partner-workspace.com'],
   ```

3. Save and re-run `initialSetup()`.

## [0.4.0] - 2026-05-26

### Changed

- README restructured for open-source readability — standardized sections (Features / How it
  works / Requirements / Quick start / Team mode / Configuration / Verify / Troubleshooting /
  Limitations / Operational notes / Contributing / License), TOC, MIT badge, generic
  placeholders (`<source-calendar-id>`, neutral example names).
- Every function in `Code.gs` carries a JSDoc explaining *why* where non-obvious — the dual
  `assertTzMatches()` call sites, the migration backfill rationale, the `OWNER_DISPLAY_NAME` in
  `hashOfShared`, the `singleEvents`/`orderBy` coupling, etc.

### Refactored

- Extracted `pcalProps()` helper. The five `pcal*` extended-property keys had been duplicated
  verbatim in `blockBodyOwn` and `blockBodyShared`.

## [0.3.0] - 2026-05-26

### Added

- **Per-run structured logging.** Every `runSync` invocation writes start / personal-scan /
  existing-state / per-target summary / done lines to the Apps Script Executions panel.
  Steady-state collapses to `runSync[label]: no changes`; active runs show
  `+N created, ~N updated, -N deleted, N failed`. A skip-reason funnel
  (`free / unanswered+declined / cancelled`) surfaces the eligibility breakdown.
- `reconcile()` now returns
  `{ created, updated, deleted, failed, deferred }` counts.
- Lock-skip and over-budget defer paths log explicitly.

## [0.2.1] - 2026-05-26

### Changed

- `OWNER_EMAIL` is now a `CONFIG` string instead of being auto-discovered via
  `Session.getEffectiveUser()`. Removes the `userinfo.email` OAuth scope and the
  `PropertiesService` persistence/cache. Explicit > magic when the value is a one-line config.

## [0.2.0] - 2026-05-26

### Added

- **Team mode.** Optional shared OOO calendar: each colleague's all-day Busy events appear as
  `OOO - {Name}` entries. Per-user isolation via the `pcalOwner` extended property — each
  script only sees and touches its own blocks. New config: `SHARED_CAL_ID`,
  `OWNER_DISPLAY_NAME`.
- `migrateLegacyBlocks()` backfills `pcalOwner` on pre-team-mode blocks during `initialSetup()`,
  so upgrades from v0.1 don't duplicate state.

### Changed

- Default trigger interval raised from 1 min to 10 min (`SYNC_EVERY_MINUTES`). Keeps a 10-person
  team safely under the per-project Calendar API quota.
- Setup step 3 split into manual / `clasp` paths; first-run troubleshooting section added.

## [0.1.0] - 2026-05-25

### Added

- Initial solo-mode implementation. Polls the personal calendar via a time-driven trigger and
  mirrors Busy events into per-weekday segments clipped to Mon–Fri 08:00–18:00 on the work
  calendar as opaque `Personal - Busy` blocks. Recurring events expanded into individual
  instances; multi-day events get one block per weekday touched. Reconcile keyed by
  `(sourceId, date)` in `extendedProperties.private`; idempotent via `LockService`. Filters:
  Free → skip, declined/unanswered → skip.
