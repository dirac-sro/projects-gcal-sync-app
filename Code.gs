/** ---------- CONFIG ---------- */
const CONFIG = {
  PERSONAL_CAL_ID: 'your.personal@gmail.com', // shared INTO the work account ("See all event details") + accepted
  WORK_CAL_ID:     'primary',                  // the work calendar this script account owns
  TZ:              'Europe/Bratislava',         // must match appsscript.json "timeZone"
  WORK_START_HOUR: 8,
  WORK_END_HOUR:   18,
  HORIZON_DAYS:    90,                          // rolling window (~3 months forward)
  BUSY_TITLE:      'Personal - Busy',
  RUN_BUDGET_MS:   5 * 60 * 1000,               // leave ~1 min headroom under the 6-min hard limit
};

/** Run ONCE manually: validates config, authorizes, installs the 1-minute trigger, does the first sync. */
function initialSetup() {
  assertTzMatches();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runSync')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runSync').timeBased().everyMinutes(1).create();
  runSync();
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

/** Main reconcile loop — invoked every minute by the trigger. */
function runSync() {
  assertTzMatches(); // re-check every run: a later CONFIG.TZ edit must not silently desync.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return; // a prior run is still going — skip this tick
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt > CONFIG.RUN_BUDGET_MS;
  try {
    const now = new Date();
    const horizon = new Date(now.getTime() + CONFIG.HORIZON_DAYS * 864e5);

    // 1) Desired state: per-day work-hour segments from eligible personal events.
    const desired = {}; // key "sourceId|YYYY-MM-DD" -> { seg, sourceId }
    listEvents(CONFIG.PERSONAL_CAL_ID, now, horizon).forEach(ev => {
      if (ev.status === 'cancelled') return;
      if (!isBusy(ev)) return;            // Free always wins (incl. default all-day = Free)
      if (skipByResponse(ev)) return;     // declined OR not-yet-responded invites don't block
      segmentsFor(ev).forEach(seg => {
        if (seg.end <= now) return;       // ignore fully-past segments
        desired[ev.id + '|' + seg.date] = { seg: seg, sourceId: ev.id };
      });
    });

    // 2) Current state: managed busy blocks already on the work calendar.
    const existing = {}; // key -> { id, hash }
    listEvents(CONFIG.WORK_CAL_ID, now, horizon, 'pcalManaged=true').forEach(it => {
      const p = (it.extendedProperties && it.extendedProperties.private) || {};
      existing[p.pcalSourceId + '|' + p.pcalDate] = { id: it.id, hash: p.pcalHash };
    });

    // 3) Reconcile: create / update / delete.
    // Each write wrapped so one bad event doesn't abort the whole run.
    // Budget-aware: bail early if we're approaching the 6-min execution limit; next tick resumes.
    const desiredKeys = Object.keys(desired);
    for (let i = 0; i < desiredKeys.length; i++) {
      if (overBudget()) { console.warn('runSync: over budget after %s desired ops; deferring rest', i); return; }
      const key = desiredKeys[i];
      const d = desired[key], ex = existing[key], h = hashOf(d.seg);
      try {
        if (!ex)                createBlock(d.seg, d.sourceId, h);
        else if (ex.hash !== h) updateBlock(ex.id, d.seg, d.sourceId, h);
      } catch (e) {
        console.error('runSync: create/update failed for key=%s: %s', key, e && e.message || e);
      }
    }

    const existingKeys = Object.keys(existing);
    for (let i = 0; i < existingKeys.length; i++) {
      if (overBudget()) { console.warn('runSync: over budget during deletes after %s ops; deferring rest', i); return; }
      const key = existingKeys[i];
      if (desired[key]) continue;
      try { Calendar.Events.remove(CONFIG.WORK_CAL_ID, existing[key].id); }
      catch (e) { console.error('runSync: delete failed for key=%s: %s', key, e && e.message || e); }
    }
  } finally {
    lock.releaseLock();
  }
}

/** ---------- helpers ---------- */

function listEvents(calId, timeMin, timeMax, privateExtProp) {
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
    if (privateExtProp) params.privateExtendedProperty = privateExtProp;
    const resp = Calendar.Events.list(calId, params);
    (resp.items || []).forEach(i => out.push(i));
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

function isBusy(ev) { return ev.transparency !== 'transparent'; }

/**
 * Skip events the user hasn't actively committed to:
 *  - declined → obviously skip
 *  - needsAction (pending invite) → skip; user hasn't said yes
 *  - accepted / tentative → keep (tentative still holds time)
 * If there's no attendees array (e.g. self-organized event with no invitees), keep.
 */
function skipByResponse(ev) {
  if (!ev.attendees) return false;
  const me = ev.attendees.filter(a => a.self)[0];
  if (!me) return false;
  return me.responseStatus === 'declined' || me.responseStatus === 'needsAction';
}

/** Split an event into one clipped [08:00,18:00] segment per weekday it touches. */
function segmentsFor(ev) {
  const allDay = !!(ev.start.date && !ev.start.dateTime);
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

function createBlock(seg, sourceId, hash) {
  Calendar.Events.insert(blockBody(seg, sourceId, hash), CONFIG.WORK_CAL_ID);
}
function updateBlock(eventId, seg, sourceId, hash) {
  Calendar.Events.patch(blockBody(seg, sourceId, hash), CONFIG.WORK_CAL_ID, eventId);
}
function blockBody(seg, sourceId, hash) {
  return {
    summary: CONFIG.BUSY_TITLE,
    start: { dateTime: seg.start.toISOString() },
    end:   { dateTime: seg.end.toISOString() },
    reminders: { useDefault: false },
    extendedProperties: { private: {
      pcalManaged: 'true', pcalSourceId: sourceId, pcalDate: seg.date, pcalHash: hash,
    }},
  };
}

function hashOf(seg) { return seg.start.getTime() + '-' + seg.end.getTime(); }
function parseYmd(s) { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function fmtDate(d) { return Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd'); }
