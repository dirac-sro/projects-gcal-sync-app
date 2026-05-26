# gcal-sync-app

One-way Google Calendar sync: when an event appears on your **personal** calendar within
**Mon–Fri 08:00–18:00**, a privacy-stripped `Personal - Busy` block appears on your **work**
calendar. Colleagues see you're busy; they don't see what for.

Runs as a Google Apps Script project hosted in your **work** account, polled by a time-driven
trigger (default every 10 min, configurable). Latency ≈ trigger interval.

**Team mode (optional):** if you also fill in `SHARED_CAL_ID` + `OWNER_DISPLAY_NAME`, each of your
**all-day Busy** events additionally creates an `OOO - {Name}` all-day block on a shared team
calendar — same one your colleagues use today for vacations. Timed events stay on your own
calendar only. See *Team mode* below.

## How it works (in one paragraph)

The script lists eligible personal events in a rolling `now … now+HORIZON_DAYS` window, computes
per-weekday segments clipped to work hours, lists already-managed work blocks (tagged via
`extendedProperties.private`), and reconciles the two sets: create missing, update changed (by
start/end hash), delete orphaned. Every personal event → zero or more work blocks (one per weekday
it intersects). Recurring events are expanded into individual instances by the Calendar API.
Idempotent via `LockService` + the extendedProperty tag, so polling never duplicates.

## Step 0 — verify Workspace allows this BEFORE you write anything

Your work account is Workspace-managed. If admin policy blocks any of these, the primary plan can't
ship. Check **first**:

1. **Apps Script + Advanced Calendar Service usable in your work account?** Open
   [script.google.com](https://script.google.com) signed into the work account → New project. If
   creation is blocked or the Advanced Service can't be enabled, skip to *Fallback* below.
2. **Can the work account add an external (consumer) Google calendar?** Try sharing your personal
   calendar to the work email (next section, step 1) and accepting it in the work account. If the
   share never appears or your admin blocks external calendars, skip to *Fallback*.

**Fallback decision tree:**

- Both above OK → primary plan (this repo). ✅
- Apps Script blocked in work, but **work calendar can be shared to personal with "Make changes"** →
  host the same code in your **personal** account, flip `PERSONAL_CAL_ID` / `WORK_CAL_ID`, and write
  to the shared work calendar. Outbound work→external edit sharing is what Workspace most often
  restricts — usually needs IT.
- Both blocked → use an off-the-shelf tool (Reclaim, OneCal) or move the script to Cloud Run with
  OAuth. Out of scope here.

## Setup

1. **Personal account** — Google Calendar → settings → *Share with specific people* → add your work
   email with permission **"See all event details."** Copy the personal calendar ID (your personal
   email address).
2. **Work account** — open the email invitation Google sends and **click the link to add the shared
   calendar.** Confirm in [calendar.google.com](https://calendar.google.com) that the personal
   calendar appears under *Other calendars*. ⚠️ Until you accept the share, the Apps Script API will
   return `404` for that calendar ID.
3. **Work account** — [script.google.com](https://script.google.com) → *New project*. Rename to
   `gcal-sync-app`. Then pick one path:

   **A) Manual (recommended first time):**
   - *Project Settings* (gear icon, left rail) → tick **"Show 'appsscript.json' manifest file"** →
     this makes the manifest visible in the editor.
   - Back in the editor: delete the default `function myFunction() { … }`, paste in the contents of
     `Code.gs` from this repo. Open the now-visible `appsscript.json` and replace its contents with
     the manifest from this repo.

   **B) Via [`clasp`](https://github.com/google/clasp):**
   - `npm i -g @google/clasp`
   - `clasp login` (sign in with the work account)
   - In this repo dir: `clasp create --type standalone --title gcal-sync-app --rootDir .` →
     `clasp push`
   - You still have to enable the Calendar API in the editor (next step) — `clasp` won't do it.
4. **Editor → Services → +** → enable **Calendar API (v3)**.
5. Edit the `CONFIG` block at the top of `Code.gs`:
   - `PERSONAL_CAL_ID` = your personal email (the calendar ID you copied).
   - `WORK_CAL_ID` stays `'primary'` (script writes to the work account's own primary calendar).
   - `OWNER_EMAIL` = your **work** email. Used as a stable key tagged onto every managed block so
     the reconcile listing can tell yours apart from a colleague's (team mode) or from any legacy
     untagged block. Required even in solo mode.
   - `TZ` matches `appsscript.json#timeZone` (both default to `Europe/Prague`).
   - `WORK_START_HOUR`, `WORK_END_HOUR`, `HORIZON_DAYS`, `SYNC_EVERY_MINUTES` as you like.
   - For team mode also fill `SHARED_CAL_ID` and `OWNER_DISPLAY_NAME` — see *Team mode*. Leave
     empty for solo.
6. Run `initialSetup()` once: in the editor toolbar, **select `initialSetup` from the function
   dropdown** next to the *Run* button, save (Ctrl/Cmd-S), then click *Run*. Grant the OAuth scopes
   when prompted. It installs the trigger at `SYNC_EVERY_MINUTES` and runs the first reconcile.
   **Re-run `initialSetup()` after any CONFIG change** (especially toggling team mode) — it also
   migrates any pre-existing managed blocks to the owner-tagged format.
7. **Failure notifications** — Apps Script editor → Triggers (clock icon, left rail) → on the
   `runSync` trigger row, *Edit* → *Failure notification settings* → **Notify me immediately**. The
   trigger auto-disables after repeated failures (typically if you revoke the share or hit auth
   issues), and you want to know.

## Troubleshooting first run

- **`Attempted to execute myFunction, but it was deleted`** — the *Run* button executes whichever
  function is selected in the toolbar dropdown, and it's still pointing at the deleted default.
  Pick `initialSetup` from the dropdown next to *Run*; save first (Ctrl/Cmd-S), otherwise newly
  added functions don't show up.
- **`Script timezone X does not match CONFIG.TZ Y`** — `assertTzMatches()` fires on purpose; segment
  math and date keys must agree. Fix one of:
  - Apps Script editor → *Project Settings* (gear, left rail) → *Time zone* → match `CONFIG.TZ`, or
  - Edit `appsscript.json#timeZone` **and** `CONFIG.TZ` to name the same TZ.
  (`Europe/Prague` and `Europe/Bratislava` are functionally identical — same offset, same DST.)
- **First `initialSetup()` with `HORIZON_DAYS=90` runs slow / risks the 6-min hard limit** — start
  with `HORIZON_DAYS: 14`, run `initialSetup()` (fast), then bump back to `90` and run `runSync()`
  manually. The budget-aware reconcile + 1-min trigger fills the rest over the next few minutes.
- **`Not Found` / 404 on `Calendar.Events.list`** — the personal calendar share hasn't been
  accepted in the work account yet, or `SHARED_CAL_ID` is wrong / the admin hasn't granted you
  *Make changes* on the shared team calendar. See Setup step 2 and the *Team mode* section.
- **After enabling team mode, duplicate blocks appear on own primary** — you forgot to re-run
  `initialSetup()`. It backfills `pcalOwner` on legacy blocks so the new owner-filtered listing
  finds them; otherwise the script doesn't see them and creates fresh ones.
- **`SHARED_CAL_ID is set but OWNER_DISPLAY_NAME is empty`** — team mode needs both. Fill the
  display name in CONFIG and re-run `initialSetup()`.
- **`OWNER_EMAIL is empty`** — set `OWNER_EMAIL` in CONFIG to your work email and re-run
  `initialSetup()`. This value is used to tag your managed blocks; without it the reconcile can't
  isolate yours from anyone else's.

## Verify (do all of these once)

On the personal calendar:

- Create a timed event **Tue 10:00–10:30** → within ≤1 min a `Personal - Busy` 10:00–10:30 appears
  on the work calendar.
- Move it to 11:00 → the work block moves (update path; no duplicate).
- Delete it → the work block disappears (delete path).
- Create one **Sat 10:00** and one **Tue 20:00** → **no** block (weekend / out-of-hours filter).
- Create a **Tue 17:00–19:00** event → block clipped to **17:00–18:00**.
- Mark a Tue event as **Free** → no block; if previously synced, the block is removed.
- Create a 3-day **all-day** event and **mark it Busy**, spanning a weekend → busy `08:00–18:00` on
  each weekday only, none on Sat/Sun. A default (Free) all-day event → no blocks.
- Create a weekly recurring meeting Tue 10:00; in Calendar, edit **just one occurrence** and mark
  it Free → only that week's block disappears; the others stay.
- Have someone invite you to a Tue 14:00 event on your personal calendar and **don't respond**
  (status stays *Needs action*) → no work block. Accept it → block appears. Decline it → block
  disappears.
- Run `runSync()` manually a few times from the editor → no duplicates appear (idempotency).
- Apps Script editor → *Executions* → confirm no errors and runs complete well under 6 min.
  Click any `runSync` row to see its log. A healthy steady-state run looks like:

  ```
  runSync: start mode=solo owner=adam.pagac@alistiq.com horizon=90d
  runSync: personal scan = 42 events (skipped: 35 free, 0 unanswered/declined, 0 cancelled) → 7 eligible, 9 own segments, 0 shared OOO
  runSync: existing managed = 9 on own
  runSync[own]: no changes
  runSync: done in 1843ms
  ```

  When something actually changed, the per-target line shows the counts:
  `runSync[own]: +2 created, ~1 updated, -0 deleted, 0 failed`. The `+/~/-` mapping is
  *created / updated (hash changed) / deleted (no longer desired)*.

**Team mode only (do once after enabling):**

- Create an **all-day Busy** event "Vacation" Mon-Wed on your personal calendar → within
  `SYNC_EVERY_MINUTES`: own primary gets a clipped block 08-18 on each weekday; shared team
  calendar gets one all-day `OOO - {YourName}` block spanning Mon-Wed.
- Have a colleague (also running the script) create their own all-day event → both your OOO and
  theirs coexist on the shared calendar, neither overwrites the other.
- Delete your all-day event → both your own block and your OOO on shared disappear; colleague's
  OOO is untouched.
- Change `OWNER_DISPLAY_NAME` and re-run `initialSetup()` + `runSync()` → existing shared blocks
  re-title to the new name (hash-driven update path).

## Team mode (shared OOO calendar for N colleagues)

Each colleague installs their own copy of the script in their own work account; all installs write
their **OOO blocks** (only all-day Busy events) to a **single shared team calendar** as all-day
`OOO - {Name}` events. Timed events stay on each person's own primary, untouched by anyone else.

This intentionally replaces the manual practice of typing vacations into a shared calendar.

### One-time admin work (done once for the whole team)

1. **Create or pick the shared team calendar.** In any work account, [Google Calendar](https://calendar.google.com)
   → *+* next to *Other calendars* → *Create new calendar*. Or use the existing OOO calendar your
   team already uses.
2. **Grant edit access to every team member.** Calendar settings → *Share with specific people or
   groups* → add each colleague's work email with **"Make changes to events."** Read-only is not
   enough — each script needs to write its OOO blocks.
3. **Copy the calendar ID.** Calendar settings → *Integrate calendar* → *Calendar ID*. It looks
   like `xxxxxxxxxxxx@group.calendar.google.com`. Distribute this to all team members — it's the
   value they put into `SHARED_CAL_ID`.

### Per-colleague setup (each person does this once)

Follow the normal Setup flow above. Your own `OWNER_EMAIL` (work email) is already required there.
On top, in step 5 fill in:

- `SHARED_CAL_ID` = the calendar ID from admin step 3 (same for everyone).
- `OWNER_DISPLAY_NAME` = your own name, e.g. `'Adam Pagac'`. This becomes the title `OOO - Adam Pagac`
  on the shared calendar so colleagues can see whose OOO it is.

Then run `initialSetup()` as usual.

### How blocks are isolated between users

Every managed block is tagged with `pcalOwner = <your work email>` in `extendedProperties.private`.
The reconcile listing filters with both `pcalManaged=true` **AND** `pcalOwner=<self>`, so each
person's script only ever sees / touches its own blocks. No cleanup wars, no accidental deletes of
a colleague's OOO block.

### What lands where, summary

| Personal event type            | Own work primary          | Shared team calendar                   |
|--------------------------------|---------------------------|----------------------------------------|
| Timed Busy (e.g. doctor 14:00) | per-weekday clipped 08-18 | not synced                             |
| All-day Busy (e.g. vacation)   | per-weekday clipped 08-18 | full duration, all-day, `OOO - {Name}` |
| All-day Free (default)         | not synced                | not synced                             |
| Declined / unanswered invite   | not synced                | not synced                             |
| Weekend-only Busy              | not synced (weekend skip) | full duration if all-day               |

### Migrating from manual OOO entries

Existing manually-typed OOO entries on the shared calendar have no `pcalManaged` tag → scripts
ignore them (won't delete them, won't update them). Stop adding new ones manually; the existing
ones either pass into the past or you delete them by hand once.

## Configuration reference

| Constant             | Default               | Notes                                                                                                                      |
|----------------------|-----------------------|----------------------------------------------------------------------------------------------------------------------------|
| `PERSONAL_CAL_ID`    | `your.personal@…`     | The calendar shared *into* the work account.                                                                               |
| `WORK_CAL_ID`        | `'primary'`           | Work account's own primary calendar.                                                                                       |
| `OWNER_EMAIL`        | `''` (empty)          | Your work email. Tagged onto every managed block as `pcalOwner` so the reconcile only ever touches your own. **Required.** |
| `SHARED_CAL_ID`      | `''` (empty)          | Team OOO calendar ID. Empty = solo mode, no shared writes.                                                                 |
| `OWNER_DISPLAY_NAME` | `''` (empty)          | Required if `SHARED_CAL_ID` set. Goes into `OOO - {name}` title.                                                           |
| `TZ`                 | `'Europe/Prague'`     | Must match `appsscript.json#timeZone`.                                                                                     |
| `WORK_START_HOUR`    | `8`                   | Inclusive.                                                                                                                 |
| `WORK_END_HOUR`      | `18`                  | Exclusive.                                                                                                                 |
| `HORIZON_DAYS`       | `90`                  | Rolling window (~3 months forward). Lower for faster first run.                                                            |
| `BUSY_TITLE`         | `'Personal - Busy'`   | Title for own-primary blocks. Shared title is `OOO - {name}`.                                                              |
| `SYNC_EVERY_MINUTES` | `10`                  | Trigger interval. Valid: 1, 5, 10, 15, 30. 10 keeps team mode safely in quota.                                             |
| `RUN_BUDGET_MS`      | `300000` (5 min)      | Headroom under Apps Script's 6-min hard limit.                                                                             |

## Filtering rules (summary)

- **Busy/Free is the master switch — Free always wins.** Only events with `transparency` *opaque*
  (or unset) sync. Because Google all-day events default to **Free**, a default all-day event is
  *not* synced; mark it Busy explicitly to make it block.
- **Declined or unanswered invites** — skipped. An event you haven't actively accepted (or marked
  tentative) won't create a work block. Accepted and *Tentative* events do block.
- **Boundary-straddling timed events** — clipped to the in-window portion (17:00–19:00 → 17:00–18:00).
- **Multi-day / all-day events marked Busy** — one block per weekday touched, clipped to work hours;
  weekends omitted entirely.
- Work block has no description, location, attendees, or reminders. Just title + time.

## Operational notes

- **Quota** — at `SYNC_EVERY_MINUTES=10`: 2 list calls per run in solo mode (3 in team mode) + a
  few writes only when something changes. Per user per day ≈ 430-650 calls. For a 10-person team
  all hitting the shared calendar that's ~6000 calls/day team-wide, well under the per-project
  1M/day Calendar API quota and the per-user Workspace 6 hr/day Apps Script execution limit.
- **Sync interval trade-off** — `1` = ~1 min latency but ~10× the API calls. `10` is the safe
  default for team mode. Drop to `5` if you want faster vacation propagation; `30` if you really
  want to minimize quota use and don't mind half-hour latency.
- **Past blocks** — past managed blocks accumulate forever on the work calendar; harmless. Add a
  weekly cleanup trigger if you ever want a clean history.
- **`HORIZON_DAYS` trade-off** — events scheduled beyond the horizon don't sync until the rolling
  window catches up (which happens daily). 30 days is plenty for most calendars; 90 if you book
  conferences months out.
- **Latency caveat** — Apps Script time triggers fire *approximately* every minute. Occasionally
  you'll see 2–3 min latency. If you need sub-minute, this approach doesn't apply.
