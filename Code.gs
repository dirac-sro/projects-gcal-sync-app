/**
 * gcal-sync-app
 *
 * One-way Google Calendar sync. Mirrors privacy-stripped Busy blocks from a personal calendar
 * onto a work calendar (work-hour window only), and optionally posts all-day OOO entries to a
 * shared team calendar. Runs as a time-driven Apps Script trigger; reconcile is idempotent.
 *
 * See README.md for setup, configuration, and the design rationale.
 */

/** ===== CONFIG ===== */

const CONFIG = {
  PERSONAL_CAL_IDS:   ['your.personal@gmail.com'], // one or more source calendars shared INTO this account ("See all event details" or "free/busy"). Accepts a single string for back-compat.
  WORK_CAL_ID:        'primary',                   // the work calendar this script account owns
  OWNER_EMAIL:        'your.work@email.com',       // your work email — used as a stable key to tag your managed blocks. Required.
  SHARED_CAL_ID:      '',                          // OPTIONAL: team OOO calendar. Empty = solo mode (no shared writes).
  OWNER_DISPLAY_NAME: 'YOUR NAME',                 // REQUIRED if SHARED_CAL_ID set. e.g. 'Adam Pagac' → 'OOO - Adam Pagac'
  TZ:                 'Europe/Prague',             // must match appsscript.json "timeZone"
  WORK_START_HOUR:    8,
  WORK_END_HOUR:      18,
  HORIZON_DAYS:       90,                          // rolling window (~3 months forward)
  BUSY_TITLE:         'Personal - Busy',           // title for blocks on own work calendar
  SYNC_EVERY_MINUTES: 10,                          // trigger interval. Valid: 1, 5, 10, 15, 30. 10 keeps team mode safely in quota.
  RUN_BUDGET_MS:      5 * 60 * 1000,               // leave ~1 min headroom under the 6-min Apps Script hard limit
};

/** ===== ENTRY POINTS ===== */

/**
 * Run ONCE manually from the Apps Script editor (and again after any CONFIG change):
 *   - validates CONFIG and the script timezone,
 *   - backfills the pcalOwner tag on legacy managed blocks (pre-team-mode upgrade path),
 *   - installs / reinstalls the time-driven trigger at SYNC_EVERY_MINUTES,
 *   - performs the first reconcile.
 *
 * Re-running is safe and required after toggling team mode on/off or changing OWNER_EMAIL.
 */
function initialSetup() {
  assertTzMatches();
  if (!CONFIG.OWNER_EMAIL) {
    throw new Error('OWNER_EMAIL is empty — set it to your work email in CONFIG.');
  }
  if (sourceCalIds().length === 0) {
    throw new Error('PERSONAL_CAL_IDS is empty — set at least one source calendar ID in CONFIG.');
  }
  if (CONFIG.SHARED_CAL_ID && !CONFIG.OWNER_DISPLAY_NAME) {
    throw new Error('SHARED_CAL_ID is set but OWNER_DISPLAY_NAME is empty — team mode needs both.');
  }
  migrateLegacyBlocks(CONFIG.OWNER_EMAIL);

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runSync')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runSync').timeBased().everyMinutes(CONFIG.SYNC_EVERY_MINUTES).create();
  console.log('initialSetup: trigger installed (every %d min), running first reconcile…', CONFIG.SYNC_EVERY_MINUTES);
  runSync();
}

/**
 * Main reconcile loop. Invoked every CONFIG.SYNC_EVERY_MINUTES minutes by the time-driven
 * trigger (and runnable manually from the editor). Three phases:
 *   1. Compute desired state from one read of the personal calendar.
 *   2. List existing managed blocks on each target (owner-filtered).
 *   3. Reconcile each target: create new, update changed (hash mismatch), delete orphaned.
 *
 * Wrapped in a script-level lock; concurrent invocations skip rather than queue. Budget-aware:
 * bails before the 6-min Apps Script execution limit and resumes on the next tick.
 */
function runSync() {
  assertTzMatches();
  if (!CONFIG.OWNER_EMAIL) throw new Error('OWNER_EMAIL is empty. Set it in CONFIG and re-run initialSetup().');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('runSync: skipped — prior run still holding the lock');
    return;
  }
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt > CONFIG.RUN_BUDGET_MS;
  try {
    const ownerEmail = CONFIG.OWNER_EMAIL;
    const now = new Date();
    const horizon = new Date(now.getTime() + CONFIG.HORIZON_DAYS * 864e5);
    const teamMode = !!CONFIG.SHARED_CAL_ID;
    const sources = sourceCalIds();
    console.log('runSync: start mode=%s owner=%s sources=%d horizon=%dd', teamMode ? 'team' : 'solo', ownerEmail, sources.length, CONFIG.HORIZON_DAYS);

    // Phase 1: desired state — read each source calendar, merge all events into the same two
    // desired maps. Event IDs are globally unique across calendars so keys never collide.
    const desiredOwn = {};    // key "sourceId|YYYY-MM-DD" → { seg, sourceId }
    const desiredShared = {}; // key "sourceId" → { sourceId, startDate, endDate }
    let scanned = 0, eligible = 0, skipFree = 0, skipResponse = 0, skipCancelled = 0;
    sources.forEach(calId => {
      listEvents(calId, now, horizon).forEach(ev => {
        scanned++;
        if (ev.status === 'cancelled') { skipCancelled++; return; }
        if (!isBusy(ev))               { skipFree++; return; }
        if (skipByResponse(ev))        { skipResponse++; return; }
        eligible++;

        // Personal target: per-weekday segments clipped to work hours, all event types.
        segmentsFor(ev).forEach(seg => {
          if (seg.end <= now) return;
          desiredOwn[ev.id + '|' + seg.date] = { seg, sourceId: ev.id };
        });

        // Shared OOO target: only all-day events, full duration, no clipping, no weekend skip.
        if (teamMode && isAllDay(ev)) {
          if (parseYmd(ev.end.date) <= now) return; // end.date is exclusive
          desiredShared[ev.id] = { sourceId: ev.id, startDate: ev.start.date, endDate: ev.end.date };
        }
      });
    });
    console.log('runSync: personal scan = %d events from %d source(s) (skipped: %d free, %d unanswered/declined, %d cancelled) → %d eligible, %d own segments, %d shared OOO',
      scanned, sources.length, skipFree, skipResponse, skipCancelled, eligible, Object.keys(desiredOwn).length, Object.keys(desiredShared).length);

    // Phase 2: existing state — owner-filtered listing per target.
    const ownerFilter = ['pcalManaged=true', 'pcalOwner=' + ownerEmail];
    const existingOwn = indexExisting(
      listEvents(CONFIG.WORK_CAL_ID, now, horizon, ownerFilter),
      p => p.pcalSourceId + '|' + p.pcalDate
    );
    const existingShared = teamMode ? indexExisting(
      listEvents(CONFIG.SHARED_CAL_ID, now, horizon, ownerFilter),
      p => p.pcalSourceId
    ) : {};
    console.log('runSync: existing managed = %d on own%s', Object.keys(existingOwn).length,
      teamMode ? (', ' + Object.keys(existingShared).length + ' on shared') : '');

    // Phase 3: reconcile each target independently.
    const sumOwn = reconcile(
      desiredOwn, existingOwn,
      d => hashOfOwn(d.seg),
      (d, h) => Calendar.Events.insert(blockBodyOwn(d.seg, d.sourceId, h, ownerEmail), CONFIG.WORK_CAL_ID),
      (id, d, h) => Calendar.Events.patch(blockBodyOwn(d.seg, d.sourceId, h, ownerEmail), CONFIG.WORK_CAL_ID, id),
      id => Calendar.Events.remove(CONFIG.WORK_CAL_ID, id),
      overBudget, 'own'
    );
    logReconcile('own', sumOwn);

    if (teamMode) {
      const sumShared = reconcile(
        desiredShared, existingShared,
        d => hashOfShared(d),
        (d, h) => Calendar.Events.insert(blockBodyShared(d, h, ownerEmail), CONFIG.SHARED_CAL_ID),
        (id, d, h) => Calendar.Events.patch(blockBodyShared(d, h, ownerEmail), CONFIG.SHARED_CAL_ID, id),
        id => Calendar.Events.remove(CONFIG.SHARED_CAL_ID, id),
        overBudget, 'shared'
      );
      logReconcile('shared', sumShared);
    }
    console.log('runSync: done in %dms', Date.now() - startedAt);
  } finally {
    lock.releaseLock();
  }
}

/** ===== SETUP HELPERS ===== */

/**
 * Hard-stop if the Apps Script project timezone (set in appsscript.json + Project Settings)
 * does not match CONFIG.TZ. The two must agree or segment date arithmetic and pcalDate keys
 * will disagree, producing duplicated or stranded blocks. Asserted on every run, not just
 * install, so that a later CONFIG.TZ edit cannot silently desync the state.
 */
function assertTzMatches() {
  if (Session.getScriptTimeZone() !== CONFIG.TZ) {
    throw new Error(
      'Script timezone (' + Session.getScriptTimeZone() + ') does not match CONFIG.TZ (' + CONFIG.TZ +
      '). Update appsscript.json "timeZone" or CONFIG.TZ so they agree, otherwise segment math and ' +
      'date keys will disagree and produce duplicated or stranded blocks.'
    );
  }
}

/**
 * Backfill pcalOwner on managed blocks created before team mode existed.
 *
 * Pre-team-mode blocks carry pcalManaged=true but no pcalOwner. The owner-filtered listing
 * used by runSync would miss them, the reconcile would treat them as orphans, and the script
 * would recreate them as duplicates while old blocks linger forever. This patches existing
 * blocks in place with the current owner email.
 *
 * Safe to call repeatedly: already-tagged blocks are skipped.
 */
function migrateLegacyBlocks(email) {
  const now = new Date();
  const horizon = new Date(now.getTime() + CONFIG.HORIZON_DAYS * 864e5);
  const cals = [CONFIG.WORK_CAL_ID];
  if (CONFIG.SHARED_CAL_ID) cals.push(CONFIG.SHARED_CAL_ID);
  let tagged = 0;
  cals.forEach(calId => {
    listEvents(calId, now, horizon, ['pcalManaged=true']).forEach(it => {
      const priv = (it.extendedProperties && it.extendedProperties.private) || {};
      if (priv.pcalOwner) return;
      try {
        Calendar.Events.patch({
          extendedProperties: { private: Object.assign({}, priv, { pcalOwner: email }) }
        }, calId, it.id);
        tagged++;
      } catch (e) {
        console.warn('migrateLegacyBlocks: failed to tag %s on %s: %s', it.id, calId, e && e.message || e);
      }
    });
  });
  if (tagged) console.log('migrateLegacyBlocks: backfilled pcalOwner on %s block(s)', tagged);
}

/** ===== RECONCILE ===== */

/**
 * Generic two-way reconcile: align `existing` to match `desired`, returning per-action counts.
 *
 * Strategy:
 *   - desired key not in existing      → create
 *   - desired key whose hash differs   → update
 *   - existing key not in desired      → delete
 *
 * Per-operation try/catch so one bad event doesn't abort the whole pass; failures increment
 * `s.failed`. The `overBudget` callback short-circuits the loops and sets `s.deferred=true`
 * so the caller can log a partial result; the next trigger tick picks up where we stopped.
 *
 * @param {Object<string, Object>} desired   key → state object the desired-state functions consume
 * @param {Object<string, {id:string, hash:string}>} existing  key → existing managed block
 * @param {function(Object):string} hashFn   compute identity hash from a desired-state object
 * @param {function(Object, string):void} createFn   create operation (desired, hash)
 * @param {function(string, Object, string):void} updateFn  update operation (id, desired, hash)
 * @param {function(string):void} deleteFn   delete operation (id)
 * @param {function():boolean} overBudget    true once the run should bail
 * @param {string} label   identifier used in error logs (e.g. 'own', 'shared')
 * @returns {{created:number, updated:number, deleted:number, failed:number, deferred:boolean}}
 */
function reconcile(desired, existing, hashFn, createFn, updateFn, deleteFn, overBudget, label) {
  const s = { created: 0, updated: 0, deleted: 0, failed: 0, deferred: false };

  const desiredKeys = Object.keys(desired);
  for (let i = 0; i < desiredKeys.length; i++) {
    if (overBudget()) { s.deferred = true; return s; }
    const key = desiredKeys[i];
    const d = desired[key], ex = existing[key], h = hashFn(d);
    try {
      if (!ex)                { createFn(d, h); s.created++; }
      else if (ex.hash !== h) { updateFn(ex.id, d, h); s.updated++; }
    } catch (e) {
      s.failed++;
      console.error('runSync[%s]: create/update failed for key=%s: %s', label, key, e && e.message || e);
    }
  }

  const existingKeys = Object.keys(existing);
  for (let i = 0; i < existingKeys.length; i++) {
    if (overBudget()) { s.deferred = true; return s; }
    const key = existingKeys[i];
    if (desired[key]) continue;
    try { deleteFn(existing[key].id); s.deleted++; }
    catch (e) {
      s.failed++;
      console.error('runSync[%s]: delete failed for key=%s: %s', label, key, e && e.message || e);
    }
  }
  return s;
}

/** One-line summary log of a reconcile pass; collapses to "no changes" when nothing happened. */
function logReconcile(label, s) {
  const changed = s.created || s.updated || s.deleted || s.failed;
  if (!changed && !s.deferred) {
    console.log('runSync[%s]: no changes', label);
    return;
  }
  console.log('runSync[%s]: +%d created, ~%d updated, -%d deleted, %d failed%s',
    label, s.created, s.updated, s.deleted, s.failed, s.deferred ? ' (DEFERRED: over budget)' : '');
}

/**
 * Build a lookup map from a list of managed-block events:
 * `keyFn(privateProps) → { id, hash }`.
 *
 * The `keyFn` lets each target use its own key shape — personal target keys by
 * `sourceId + '|' + date`, shared target keys by `sourceId` alone.
 */
function indexExisting(items, keyFn) {
  const out = {};
  items.forEach(it => {
    const p = (it.extendedProperties && it.extendedProperties.private) || {};
    out[keyFn(p)] = { id: it.id, hash: p.pcalHash };
  });
  return out;
}

/** ===== SOURCE PARSING ===== */

/**
 * Normalize CONFIG.PERSONAL_CAL_IDS into an array of non-empty calendar IDs.
 * Accepts either a single string (back-compat: a v0.1 config will keep working) or an array.
 * Strips empty entries so an array with placeholders doesn't crash listEvents.
 */
function sourceCalIds() {
  const raw = CONFIG.PERSONAL_CAL_IDS;
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return arr.filter(s => typeof s === 'string' && s.length > 0);
}

/** Event is busy when transparency is opaque or unset (Google default for timed events). */
function isBusy(ev) { return ev.transparency !== 'transparent'; }

/** Event is all-day when start/end use date-only fields (no time component). */
function isAllDay(ev) { return !!(ev.start.date && !ev.start.dateTime); }

/**
 * Skip events the user hasn't actively committed to:
 *   - declined            → skip
 *   - needsAction         → skip (pending invite — user hasn't said yes)
 *   - accepted / tentative → keep (tentative still holds time)
 *
 * If there's no attendees array (self-organized event with no invitees), the event is kept.
 */
function skipByResponse(ev) {
  if (!ev.attendees) return false;
  const me = ev.attendees.filter(a => a.self)[0];
  if (!me) return false;
  return me.responseStatus === 'declined' || me.responseStatus === 'needsAction';
}

/**
 * Split an event into one clipped [WORK_START_HOUR, WORK_END_HOUR] segment per weekday it
 * touches. Used to construct the personal-target blocks: multi-day vacations yield one
 * weekday-clipped segment per workday, weekends are skipped, and events crossing the
 * work-hour boundary are clipped to the in-window portion only.
 *
 * Handles both timed events (RFC3339 dateTime) and all-day events (date-only).
 */
function segmentsFor(ev) {
  const allDay = isAllDay(ev);
  const coverStart = allDay ? parseYmd(ev.start.date) : new Date(ev.start.dateTime);
  const coverEnd   = allDay ? parseYmd(ev.end.date)   : new Date(ev.end.dateTime); // end exclusive
  const segs = [];
  let day = new Date(coverStart.getFullYear(), coverStart.getMonth(), coverStart.getDate());
  while (day < coverEnd) {
    const dow = day.getDay(); // 0=Sun..6=Sat in script TZ
    if (dow !== 0 && dow !== 6) {
      const ws = new Date(day.getFullYear(), day.getMonth(), day.getDate(), CONFIG.WORK_START_HOUR);
      const we = new Date(day.getFullYear(), day.getMonth(), day.getDate(), CONFIG.WORK_END_HOUR);
      const s = new Date(Math.max(coverStart.getTime(), ws.getTime()));
      const e = new Date(Math.min(coverEnd.getTime(), we.getTime()));
      if (s < e) segs.push({ date: fmtDate(day), start: s, end: e });
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }
  return segs;
}

/** ===== BLOCK CONSTRUCTION ===== */

/** Google Calendar Events.insert/patch payload for a personal-target block (timed). */
function blockBodyOwn(seg, sourceId, hash, ownerEmail) {
  return {
    summary: CONFIG.BUSY_TITLE,
    start: { dateTime: seg.start.toISOString() },
    end:   { dateTime: seg.end.toISOString() },
    reminders: { useDefault: false },
    extendedProperties: { private: pcalProps(sourceId, seg.date, hash, ownerEmail) },
  };
}

/** Google Calendar Events.insert/patch payload for a shared OOO block (all-day). */
function blockBodyShared(d, hash, ownerEmail) {
  return {
    summary: 'OOO - ' + CONFIG.OWNER_DISPLAY_NAME,
    start: { date: d.startDate },
    end:   { date: d.endDate },
    reminders: { useDefault: false },
    extendedProperties: { private: pcalProps(d.sourceId, d.startDate, hash, ownerEmail) },
  };
}

/**
 * The five pcal* keys carried by every managed block under extendedProperties.private.
 * The (pcalManaged, pcalOwner) pair is the listing filter that provides multi-user isolation
 * on shared targets — each script only ever sees its own blocks.
 */
function pcalProps(sourceId, date, hash, ownerEmail) {
  return {
    pcalManaged:  'true',
    pcalOwner:    ownerEmail,
    pcalSourceId: sourceId,
    pcalDate:     date,
    pcalHash:     hash,
  };
}

/** Identity hash for a personal-target segment; differs only when start/end time changes. */
function hashOfOwn(seg) { return seg.start.getTime() + '-' + seg.end.getTime(); }

/**
 * Identity hash for a shared OOO block. Includes OWNER_DISPLAY_NAME so a name change
 * (rename, typo fix) triggers a title update on existing blocks via the hash-mismatch
 * branch of the reconcile.
 */
function hashOfShared(d) { return d.startDate + '|' + d.endDate + '|' + CONFIG.OWNER_DISPLAY_NAME; }

/** ===== API + DATE HELPERS ===== */

/**
 * Paginating wrapper around Calendar.Events.list. Always expands recurring events into
 * individual instances (singleEvents=true, requires orderBy='startTime'). Optional
 * `privateExtProps` is a string[] AND-combined into the privateExtendedProperty filter,
 * e.g. ['pcalManaged=true', 'pcalOwner=user@example.com'].
 */
function listEvents(calId, timeMin, timeMax, privateExtProps) {
  const out = [];
  let pageToken;
  do {
    const params = {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      showDeleted: false,
      orderBy: 'startTime',
      maxResults: 2500,
      pageToken,
    };
    if (privateExtProps && privateExtProps.length) params.privateExtendedProperty = privateExtProps;
    const resp = Calendar.Events.list(calId, params);
    (resp.items || []).forEach(i => out.push(i));
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

/** Parse a YYYY-MM-DD all-day date string into a Date at midnight in the script timezone. */
function parseYmd(s) { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }

/** Format a Date as YYYY-MM-DD in CONFIG.TZ. */
function fmtDate(d) { return Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd'); }
