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

const DEFAULT_CONFIG = {
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

/** Per-user config: DEFAULT_CONFIG overridden by this user's UserProperties. */
let CONFIG; // populated by loadConfig() at each entry point

const USER_PROP_KEYS = ['PERSONAL_CAL_IDS', 'SHARED_CAL_ID', 'OWNER_DISPLAY_NAME', 'WORK_START_HOUR', 'WORK_END_HOUR'];

function loadConfig() { CONFIG = mergeUserConfig(DEFAULT_CONFIG); }

function mergeUserConfig(defaults) {
  const p = PropertiesService.getUserProperties().getProperties();
  const c = Object.assign({}, defaults);
  if (p.PERSONAL_CAL_IDS) { try { c.PERSONAL_CAL_IDS = JSON.parse(p.PERSONAL_CAL_IDS); } catch (e) { c.PERSONAL_CAL_IDS = [p.PERSONAL_CAL_IDS]; } }
  if (p.SHARED_CAL_ID !== undefined && p.SHARED_CAL_ID !== '') c.SHARED_CAL_ID = p.SHARED_CAL_ID;
  if (p.OWNER_DISPLAY_NAME) c.OWNER_DISPLAY_NAME = p.OWNER_DISPLAY_NAME;
  if (p.WORK_START_HOUR) c.WORK_START_HOUR = parseInt(p.WORK_START_HOUR, 10);
  if (p.WORK_END_HOUR) c.WORK_END_HOUR = parseInt(p.WORK_END_HOUR, 10);
  // Web-app users never type their work email or timezone — derive them.
  // The DEFAULT_CONFIG placeholder must NOT shadow the session email, or every
  // web-app user would be tagged 'your.work@email.com'. Treat the placeholder as empty.
  const cfgEmail = (c.OWNER_EMAIL && c.OWNER_EMAIL !== 'your.work@email.com') ? c.OWNER_EMAIL : '';
  c.OWNER_EMAIL = p.OWNER_EMAIL || cfgEmail || Session.getActiveUser().getEmail();
  c.TZ = Session.getScriptTimeZone();
  return c;
}

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
  loadConfig();
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
  loadConfig();
  assertTzMatches();
  if (!CONFIG.OWNER_EMAIL) throw new Error('OWNER_EMAIL is empty. Set it in CONFIG and re-run initialSetup().');
  try {
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
      (d, h) => callWithRetry_(() => Calendar.Events.insert(blockBodyOwn(d.seg, d.sourceId, h, ownerEmail), CONFIG.WORK_CAL_ID)),
      (id, d, h) => callWithRetry_(() => Calendar.Events.patch(blockBodyOwn(d.seg, d.sourceId, h, ownerEmail), CONFIG.WORK_CAL_ID, id)),
      id => callWithRetry_(() => Calendar.Events.remove(CONFIG.WORK_CAL_ID, id)),
      overBudget, 'own'
    );
    logReconcile('own', sumOwn);

    if (teamMode) {
      const sumShared = reconcile(
        desiredShared, existingShared,
        d => hashOfShared(d),
        (d, h) => callWithRetry_(() => Calendar.Events.insert(blockBodyShared(d, h, ownerEmail), CONFIG.SHARED_CAL_ID)),
        (id, d, h) => callWithRetry_(() => Calendar.Events.patch(blockBodyShared(d, h, ownerEmail), CONFIG.SHARED_CAL_ID, id)),
        id => callWithRetry_(() => Calendar.Events.remove(CONFIG.SHARED_CAL_ID, id)),
        overBudget, 'shared'
      );
      logReconcile('shared', sumShared);
    }
    PropertiesService.getUserProperties().deleteProperty('SYNC_LAST_ALERT_AT'); // success → reset alert throttle
    console.log('runSync: done in %dms', Date.now() - startedAt);
  } finally {
    try { lock.releaseLock(); } catch (e) { console.warn('runSync: lock release failed (ignored): %s', e && e.message || e); }
  }
  } catch (err) {
    notifyFailure_(err);
    throw err;
  }
}

/**
 * Best-effort web-app setup URL for the recovery email.
 *
 * Reads the Script Property `SETUP_URL` — set this once to the deployed web-app `/exec`
 * URL (Project Settings → Script Properties). This is REQUIRED for the link to work for
 * every user: the auto-detect fallback `ScriptApp.getService().getUrl()` returns the
 * owner-only `/dev` URL when called from a trigger, which does not work for colleagues.
 * On relocating/redeploying the project, update that one Script Property.
 */
function setupUrl_() {
  try {
    const p = PropertiesService.getScriptProperties().getProperty('SETUP_URL');
    if (p) return p;
  } catch (e) {}
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/**
 * Email the owner when a scheduled run fails (revoked share, expired auth, quota).
 * Throttled to at most one alert per 24h per user (single timestamp, no failure counting);
 * a successful run clears the timestamp so a fresh problem alerts immediately.
 */
function notifyFailure_(err) {
  try {
    const props = PropertiesService.getUserProperties();
    const last = parseInt(props.getProperty('SYNC_LAST_ALERT_AT') || '0', 10);
    if (last && (Date.now() - last) < 24 * 60 * 60 * 1000) {
      console.log('notifyFailure_: suppressed (last alert %d min ago): %s',
        Math.round((Date.now() - last) / 60000), (err && err.message) || err);
      return;
    }
    const to = Session.getActiveUser().getEmail();
    if (!to) return;
    const url = setupUrl_();
    const step2 = url
      ? '2. Otvor setup a klikni „Zapnúť synchronizáciu":\n   ' + url
      : '2. Otvor svoj gcal-sync setup link a klikni „Zapnúť synchronizáciu".';
    MailApp.sendEmail(to, 'gcal-sync: synchronizácia zlyhala — treba akciu',
      'Synchronizácia tvojho kalendára zlyhala a momentálne nebeží.\n\n' +
      'Čo urobiť:\n' +
      '1. Over, že tvoj osobný kalendár je stále zdieľaný do tvojho pracovného účtu ' +
      '(Google Calendar → Settings and sharing → See all event details).\n' +
      step2 + '\n\n' +
      'Ak chyba pretrváva, daj vedieť správcovi.\n\n' +
      'Technický detail: ' + (err && err.stack || err));
    props.setProperty('SYNC_LAST_ALERT_AT', String(Date.now()));
  } catch (e) {
    console.warn('notifyFailure_ could not send mail: %s', e && e.message || e);
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

/** ===== TEST HELPERS (run manually from the editor) ===== */
function assert_(label, cond) {
  if (!cond) throw new Error('FAIL: ' + label);
  console.log('PASS: ' + label);
}

function test_mergeUserConfig() {
  const props = PropertiesService.getUserProperties();
  const saved = props.getProperties();
  try {
    props.deleteAllProperties();
    // No user props → defaults, OWNER_EMAIL from session, TZ from script
    let c = mergeUserConfig(DEFAULT_CONFIG);
    assert_('default work end is 18', c.WORK_END_HOUR === 18);
    assert_('OWNER_EMAIL filled from session', !!c.OWNER_EMAIL && c.OWNER_EMAIL.indexOf('@') > 0);
    assert_('TZ equals script tz', c.TZ === Session.getScriptTimeZone());

    // User props override
    props.setProperty('PERSONAL_CAL_IDS', JSON.stringify(['a@gmail.com', 'b@gmail.com']));
    props.setProperty('WORK_END_HOUR', '17');
    props.setProperty('SHARED_CAL_ID', 'team@group.calendar.google.com');
    props.setProperty('OWNER_DISPLAY_NAME', 'Jane Doe');
    c = mergeUserConfig(DEFAULT_CONFIG);
    assert_('PERSONAL_CAL_IDS parsed from JSON', Array.isArray(c.PERSONAL_CAL_IDS) && c.PERSONAL_CAL_IDS.length === 2);
    assert_('WORK_END_HOUR overridden to 17', c.WORK_END_HOUR === 17);
    assert_('SHARED_CAL_ID overridden', c.SHARED_CAL_ID === 'team@group.calendar.google.com');
    assert_('OWNER_DISPLAY_NAME overridden', c.OWNER_DISPLAY_NAME === 'Jane Doe');
  } finally {
    props.deleteAllProperties();
    if (Object.keys(saved).length) props.setProperties(saved);
  }
  console.log('test_mergeUserConfig: ALL PASSED');
}

function test_notifyFailure_exists() {
  assert_('notifyFailure_ is a function', typeof notifyFailure_ === 'function');
  console.log('test_notifyFailure_exists: PASSED');
}

function test_callWithRetry_() {
  // Transient error → retried, then succeeds (sleeps ~1s on the single retry).
  let n = 0;
  const r = callWithRetry_(() => {
    n++;
    if (n < 2) throw new Error("We're sorry, a server error occurred. Please wait a bit and try again.");
    return 'ok';
  });
  assert_('transient retried then succeeded', r === 'ok' && n === 2);

  // Non-transient (404) → thrown immediately, no retry.
  let m = 0, threw = false;
  try { callWithRetry_(() => { m++; throw new Error('Not Found (404)'); }); }
  catch (e) { threw = true; }
  assert_('404 fails fast without retry', threw && m === 1);

  console.log('test_callWithRetry_: ALL PASSED');
}

/** ===== API + DATE HELPERS ===== */

/**
 * Call a Google API function with bounded retry on TRANSIENT errors only (5xx, rate limit,
 * "We're sorry, a server error occurred … try again"). Non-transient errors (404 not-found,
 * 403 no-access) throw immediately — retrying won't fix an unshared calendar. A transient
 * that recovers within the attempts is logged at WARNING (visible in Cloud Logging) and does
 * NOT alert; a transient that survives all attempts is rethrown as a real failure.
 */
function callWithRetry_(fn) {
  const MAX_TRIES = 4;
  let delay = 1000; // backoff: 1s → 2s → 4s
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      const msg = ((e && e.message) || e) + '';
      const transient = /server error|try again|rate limit|user rate|backend|internal error|timeout|temporarily|\b50[023]\b|\b429\b/i.test(msg);
      if (!transient || attempt >= MAX_TRIES) throw e;
      console.warn('callWithRetry_: transient error (attempt %d/%d), retry in %dms: %s', attempt, MAX_TRIES, delay, msg);
      Utilities.sleep(delay);
      delay *= 2;
    }
  }
}

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
    const resp = callWithRetry_(() => Calendar.Events.list(calId, params));
    (resp.items || []).forEach(i => out.push(i));
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

/** Parse a YYYY-MM-DD all-day date string into a Date at midnight in the script timezone. */
function parseYmd(s) { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }

/** Format a Date as YYYY-MM-DD in CONFIG.TZ. */
function fmtDate(d) { return Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd'); }

/** ===== WEB APP (onboarding) ===== */

// Team calendar that receives the shared "OOO - <name>" all-day blocks. Kept OUT of source
// so the repo stays generic: set it per-deployment as a Script Property
// (Project Settings → Script Properties → key `TEAM_CAL_ID`, value = the calendar's ID).
// Empty when unset — team mode then has nowhere to write and stays effectively off.
const TEAM_CAL_ID = PropertiesService.getScriptProperties().getProperty('TEAM_CAL_ID') || '';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('SetupForm')
    .setTitle('gcal-sync — setup')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Current per-user settings used to prefill the form. */
function getCurrentSettings() {
  const c = mergeUserConfig(DEFAULT_CONFIG);
  const ids = Array.isArray(c.PERSONAL_CAL_IDS) ? c.PERSONAL_CAL_IDS.filter(s => s && s.indexOf('@') > 0 && s !== 'your.personal@gmail.com') : [];
  return {
    email: c.OWNER_EMAIL,
    personalCalIds: ids,
    displayName: c.OWNER_DISPLAY_NAME && c.OWNER_DISPLAY_NAME !== 'YOUR NAME' ? c.OWNER_DISPLAY_NAME : '',
    sharedCalId: c.SHARED_CAL_ID || '',
    workStartHour: c.WORK_START_HOUR,
    workEndHour: c.WORK_END_HOUR,
    teamModeOn: !!c.SHARED_CAL_ID,
    teamCalId: TEAM_CAL_ID,
  };
}

function test_getCurrentSettings() {
  const s = getCurrentSettings();
  assert_('email present', !!s.email && s.email.indexOf('@') > 0);
  assert_('personalCalIds is array', Array.isArray(s.personalCalIds));
  assert_('workStartHour numeric', typeof s.workStartHour === 'number');
  assert_('teamModeOn boolean', typeof s.teamModeOn === 'boolean');
  console.log('test_getCurrentSettings: ALL PASSED');
}

/** True if the current user can list events on calId (i.e. it's shared in). */
function canReadCalendar_(calId) {
  try {
    Calendar.Events.list(calId, { maxResults: 1, timeMin: new Date().toISOString() });
    return true;
  } catch (e) {
    return false;
  }
}

/** Form submit handler. Validates, stores per-user config, installs trigger, runs first sync. */
function saveSetup(data) {
  // Accept the new array form; fall back to the legacy scalar personalCalId.
  const rawIds = Array.isArray(data.personalCalIds)
    ? data.personalCalIds
    : (data.personalCalId ? [data.personalCalId] : []);
  // Trim, drop blanks/non-emails, dedupe — preserving order.
  const calIds = [];
  rawIds.forEach(s => {
    const v = (s || '').trim();
    if (v && v.indexOf('@') > 0 && calIds.indexOf(v) < 0) calIds.push(v);
  });
  if (calIds.length === 0) {
    return { ok: false, message: 'Zadaj aspoň jeden osobný kalendár (Gmail adresu).' };
  }
  if (data.teamMode && !(data.displayName || '').trim()) {
    return { ok: false, message: 'Pri tímovom režime vyplň svoje meno (pre „OOO - Meno").' };
  }
  if (!Number.isInteger(data.workStartHour) || !Number.isInteger(data.workEndHour) ||
      data.workStartHour < 0 || data.workEndHour > 24 || data.workStartHour >= data.workEndHour) {
    return { ok: false, message: 'Neplatné pracovné hodiny — zadaj celé čísla 0–24, kde „od" < „do".' };
  }
  const unreadable = calIds.filter(id => !canReadCalendar_(id));
  if (unreadable.length) {
    const me = Session.getActiveUser().getEmail();
    return { ok: false, message:
      'Tieto kalendáre zatiaľ nevidím (nie sú mi nazdieľané):\n\n' +
      unreadable.map(id => '  • ' + id).join('\n') + '\n\n' +
      'Pre každý z nich:\n' +
      '1. Prihlás sa do daného účtu → Google Calendar → Settings and sharing.\n' +
      '2. Share with specific people → pridaj ' + me + ' s právom „See all event details".\n' +
      '3. Potom klikni Zapnúť synchronizáciu znova.' };
  }

  const props = PropertiesService.getUserProperties();
  props.setProperties({
    PERSONAL_CAL_IDS: JSON.stringify(calIds),
    WORK_START_HOUR: String(data.workStartHour),
    WORK_END_HOUR: String(data.workEndHour),
    SHARED_CAL_ID: data.teamMode ? TEAM_CAL_ID : '',
    OWNER_DISPLAY_NAME: data.teamMode ? data.displayName.trim() : '',
  });

  // (Re)install this user's time trigger.
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runSync')
    .forEach(t => ScriptApp.deleteTrigger(t));
  loadConfig();
  ScriptApp.newTrigger('runSync').timeBased().everyMinutes(CONFIG.SYNC_EVERY_MINUTES).create();

  runSync();
  return { ok: true, message: '✅ Hotovo! Synchronizácia beží každých ' + CONFIG.SYNC_EVERY_MINUTES +
    ' minút. Skontroluj pracovný kalendár o pár minút.' };
}

function test_saveSetup_validation() {
  // Empty personal calendar → not ok, no trigger installed
  let r = saveSetup({ personalCalId: '', workStartHour: 8, workEndHour: 18, teamMode: false, displayName: '', sharedCalId: '' });
  assert_('empty calendar rejected', r.ok === false);
  assert_('mentions calendar', /kalend/i.test(r.message));

  // Team mode without name → rejected
  r = saveSetup({ personalCalId: 'x@gmail.com', workStartHour: 8, workEndHour: 18, teamMode: true, displayName: '', sharedCalId: TEAM_CAL_ID });
  assert_('team mode needs name', r.ok === false && /meno/i.test(r.message));

  // Invalid work hours → rejected
  r = saveSetup({ personalCalId: 'x@gmail.com', workStartHour: NaN, workEndHour: 18, teamMode: false, displayName: '', sharedCalId: '' });
  assert_('invalid work hours rejected', r.ok === false && /hodin/i.test(r.message));

  // Array form: empty array rejected, message mentions calendar.
  r = saveSetup({ personalCalIds: [], workStartHour: 8, workEndHour: 18, teamMode: false, displayName: '', sharedCalId: '' });
  assert_('empty array rejected', r.ok === false && /kalend/i.test(r.message));

  // Array form: multiple unreadable calendars → all-or-nothing reject naming EACH.
  r = saveSetup({ personalCalIds: ['a@gmail.com', 'b@gmail.com'], workStartHour: 8, workEndHour: 18, teamMode: false, displayName: '', sharedCalId: '' });
  assert_('multi-cal unreadable rejected', r.ok === false);
  assert_('names every failing calendar', /a@gmail\.com/.test(r.message) && /b@gmail\.com/.test(r.message));

  // Back-compat: scalar personalCalId still accepted as a single source.
  r = saveSetup({ personalCalId: 'c@gmail.com', workStartHour: 8, workEndHour: 18, teamMode: false, displayName: '', sharedCalId: '' });
  assert_('scalar back-compat rejected at readability not shape', r.ok === false && /nevid/i.test(r.message));

  console.log('test_saveSetup_validation: ALL PASSED');
}
