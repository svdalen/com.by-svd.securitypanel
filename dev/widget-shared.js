/* Shared client helpers for the dashboard widgets. Homey serves each widget
   folder on its own, so this file is inlined into every widget's index.html
   between the "shared:start" and "shared:end" markers by `npm run widgets`.
   Edit here, never in the widgets. The widget declares `H` (the Homey client)
   before this block. */
var MOTION_LIKE = { alarm_motion: 1, alarm_occupancy: 1, alarm_presence: 1 };

// Inline icons (Feather-style strokes), coloured through CSS.
var ICONS = {
  shield: '<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  shieldCheck: '<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>',
  homePlain: '<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  bellOff: '<svg viewBox="0 0 24 24"><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="M18.6 13A17.9 17.9 0 0 1 18 8"/><path d="M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.3-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  x: '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
  door: '<svg viewBox="0 0 24 24"><path d="M3 21h18"/><path d="M5 21V5a2 2 0 0 1 2-2h7v18"/><path d="M14 3h3a2 2 0 0 1 2 2v16"/><circle cx="11" cy="12" r="1"/></svg>',
  motion: '<svg viewBox="0 0 24 24"><path d="M12 2a4 4 0 0 1 4 4v1H8V6a4 4 0 0 1 4-4z"/><path d="M4 22l3-9h10l3 9"/><path d="M9 13l-1 9M15 13l1 9"/></svg>',
  sensor: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M17.9 17.9A10 10 0 0 1 12 20c-7 0-11-8-11-8a18 18 0 0 1 5.1-6M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
};

/** Translation lookup for one namespace of locales/<lang>.json, with a fallback. */
function makeT(ns) {
  return function (key, fallback) {
    try {
      var s = H.__(ns + '.' + key);
      return (s && s !== ns + '.' + key) ? s : fallback;
    } catch (e) { return fallback; }
  };
}

/** Icon for a sensor row by capability. */
function iconFor(s) {
  if (MOTION_LIKE[s.capability]) return ICONS.motion;
  if (s.capability === 'alarm_contact') return ICONS.door;
  return s.capability === 'alarm_tamper' ? ICONS.alert : ICONS.sensor;
}

// Fold each device's tamper row into its main row (same deviceId); a device
// that only has a tamper capability keeps its own row. Returns new objects,
// the status rows themselves are left alone.
function groupRows(all) {
  var byDev = {}, out = [];
  all.forEach(function (s) {
    if (s.capability === 'alarm_tamper') return;
    var row = Object.assign({}, s, { tamper: null });
    out.push(row);
    if (row.deviceId && !byDev[row.deviceId]) byDev[row.deviceId] = row;
  });
  all.forEach(function (s) {
    if (s.capability !== 'alarm_tamper') return;
    var main = s.deviceId && byDev[s.deviceId];
    if (!main) { out.push(Object.assign({}, s, { tamper: null })); return; }
    if (!main.tamper || (s.enabled && s.active)) main.tamper = s;
  });
  return out;
}
function tampered(s) { return Boolean(s.tamper && s.tamper.enabled && s.tamper.active); }

/** The zone chosen in the widget's autocomplete setting, or null for all. */
function zoneFilter(settings) {
  var z = settings && settings.zone;
  if (!z) return null;
  var id = typeof z === 'object' ? z.id : z;
  return id ? String(id) : null;
}

/** Elapsed-time texts in the two largest units: "45 s", "12 min", "3 h 10 min", "5 d 3 h". */
function makeElapsed(t) {
  function elapsed(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    var m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (s < 60) return s + ' s';
    if (m < 60) return m + ' ' + t('min', 'min');
    if (h < 24) return h + ' ' + t('h', 'h') + (m % 60 ? ' ' + (m % 60) + ' ' + t('min', 'min') : '');
    return d + ' ' + t('d', 'd') + (h % 24 ? ' ' + (h % 24) + ' ' + t('h', 'h') : '');
  }
  return {
    elapsed: elapsed,
    since: function (ts) { return t('since', 'since') + ' ' + elapsed(ts); },
    ago: function (ts) { return Date.now() - ts < 60000 ? t('just_now', 'just now') : elapsed(ts) + ' ' + t('ago', 'ago'); },
  };
}

// A slim line under a scrolling list pages through it: "v 3 more" / "^ back
// to top". Returns the refresh function; call it after every render.
function makePager(container, pagerEl, t, itemSelector) {
  function items() { return itemSelector ? container.querySelectorAll(itemSelector) : container.children; }
  function atEnd() { return container.scrollTop + container.clientHeight >= container.scrollHeight - 2; }
  function update() {
    var overflow = container.scrollHeight > container.clientHeight + 2;
    if (!overflow) { pagerEl.classList.remove('show'); return; }
    var list = items(), below = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].offsetTop + list[i].offsetHeight > container.scrollTop + container.clientHeight + 1) below += 1;
    }
    var end = atEnd();
    pagerEl.innerHTML = (end ? ICONS.up : ICONS.down) + '<span></span>';
    pagerEl.querySelector('span').textContent = end ? t('top', 'back to top') : below + ' ' + t('more', 'more');
    pagerEl.classList.add('show');
  }
  pagerEl.addEventListener('click', function () {
    var end = atEnd();
    try {
      if (end) container.scrollTo({ top: 0, behavior: 'smooth' });
      else container.scrollBy({ top: Math.max(40, container.clientHeight - 24), behavior: 'smooth' });
    } catch (e) { container.scrollTop = end ? 0 : container.scrollTop + container.clientHeight - 24; }
    setTimeout(update, 350);
  });
  var timer = null;
  container.addEventListener('scroll', function () { clearTimeout(timer); timer = setTimeout(update, 80); });
  return update;
}
