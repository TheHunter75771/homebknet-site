/*
 * homebknet live status.
 * The page is complete without this file. It ships showing "Status unavailable";
 * this script fetches /status.json (same origin, served by a Worker), fills in the
 * chips, and turns on the copy buttons when the clipboard is usable.
 */
(function () {
  'use strict';

  var STATUS_URL = '/status.json';
  var POLL_MS = 60000;
  var TIMEOUT_MS = 6000;
  var COPY_RESET_MS = 2400;
  // 0 turns this off. Set to e.g. 15 to treat data older than that as unavailable.
  var STALE_MINUTES = 0;

  var doc = document;
  var owner = doc.documentElement.getAttribute('data-owner') || 'the owner';

  var TONES = {
    online:   { word: 'Online',             icon: 'ok' },
    offline:  { word: 'Offline',            icon: 'fail' },
    asleep:   { word: 'Asleep',             icon: 'sleep' },
    starting: { word: 'Starting',           icon: 'start' },
    unknown:  { word: 'Unknown',            icon: 'unknown' },
    na:       { word: 'Status unavailable', icon: 'na' }
  };
  var KNOWN = { online: 1, offline: 1, starting: 1, unknown: 1 };

  // Raw state from the JSON to what the page shows. Offline is normal for games.
  function toKey(state, isGame) {
    if (!KNOWN[state]) return 'unknown';
    if (state === 'offline' && isGame) return 'asleep';
    return state;
  }

  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }

  function setChip(chip, key) {
    var tone = TONES[key] || TONES.unknown;
    chip.setAttribute('data-state', key);
    var use = $('use', chip);
    if (use) use.setAttribute('href', '#i-' + tone.icon);
    var word = $('.chip-word', chip);
    if (word) word.textContent = (chip.getAttribute('data-prefix') || '') + tone.word;
  }

  function setDetail(row, text) {
    var el = $('[data-detail]', row);
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  function isNum(n) { return typeof n === 'number' && isFinite(n) && n >= 0; }
  function players(g) {
    return isNum(g.players) && isNum(g.maxPlayers) && g.maxPlayers > 0 ? g.players + ' of ' + g.maxPlayers + ' playing' : '';
  }

  function watchDetail(key) {
    return {
      online: 'Movies and shows',
      offline: 'Usually back within minutes',
      starting: 'Starting up',
      unknown: 'Can’t check right now'
    }[key] || '';
  }

  function gameRowDetail(key, g) {
    if (key === 'online') return players(g);
    if (key === 'asleep') return 'Ask ' + owner + ' to start it';
    if (key === 'starting') return 'Waking up now';
    if (key === 'unknown') return 'Can’t check right now';
    return '';
  }

  function gameWell(key, g) {
    if (key === 'online') return players(g) || 'Online and ready';
    if (key === 'asleep') return 'Asleep. Ask ' + owner + ' to start it.';
    if (key === 'starting') return 'Waking up. Try joining again in a minute.';
    if (key === 'unknown') return 'Can’t check this one right now. It might still be running.';
    return 'Live status unavailable. You can still try joining.';
  }

  function minutesSince(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t) / 60000));
  }

  function agoText(mins) {
    if (mins === null) return 'Live status';
    if (mins < 1) return 'Updated just now';
    if (mins < 60) return 'Updated ' + mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    return 'Updated ' + hrs + (hrs === 1 ? ' hour' : ' hours') + ' ago';
  }

  var dismissedNotice = null;

  function renderNotice(notice) {
    var box = $('#notice');
    if (!box) return;
    var text = notice && typeof notice.text === 'string' ? notice.text.trim() : '';
    if (!text || text === dismissedNotice) { box.hidden = true; return; }
    var warn = notice.level === 'warn';
    box.setAttribute('data-level', warn ? 'warn' : 'info');
    var use = $('.notice-ic use', box);
    if (use) use.setAttribute('href', warn ? '#i-warn' : '#i-info');
    $('#notice-text').textContent = text;
    box.hidden = false;
  }

  function render(data, note) {
    var ok = !!(data && typeof data === 'object');
    var mins = ok ? minutesSince(data.updated) : null;
    if (ok && STALE_MINUTES > 0 && mins !== null && mins > STALE_MINUTES) {
      ok = false;
      note = 'Status is out of date';
    }

    // Watch
    var wKey = ok ? toKey(data.watch && data.watch.state, false) : 'na';
    $$('[data-chip]', $('.now-row[data-svc="watch"]')).concat($$('[data-svc-chip="watch"]')).forEach(function (c) { setChip(c, wKey); });
    setDetail($('.now-row[data-svc="watch"]'), watchDetail(wKey));
    var now = $('#now');
    if (now) now.setAttribute('data-watch', wKey);
    var down = wKey === 'offline';
    var alertBox = $('#watch-alert');
    if (alertBox) alertBox.hidden = !down;
    var heroDown = $('#hero-down');
    if (heroDown) heroDown.hidden = !down;

    // Games: match page cards to JSON entries by id
    var list = ok && Array.isArray(data.games) ? data.games : [];
    var byId = {};
    list.forEach(function (g) { if (g && typeof g.id === 'string') byId[g.id] = g; });

    $$('[data-game]').forEach(function (el) {
      var id = el.getAttribute('data-game');
      var g = byId[id] || {};
      var key = ok ? toKey(g.state, true) : 'na';
      $$('[data-chip]', el).forEach(function (c) { setChip(c, key); });
      if (el.classList.contains('now-row')) {
        setDetail(el, gameRowDetail(key, g));
        return;
      }
      var well = $('[data-well]', el);
      if (well) {
        well.setAttribute('data-state', key);
        $('[data-well-text]', well).textContent = gameWell(key, g);
        var meter = $('[data-meter]', well);
        var showMeter = key === 'online' && !!players(g);
        if (meter) {
          meter.hidden = !showMeter;
          if (showMeter) {
            var pct = Math.max(4, Math.min(100, Math.round(g.players / g.maxPlayers * 100)));
            $('[data-meter-fill]', meter).style.width = pct + '%';
          }
        }
      }
    });

    // Panel text
    $('#now-updated').textContent = ok ? agoText(mins) : (note || 'Live status couldn’t load');
    $('#now-na').hidden = ok;

    renderNotice(ok ? data.notice : null);
  }

  function load() {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    return fetch(STATUS_URL, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined, headers: { accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) { render(data); })
      .catch(function () { render(null); })
      .then(function () { clearTimeout(timer); });
  }

  // Copy buttons stay hidden unless copying can actually work.
  function initCopy() {
    var canCopy = !!(navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext);
    if (!canCopy) return;
    var live = $('#live');
    $$('[data-copy]').forEach(function (btn) {
      var value = $('[data-copy-value]', btn.parentElement);
      if (!value) return;
      btn.hidden = false;
      var reset = null;
      btn.addEventListener('click', function () {
        var text = value.textContent.trim();
        clearTimeout(reset);
        navigator.clipboard.writeText(text).then(function () {
          btn.setAttribute('data-copied', 'done');
          if (live) live.textContent = 'Address copied to your clipboard';
        }, function () {
          var sel = window.getSelection();
          var range = doc.createRange();
          range.selectNodeContents(value);
          sel.removeAllRanges();
          sel.addRange(range);
          btn.setAttribute('data-copied', 'selected');
          if (live) live.textContent = 'Address selected. Copy it from your device’s menu.';
        }).then(function () {
          reset = setTimeout(function () {
            btn.removeAttribute('data-copied');
            if (live) live.textContent = '';
          }, COPY_RESET_MS);
        });
      });
    });
  }

  function initNotice() {
    var x = $('#notice-x');
    if (!x) return;
    x.addEventListener('click', function () {
      dismissedNotice = $('#notice-text').textContent;
      $('#notice').hidden = true;
    });
  }

  function start() {
    initCopy();
    initNotice();
    if (typeof fetch !== 'function') return;
    $('#now-updated').textContent = 'Checking live status…';
    load();
    setInterval(function () {
      if (doc.visibilityState === 'visible') load();
    }, POLL_MS);
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'visible') load();
    });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})();
