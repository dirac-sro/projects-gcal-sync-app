# gcal-sync-app

One-way Google Calendar sync: when an event appears on your **personal** calendar within
**Mon–Fri 08:00–18:00**, a privacy-stripped `Personal - Busy` block appears on your **work**
calendar. Colleagues see you're busy; they don't see what for.

Runs as a Google Apps Script project hosted in your **work** account, polled every minute by a
time-driven trigger. Latency ≈ 1 min.

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
   - `TZ` matches `appsscript.json#timeZone` (both default to `Europe/Bratislava`).
   - `WORK_START_HOUR`, `WORK_END_HOUR`, `HORIZON_DAYS` as you like.
6. Run `initialSetup()` once: in the editor toolbar, **select `initialSetup` from the function
   dropdown** next to the *Run* button, save (Ctrl/Cmd-S), then click *Run*. Grant the OAuth scopes
   when prompted. It installs the every-1-min trigger and runs the first reconcile.
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
  accepted in the work account yet. See Setup step 2.

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

## Configuration reference

| Constant          | Default               | Notes                                                           |
|-------------------|-----------------------|-----------------------------------------------------------------|
| `PERSONAL_CAL_ID` | `your.personal@…`     | The calendar shared *into* the work account.                    |
| `WORK_CAL_ID`     | `'primary'`           | Work account's own primary calendar.                            |
| `TZ`              | `'Europe/Bratislava'` | Must match `appsscript.json#timeZone`.                          |
| `WORK_START_HOUR` | `8`                   | Inclusive.                                                      |
| `WORK_END_HOUR`   | `18`                  | Exclusive.                                                      |
| `HORIZON_DAYS`    | `90`                  | Rolling window (~3 months forward). Lower for faster first run. |
| `BUSY_TITLE`      | `'Personal - Busy'`   | Title shown to colleagues.                                      |
| `RUN_BUDGET_MS`   | `300000` (5 min)      | Headroom under Apps Script's 6-min hard limit.                  |

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

- **Quota** — two calendar `list` calls per minute, plus reconcile writes (usually 0). Well within
  Calendar API quota and the Workspace 6 hr/day Apps Script execution limit.
- **Past blocks** — past managed blocks accumulate forever on the work calendar; harmless. Add a
  weekly cleanup trigger if you ever want a clean history.
- **`HORIZON_DAYS` trade-off** — events scheduled beyond the horizon don't sync until the rolling
  window catches up (which happens daily). 30 days is plenty for most calendars; 90 if you book
  conferences months out.
- **Latency caveat** — Apps Script time triggers fire *approximately* every minute. Occasionally
  you'll see 2–3 min latency. If you need sub-minute, this approach doesn't apply.
