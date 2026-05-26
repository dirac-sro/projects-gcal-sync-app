/** ---------- CONFIG ---------- */
const CONFIG = {
  PERSONAL_CAL_ID:    'your.personal@gmail.com',   // shared INTO the work account ("See all event details") + accepted
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
  RUN_BUDGET_MS:      5 * 60 * 1000,               // leave ~1 min headroom under the 6-min hard limit
};

/** Run ONCE manually (and again after any CONFIG change): validates, migrates legacy blocks
 *  to tagged-by-owner form, installs the trigger, runs first reconcile. */
function initialSetup() {
  assertTzMatches();
  if (!CONFIG.OWNER_EMAIL) {
    throw new Error('OWNER_EMAIL is empty — set it to your work email in CONFIG.');
  }
  if (CONFIG.SHARED_CAL_ID && !CONFIG.OWNER_DISPLAY_NAME) {
    throw new Error('SHARED_CAL_ID is set but OWNER_DISPLAY_NAME is empty — team mode needs both.');
  }
  migrateLegacyBlocks(CONFIG.OWNER_EMAIL);

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runSync')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runSync').timeBased().everyMinutes(CONFIG.SYNC_EVERY_MINUTES).create();
  runSync();
}

/**
 * Backfill pcalOwner on managed blocks created before team mode existed.
 * Without this, the owner-filtered listing would miss them and runSync would
 * create duplicates while old blocks linger forever.
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

function assertTzMatches() {
  if (Session.getScriptTimeZone() !== CONFIG.TZ) {
    throw new Error(
      'Script timezone (' + Session.getScriptTimeZone() + ') does not match CONFIG.TZ (' + CONFIG.TZ +
      '). Update appsscript.json "timeZone" or CONFIG.TZ so they agree, otherwise segment math and ' +
      'date keys will disagree and produce duplicated or stranded blocks.'
    );
  }
}

/** Main reconcile loop — invoked every CONFIG.SYNC_EVERY_MINUTES minutes by the trigger. */
function runSync() {
  assertTzMatches();
  if (!CONFIG.OWNER_EMAIL) throw new Error('OWNER_EMAIL is empty. Set it in CONFIG and re-run initialSetup().');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt > CONFIG.RUN_BUDGET_MS;
  try {
    const ownerEmail = CONFIG.OWNER_EMAIL;
    const now = new Date();
    const horizon = new Date(now.getTime() + CONFIG.HORIZON_DAYS * 864e5);
    const teamMode = !!CONFIG.SHARED_CAL_ID;

    // 1) Desired state — from one read of the personal calendar, fan out to both targets.
    const desiredOwn = {};    // key "sourceId|YYYY-MM-DD" → { seg, sourceId }
    const desiredShared = {}; // key "sourceId" → { sourceId, startDate, endDate }
    listEvents(CONFIG.PERSONAL_CAL_ID, now, horizon).forEach(ev => {
      if (ev.status === 'cancelled') return;
      if (!isBusy(ev)) return;
      if (skipByResponse(ev)) return;

      // Own work primary: per-weekday segments clipped to work hours (current behavior, all event types).
      segmentsFor(ev).forEach(seg => {
        if (seg.end <= now) return;
        desiredOwn[ev.id + '|' + seg.date] = { seg: seg, sourceId: ev.id };
      });

      // Shared OOO calendar: only all-day events, full duration, no clipping, no weekend skip.
      if (teamMode && isAllDay(ev)) {
        if (parseYmd(ev.end.date) <= now) return; // end.date is exclusive
        desiredShared[ev.id] = {
          sourceId: ev.id,
          startDate: ev.start.date,
          endDate: ev.end.date,
        };
      }
    });

    // 2) Existing state — owner-filtered listing per target calendar.
    const ownerFilter = ['pcalManaged=true', 'pcalOwner=' + ownerEmail];
    const existingOwn = indexExisting(
      listEvents(CONFIG.WORK_CAL_ID, now, horizon, ownerFilter),
      p => p.pcalSourceId + '|' + p.pcalDate
    );
    const existingShared = teamMode ? indexExisting(
      listEvents(CONFIG.SHARED_CAL_ID, now, horizon, ownerFilter),
      p => p.pcalSourceId
    ) : {};

    // 3) Reconcile each target independently.
    reconcile(
      desiredOwn, existingOwn,
      d => hashOfOwn(d.seg),
      (d, h) => Calendar.Events.insert(blockBodyOwn(d.seg, d.sourceId, h, ownerEmail), CONFIG.WORK_CAL_ID),
      (id, d, h) => Calendar.Events.patch(blockBodyOwn(d.seg, d.sourceId, h, ownerEmail), CONFIG.WORK_CAL_ID, id),
      id => Calendar.Events.remove(CONFIG.WORK_CAL_ID, id),
      overBudget, 'own'
    );
    if (teamMode) {
      reconcile(
        desiredShared, existingShared,
        d => hashOfShared(d),
        (d, h) => Calendar.Events.insert(blockBodyShared(d, h, ownerEmail), CONFIG.SHARED_CAL_ID),
        (id, d, h) => Calendar.Events.patch(blockBodyShared(d, h, ownerEmail), CONFIG.SHARED_CAL_ID, id),
        id => Calendar.Events.remove(CONFIG.SHARED_CAL_ID, id),
        overBudget, 'shared'
      );
    }
  } finally {
    lock.releaseLock();
  }
}

/** ---------- reconcile ---------- */

function reconcile(desired, existing, hashFn, createFn, updateFn, deleteFn, overBudget, label) {
  const desiredKeys = Object.keys(desired);
  for (let i = 0; i < desiredKeys.length; i++) {
    if (overBudget()) { console.warn('runSync[%s]: over budget after %s desired ops; deferring rest', label, i); return; }
    const key = desiredKeys[i];
    const d = desired[key], ex = existing[key], h = hashFn(d);
    try {
      if (!ex)                createFn(d, h);
      else if (ex.hash !== h) updateFn(ex.id, d, h);
    } catch (e) {
      console.error('runSync[%s]: create/update failed for key=%s: %s', label, key, e && e.message || e);
    }
  }
  const existingKeys = Object.keys(existing);
  for (let i = 0; i < existingKeys.length; i++) {
    if (overBudget()) { console.warn('runSync[%s]: over budget during deletes after %s ops; deferring rest', label, i); return; }
    const key = existingKeys[i];
    if (desired[key]) continue;
    try { deleteFn(existing[key].id); }
    catch (e) { console.error('runSync[%s]: delete failed for key=%s: %s', label, key, e && e.message || e); }
  }
}

function indexExisting(items, keyFn) {
  const out = {};
  items.forEach(it => {
    const p = (it.extendedProperties && it.extendedProperties.private) || {};
    out[keyFn(p)] = { id: it.id, hash: p.pcalHash };
  });
  return out;
}

/** ---------- helpers ---------- */

function listEvents(calId, timeMin, timeMax, privateExtProps) {
  const out = [];
  let pageToken;
  do {
    const params = {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,       // expand recurrences into individual instances
      showDeleted: false,
      orderBy: 'startTime',
      maxResults: 2500,
      pageToken: pageToken,
    };
    if (privateExtProps && privateExtProps.length) params.privateExtendedProperty = privateExtProps;
    const resp = Calendar.Events.list(calId, params);
    (resp.items || []).forEach(i => out.push(i));
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

function isBusy(ev) { return ev.transparency !== 'transparent'; }
function isAllDay(ev) { return !!(ev.start.date && !ev.start.dateTime); }

/**
 * Skip events the user hasn't actively committed to:
 *  - declined → skip
 *  - needsAction (pending invite) → skip
 *  - accepted / tentative → keep (tentative still holds time)
 * If there's no attendees array (self-organized event with no invitees), keep.
 */
function skipByResponse(ev) {
  if (!ev.attendees) return false;
  const me = ev.attendees.filter(a => a.self)[0];
  if (!me) return false;
  return me.responseStatus === 'declined' || me.responseStatus === 'needsAction';
}

/** Split an event into one clipped [08:00,18:00] segment per weekday it touches. */
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

function blockBodyOwn(seg, sourceId, hash, ownerEmail) {
  return {
    summary: CONFIG.BUSY_TITLE,
    start: { dateTime: seg.start.toISOString() },
    end:   { dateTime: seg.end.toISOString() },
    reminders: { useDefault: false },
    extendedProperties: { private: {
      pcalManaged: 'true',
      pcalOwner:   ownerEmail,
      pcalSourceId: sourceId,
      pcalDate:    seg.date,
      pcalHash:    hash,
    }},
  };
}

function blockBodyShared(d, hash, ownerEmail) {
  return {
    summary: 'OOO - ' + CONFIG.OWNER_DISPLAY_NAME,
    start: { date: d.startDate },
    end:   { date: d.endDate },
    reminders: { useDefault: false },
    extendedProperties: { private: {
      pcalManaged: 'true',
      pcalOwner:   ownerEmail,
      pcalSourceId: d.sourceId,
      pcalDate:    d.startDate,
      pcalHash:    hash,
    }},
  };
}

function hashOfOwn(seg) { return seg.start.getTime() + '-' + seg.end.getTime(); }
function hashOfShared(d) { return d.startDate + '|' + d.endDate + '|' + CONFIG.OWNER_DISPLAY_NAME; }

function parseYmd(s) { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function fmtDate(d) { return Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd'); }
