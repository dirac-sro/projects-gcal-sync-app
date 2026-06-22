# gcal-sync-app

One-way Google Calendar sync that mirrors privacy-stripped *busy* blocks from a personal
calendar onto a work calendar — only during configurable work hours (default Mon–Fri 08:00–18:00).

Optionally extends to a shared team calendar where each team member's all-day Out-of-Office
events automatically appear as `OOO - {Name}` entries, replacing manual OOO bookkeeping.

Runs as a Google Apps Script project. No external infrastructure, no third-party SaaS, no
credentials to store.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Step 0: Verify Workspace policy](#step-0-verify-workspace-policy)
- [Quick start (solo mode)](#quick-start-solo-mode)
- [Team mode](#team-mode-multi-user--shared-ooo-calendar)
- [Configuration reference](#configuration-reference)
- [Verifying it works](#verifying-it-works)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Operational notes](#operational-notes)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Privacy-first.** Source events are mirrored as opaque `Personal - Busy` blocks. No title,
  location, attendees, or description crosses over.
- **Multi-source.** One or more source calendars feed the same target. All sources merge into a
  single set of mirror blocks; event IDs are globally unique so blocks from different sources
  never collide.
- **Work-hour clipping.** Only the portion that falls within configured work hours is reflected;
  weekends are skipped on the personal target.
- **Recurring + multi-day support.** The Calendar API expands recurring events into individual
  instances; multi-day events get one block per weekday touched.
- **Free/Busy aware.** Only events marked Busy sync; Free always wins. Declined and unanswered
  invites are skipped.
- **Self-healing reconcile.** Every run computes desired vs. existing state and converges. No drift,
  no orphaned blocks, no duplicates — even across script restarts.
- **Optional team mode.** Each user's all-day OOO events surface on a shared team calendar as
  `OOO - {Name}`. Per-user isolation prevents the script from touching anyone else's blocks.
- **Observable.** Every run writes a structured log line to the Apps Script Executions panel.

## How it works

Each run lists eligible events on the source calendar over a rolling `now … now + HORIZON_DAYS`
window, computes the desired set of mirrored blocks, lists existing managed blocks on each target,
and reconciles the difference: create new, update changed (hash mismatch), delete orphaned.

- Recurring events are expanded into individual instances by the Calendar API
  (`singleEvents: true`); each becomes its own managed block.
- Multi-day events generate one block per weekday touched, clipped to work hours on the personal
  target; one all-day block per source event on the shared team target (no clipping).
- Managed blocks carry private extended properties: `pcalManaged=true`, `pcalOwner=<email>`,
  `pcalSourceId`, `pcalDate`, `pcalHash`. The `(pcalManaged, pcalOwner)` combination is used as
  the listing filter, providing multi-user isolation on shared targets.
- Idempotent via `LockService` + the extended-property tag. Re-runs cannot create duplicates.
- Sync is via polling, not push. Push notifications via `events.watch` require a domain verified
  in Google Cloud Console, which `script.google.com` cannot provide.

### Filtering rules

- **Busy/Free is the master switch.** Only events with `transparency` `opaque` (or unset) sync.
  Default all-day events are Free in Google Calendar and will **not** sync unless explicitly
  marked Busy.
- **Boundary-straddling events** are clipped to the work-hour window
  (e.g. `17:00–19:00` → block `17:00–18:00`).
- **Multi-day events** produce one block per weekday touched; weekends are omitted on the personal
  target, included on the shared OOO target.
- **Declined or unanswered invites are skipped.** Only Accepted and Tentative qualify.
- Mirror blocks have no description, location, attendees, or reminders.

## Requirements

- A Google account that can run Apps Script (consumer Gmail or Google Workspace).
- A second Google account (or calendar) to mirror from. The source is shared into the target
  account with **See all event details** permission.
- For team mode: all participants in the same Workspace organization, or with shared edit access
  on the team calendar.

If the target account is on managed Google Workspace, admin policy may restrict parts of this
setup. See [Step 0](#step-0-verify-workspace-policy) before investing time.

### Source must be a Google Calendar

The sync reads each source via the Google Calendar API (`Calendar.Events.list`), so every entry
in `PERSONAL_CAL_IDS` must be a **Google Calendar** reachable from the target account through
Google Calendar sharing. A non-Google personal calendar — **iCloud**, Outlook/Microsoft 365,
etc. — addressed by its native email **does not work**: the Calendar API cannot read it and
Google's *Share with specific people* flow only works between Google accounts.

A non-Google calendar can be brought in only by subscribing to its **iCal/`.ics` URL** in Google
Calendar (*Add calendar → From URL*), which creates a Google-side calendar with its own ID that
the script can then read. This path is **not recommended** because of three limitations:

1. **Stale data.** Google refreshes URL-subscribed calendars only periodically (often 12–24h),
   so Busy blocks can lag well behind the real calendar.
2. **Missing metadata.** The sync depends on each event's `transparency` (busy/free) and the
   user's `responseStatus` (declined / unanswered are skipped). `.ics` feeds frequently omit
   these, so filtering becomes unreliable — events may all read as Busy, or be dropped.
3. **Read-only.** The subscription is one-way, which suits this sync, but the limitations above
   still apply.

Not handled for now — if a teammate's personal calendar lives on iCloud/Outlook, keep it as (or
mirror it into) a Google Calendar and share that.

## Step 0: Verify Workspace policy

Confirm the target account permits all of the following **before** installing:

1. **Apps Script project creation.** Open [script.google.com](https://script.google.com) in the
   target account → *New project*. If creation is blocked, this approach won't work.
2. **Adding an external or cross-account calendar.** If the source calendar lives in a different
   account, the target must be able to accept the share. If admin policy blocks external
   calendars, this approach won't work.
3. **Advanced Calendar Service** enabled in the bound Cloud project (the script enables this in
   step 3 of Quick Start; some orgs disallow it).

### Fallback paths

- **Apps Script blocked in target, but the target calendar can be shared to the source account
  with edit access** → run the script in the source account, write to the shared target.
  Outbound edit sharing is what Workspace most often restricts; usually requires IT.
- **Both blocked** → use a third-party tool such as [Reclaim.ai](https://reclaim.ai),
  [OneCal](https://onecal.io), or [Cron/Notion Calendar](https://calendar.com); or build an
  external service on Cloud Run with OAuth. Out of scope here.

## Quick start (solo mode)

Solo mode mirrors a source calendar to a single target calendar within work hours. No team
calendar involved.

### 1. Share the source calendar into the target account

**Source account:**

- Google Calendar → settings for the calendar you want to mirror → *Share with specific people
  or groups* → add the target account's email with permission **See all event details**.
- Copy the calendar ID (shown lower on the same settings page; for a primary calendar this is
  the email address itself).

**Target account:**

- Open the email invitation Google sends and click the **Add this calendar** link.
- Verify in [calendar.google.com](https://calendar.google.com) that the source calendar appears
  under *Other calendars*.

> **Important:** Until the share is accepted in the target account, the Apps Script API returns
> `404 Not Found` for that calendar ID.

### 2. Create the Apps Script project

In the **target** account, open [script.google.com](https://script.google.com) → *New project*.
Rename to `gcal-sync-app`. Choose one of:

**Manual (recommended for first install):**

- *Project Settings* (gear icon, left rail) → check **Show 'appsscript.json' manifest file**.
- In the editor: delete the default `function myFunction() { … }`, then paste in the contents of
  [`Code.gs`](Code.gs) from this repo. Open `appsscript.json` and replace its contents with the
  [manifest](appsscript.json) from this repo.

**Via [clasp](https://github.com/google/clasp):**

```bash
npm install -g @google/clasp
clasp login                                  # sign in with the target account
clasp create --type standalone \
  --title gcal-sync-app --rootDir .
clasp push
```

You still have to enable the Calendar API in the editor (next step) — `clasp` does not.

### 3. Enable the Calendar API

Editor → *Services* (`+` icon, left rail) → enable **Calendar API (v3)**.

### 4. Configure

In `Code.gs`, edit the `CONFIG` block at the top of the file:

```javascript
const CONFIG = {
  PERSONAL_CAL_IDS:   ['<source-calendar-id>'],  // one or more sources from step 1
  WORK_CAL_ID:        'primary',                  // target calendar; usually 'primary'
  OWNER_EMAIL:        '<target-account-email>',   // used to tag managed blocks. Required.
  TZ:                 'Europe/Prague',            // must match appsscript.json#timeZone
  WORK_START_HOUR:    8,
  WORK_END_HOUR:      18,
  HORIZON_DAYS:       90,
  SYNC_EVERY_MINUTES: 10,
  // ... see Configuration reference for the rest
};
```

To mirror **multiple source calendars** (e.g. a personal Gmail plus a calendar shared in from
another Workspace), list them all in `PERSONAL_CAL_IDS`:

```javascript
PERSONAL_CAL_IDS: [
  'me@gmail.com',
  'shared-from-partner-workspace@group.calendar.google.com',
],
```

All sources are merged into one set of `Personal - Busy` blocks on the target. Repeat the
sharing flow from step 1 for each additional source.

For team mode, also set `SHARED_CAL_ID` and `OWNER_DISPLAY_NAME` — see
[Team mode](#team-mode-multi-user--shared-ooo-calendar).

### 5. Install the trigger and run the first sync

In the editor toolbar, **select `initialSetup` from the function dropdown** next to the *Run*
button, save (Ctrl/Cmd-S), then click *Run*. Grant the requested OAuth scopes when prompted.

`initialSetup` installs a time-driven trigger firing every `SYNC_EVERY_MINUTES` and runs the
first reconcile.

> If the source calendar has many future events and `HORIZON_DAYS` is large, the first run may
> approach the 6-minute execution limit. The reconcile is budget-aware and resumes on the next
> trigger tick; or temporarily lower `HORIZON_DAYS` for the first run.

### 6. Set up failure notifications

Editor → *Triggers* (clock icon, left rail) → on the `runSync` trigger row, *Edit* → *Failure
notification settings* → **Notify me immediately**.

Apps Script auto-disables triggers after repeated failures (typically caused by revoked shares
or expired auth). This notification is how you find out.

## Team mode (multi-user + shared OOO calendar)

Team mode adds a second target: a single shared team calendar where each user's **all-day Busy**
events appear as `OOO - {Name}` entries. Replaces manual OOO entry on a team calendar.

Each user installs their own copy of the script in their own account. All installs write to the
same shared calendar. Per-user isolation is enforced via the `pcalOwner` extended property —
each script only ever sees and touches its own blocks.

### One-time admin setup

1. **Create or designate a shared team calendar.** In any team member's account,
   [Google Calendar](https://calendar.google.com) → *+* next to *Other calendars* → *Create new
   calendar*. Or repurpose your existing manual OOO calendar.
2. **Grant edit access** to every team member: calendar settings → *Share with specific people
   or groups* → add each member's work email with **Make changes to events**. Read-only is not
   enough.
3. **Distribute the calendar ID.** Calendar settings → *Integrate calendar* → *Calendar ID*
   (typically `xxxxxxxxxx@group.calendar.google.com`). Every team member pastes this into
   `SHARED_CAL_ID`.

### Per-user setup

Each team member follows the [Quick Start](#quick-start-solo-mode), and in step 4 additionally
fills in:

- `SHARED_CAL_ID` = the calendar ID from admin step 3 (same for everyone).
- `OWNER_DISPLAY_NAME` = the user's display name (e.g. `'Jane Doe'`). Becomes the title
  `OOO - Jane Doe` on the shared calendar.

### What syncs where

| Personal event type            | Personal target           | Shared team target                     |
|--------------------------------|---------------------------|----------------------------------------|
| Timed Busy (e.g. doctor 14:00) | per-weekday clipped 08-18 | not synced                             |
| All-day Busy (e.g. vacation)   | per-weekday clipped 08-18 | full duration, all-day, `OOO - {Name}` |
| All-day Free (default)         | not synced                | not synced                             |
| Declined / unanswered invite   | not synced                | not synced                             |
| Weekend-only Busy              | not synced (weekend skip) | full duration if all-day               |

### Migrating from manually-typed OOO entries

Pre-existing manually-typed OOO entries on the shared calendar have no `pcalManaged` tag, so the
script ignores them — they're not deleted, not updated. Stop adding new ones manually; old ones
pass into the past or you remove them by hand once.

## Configuration reference

All configuration lives in the `CONFIG` block at the top of [`Code.gs`](Code.gs).

| Constant             | Default               | Notes                                                                                                                      |
|----------------------|-----------------------|----------------------------------------------------------------------------------------------------------------------------|
| `PERSONAL_CAL_IDS`   | placeholder array     | One or more source calendar IDs. Each must be shared into the target account. Accepts a single string for back-compat.     |
| `WORK_CAL_ID`        | `'primary'`           | Target calendar; usually the script account's primary calendar.                                                            |
| `OWNER_EMAIL`        | placeholder           | **Required.** Tagged onto every managed block as `pcalOwner` so reconcile only ever touches your own.                      |
| `SHARED_CAL_ID`      | `''`                  | Team OOO calendar ID. Empty = solo mode, no shared writes.                                                                 |
| `OWNER_DISPLAY_NAME` | `''`                  | Required if `SHARED_CAL_ID` set. Goes into `OOO - {name}` title.                                                           |
| `TZ`                 | `'Europe/Prague'`     | Must match `appsscript.json#timeZone`.                                                                                     |
| `WORK_START_HOUR`    | `8`                   | Inclusive.                                                                                                                 |
| `WORK_END_HOUR`      | `18`                  | Exclusive.                                                                                                                 |
| `HORIZON_DAYS`       | `90`                  | Rolling sync window. Lower for faster first run.                                                                           |
| `BUSY_TITLE`         | `'Personal - Busy'`   | Title for personal-target blocks. Shared title is fixed to `OOO - {name}`.                                                 |
| `SYNC_EVERY_MINUTES` | `10`                  | Trigger interval. Valid: 1, 5, 10, 15, 30.                                                                                 |
| `RUN_BUDGET_MS`      | `300000` (5 min)      | Execution budget; bails before hitting the 6-min Apps Script hard limit.                                                   |

### Script Properties (optional web-app onboarding)

The optional self-service onboarding web app ([`WebApp.gs`](WebApp.gs) + [`SetupForm.html`](SetupForm.html))
reads two deployment-specific values from **Project Settings → Script Properties**, so they stay
out of source and each deployment configures its own:

| Property       | Purpose                                                                                  |
|----------------|------------------------------------------------------------------------------------------|
| `TEAM_CAL_ID`  | Shared team calendar ID for `OOO - {name}` blocks. Unset = team mode has nowhere to write. |
| `SETUP_URL`    | The deployed web-app `/exec` URL, used in the failure-recovery email link.               |

## Verifying it works

After installation, on the source calendar:

- Create a timed event Tue 10:00–10:30 → within ~`SYNC_EVERY_MINUTES` a `Personal - Busy`
  10:00–10:30 appears on the target.
- Move it to 11:00 → target block moves (update path; no duplicate).
- Delete it → target block disappears.
- Create one Sat 10:00 and one Tue 20:00 → no target blocks (weekend / out-of-hours filter).
- Create a Tue 17:00–19:00 event → target block clipped to 17:00–18:00.
- Mark a Tue event Free → no target block; if previously synced, the block is removed.
- Create a 3-day all-day event marked Busy spanning a weekend → target blocks 08:00–18:00 each
  weekday; no Sat/Sun. A default (Free) all-day event → no blocks.
- Edit one occurrence of a recurring weekly event to Free → only that week's target block
  disappears.
- Receive an invite from a third party without responding (status remains *Needs action*) → no
  target block. Accept → block appears. Decline → block disappears.
- Run `runSync()` manually a few times → no duplicates (idempotency).

**Team mode only:**

- Create an all-day Busy event Mon–Wed on the source → personal target gets a clipped block
  08-18 each weekday; shared calendar gets one all-day `OOO - {YourName}` block spanning Mon–Wed.
- Have a colleague (also running the script) create their own all-day event → both OOO entries
  coexist on the shared calendar without overwriting.
- Delete the all-day event → personal block and shared OOO disappear; colleague's OOO is
  untouched.
- Change `OWNER_DISPLAY_NAME` and re-run `initialSetup()` → existing shared blocks re-title to
  the new name (hash-driven update path).

### Reading the logs

In Apps Script Executions, each run writes one line per phase. Healthy steady-state run looks
like:

```text
runSync: start mode=solo owner=user@example.com horizon=90d
runSync: personal scan = 42 events (skipped: 35 free, 0 unanswered/declined, 0 cancelled) → 7 eligible, 9 own segments, 0 shared OOO
runSync: existing managed = 9 on own
runSync[own]: no changes
runSync: done in 1843ms
```

When something changed: `runSync[own]: +2 created, ~1 updated, -0 deleted, 0 failed`. The
`+ / ~ / -` mapping is *created / updated (hash changed) / deleted (no longer desired)*.

## Troubleshooting

- **`Attempted to execute myFunction, but it was deleted`** — the Run button executes whichever
  function is selected in the toolbar dropdown, and it's still pointing at the deleted default.
  Select `initialSetup` from the dropdown and save (Ctrl/Cmd-S) before running.
- **`Script timezone X does not match CONFIG.TZ Y`** — `assertTzMatches()` is firing on purpose;
  segment math and date keys must agree. Fix one of:
  - Apps Script editor → *Project Settings* → *Time zone* → match `CONFIG.TZ`, or
  - Edit `appsscript.json#timeZone` and `CONFIG.TZ` to name the same zone.

  Note: `Europe/Prague` and `Europe/Bratislava` (and other same-offset zones) are functionally
  identical — same offset, same DST.
- **`Not Found` / 404 on `Calendar.Events.list`** — the source calendar share was not accepted in
  the target account; or `SHARED_CAL_ID` is wrong / lacks *Make changes* permission for this user.
- **`OWNER_EMAIL is empty`** — set it in `CONFIG` and re-run `initialSetup()`.
- **`PERSONAL_CAL_IDS is empty`** — set at least one source calendar ID. If you're upgrading from
  a version that used the singular `PERSONAL_CAL_ID`, rename the field; the new name is plural
  and takes either a single string or an array. See [CHANGELOG.md](CHANGELOG.md).
- **`SHARED_CAL_ID is set but OWNER_DISPLAY_NAME is empty`** — team mode requires both.
- **First `initialSetup()` runs slow or risks the 6-min limit** — temporarily lower
  `HORIZON_DAYS` to `14`, run `initialSetup()` (fast), then bump back to `90` and run `runSync()`
  manually. The budget-aware reconcile + next trigger ticks fill the remaining window.
- **Duplicate blocks after enabling team mode** — re-run `initialSetup()`. It backfills
  `pcalOwner` on pre-existing managed blocks so the owner-filtered listing finds them.

## Limitations

- **Polling, not push.** Latency equals `SYNC_EVERY_MINUTES` (default 10 min). Push notifications
  via `events.watch` require a verified domain, which Apps Script's `script.google.com` host
  cannot provide. For sub-minute latency, move the receiver to a Cloud Run / Cloud Functions
  service with a verified custom domain.
- **Past blocks accumulate.** Mirrored blocks remain on the target calendar after the source
  event passes. Add a periodic cleanup if a clean history matters.
- **Single source per install.** Each Apps Script project mirrors exactly one personal calendar
  to one target (plus an optional shared OOO target). To mirror multiple sources, install
  multiple projects or extend the code.
- **Rolling-window horizon.** Events scheduled beyond `HORIZON_DAYS` aren't synced until the
  window advances (which happens on every run).
- **All-day events default to Free.** Vacations, OOO, and similar will not sync unless explicitly
  marked Busy on the source calendar.

## Operational notes

- **Quota.** At `SYNC_EVERY_MINUTES=10` each install does 2 list calls per run in solo mode (3 in
  team mode), plus a few writes only when something changed. Roughly 430–650 Calendar API calls
  per user per day. A 10-user team writing to one shared calendar burns ~6000 calls/day team-wide
  — well under the project-level 1M/day Calendar API quota.
- **Execution time.** Each run finishes in 1–5 seconds in steady state. Workspace accounts have
  a 6 hr/day Apps Script execution quota; this script uses ~30–60 minutes/day in steady state.
- **Sync interval trade-off.** `1` minimizes latency but uses 10× more API calls. `10` is the
  safe default for team mode. `30` minimizes API usage and execution time but raises latency to
  up to 30 minutes.
- **Recovery.** If a trigger run fails (auth expiry, revoked share, transient quota), the next
  tick retries automatically. Configure failure notifications on the trigger so you find out
  before Apps Script auto-disables it.

## Contributing

Issues and pull requests are welcome.

The script is deliberately small (single `Code.gs`); features should land in the core only when
they generalize beyond a single user's workflow. For larger ideas, open an issue first to
discuss scope.

Guidelines for changes:

- Keep `Code.gs` self-contained — no Apps Script library dependencies.
- New behavior should be observable via the per-run `console.log` lines in `runSync`.
- Any new managed-block metadata goes under `extendedProperties.private` with a `pcal*` prefix.
- Preserve idempotency: every state transition must be derivable from `(desired, existing)`
  without external state beyond `extendedProperties`.

## License

[MIT](LICENSE).
