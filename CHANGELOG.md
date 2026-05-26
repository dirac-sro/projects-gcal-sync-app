# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions loosely follow
[SemVer](https://semver.org/) and label notable points in `main`; no git tags yet.

**Policy:** every commit that touches user-visible behavior bumps a version in this file. No
`[Unreleased]` section is kept — a committed change is a released change.

## [0.5.0] - 2026-05-26

### Added

- **Multi-source sync.** `PERSONAL_CAL_IDS` accepts an array of source calendar IDs; all sources
  merge into one set of mirror blocks on the target.

### Changed

- Renamed `PERSONAL_CAL_ID` → `PERSONAL_CAL_IDS`. A single string still works.

### Migration

Rename the field in your `CONFIG`. Save and re-run `initialSetup()`.

## [0.4.0] - 2026-05-26

- README restructured for open-source readability; every function in `Code.gs` documented.

## [0.3.0] - 2026-05-26

### Added

- Per-run structured logs in the Apps Script Executions panel — each run reports
  created/updated/deleted counts and the skip-reason funnel.

## [0.2.1] - 2026-05-26

### Changed

- `OWNER_EMAIL` is a `CONFIG` string instead of being auto-discovered. Removes the
  `userinfo.email` OAuth scope.

## [0.2.0] - 2026-05-26

### Added

- **Team mode.** Optional shared OOO calendar — each user's all-day Busy events appear as
  `OOO - {Name}`. Per-user isolation via `pcalOwner`.

### Changed

- Default trigger interval raised from 1 min to 10 min (`SYNC_EVERY_MINUTES`).

## [0.1.0] - 2026-05-25

- Initial solo-mode implementation. Mirrors Busy events from personal calendar to work calendar,
  clipped to Mon–Fri 08:00–18:00.
