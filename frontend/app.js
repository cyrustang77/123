/**
 * SitSync dashboard controller.
 *
 * This file renders Python sensor data or an explicitly selected browser preview.
 * connection.js owns HTTP requests; browser-preview history stays separate.
 * Hardware settings live in config.js; educational content lives in learn.js.
 */
(() => {
  'use strict';
  // Shared settings come from the Arduino/Python reference, loaded before this file.
  const CONFIG = window.SITSYNC_CONFIG;
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'sitsync.demo.v1';
  const GRACE_MS = CONFIG.session.interruptionBufferMs;
  const PRESSURE_THRESHOLD = CONFIG.hardware.pressureThreshold;
  const MIN_SESSION_MS = CONFIG.session.minimumSavedMs;
  const DEMO_FSR_SIGNAL = CONFIG.demo.seatedAdc;
  const DEMO_AWAY_SIGNAL = CONFIG.demo.awayAdc;
  const DEMO_SIGNAL_MAX = CONFIG.hardware.adcMax;

  // Time formatting is kept here so timers, tables, and downloads agree.
  const now = () => Date.now();
  const dayKey = (timestamp) => new Date(timestamp).toLocaleDateString('en-CA');
  const today = () => dayKey(now());
  const escapeHTML = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );
  const timeLabel = (timestamp) =>
    new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const clock = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map((x) => String(x).padStart(2, '0'))
      .join(':');
  };
  const countdown = (ms) => {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return (
      String(Math.floor(seconds / 60)).padStart(2, '0') +
      ':' +
      String(seconds % 60).padStart(2, '0')
    );
  };
  const shortDuration = (ms) => {
    const minutes = Math.floor(Math.max(0, ms) / 60000);
    return minutes >= 60
      ? Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm'
      : minutes + 'm';
  };
  const durationDetail = (ms) => {
    const seconds = Math.floor(Math.max(0, ms) / 1000);
    return seconds < 60 ? seconds + 's' : shortDuration(ms);
  };
  // Browser-preview sessions stay separate from records received from Python.
  const makeSession = (timestamp) => ({
    id: 'session-' + timestamp,
    start: timestamp,
    end: null,
    seatedMs: 0,
    seatedSince: timestamp,
    awaySince: null,
    intervals: [],
    breaks: [],
    lastReset: timestamp,
    reminderSent: false,
    scenario: 'seated',
    sample: false,
  });
  function makeInitialState() {
    // No invented history or automatic sitting session on a fresh visit.
    return {
      version: 1,
      settings: { name: '', reminderMs: CONFIG.preview.reminderMs, goal: 6, reminders: true },
      samples: [],
      sessions: [],
      active: {
        ...makeSession(now()),
        end: now(),
        seatedSince: null,
        scenario: 'away',
        idle: true,
      },
      notifications: [],
      storageAvailable: true,
    };
  }
  let state;
  // Read browser storage without clearing earlier sessions or personal settings.
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (
      parsed &&
      parsed.version === 1 &&
      parsed.active &&
      Array.isArray(parsed.sessions) &&
      parsed.settings
    )
      state = parsed;
  } catch {}
  if (!state) state = makeInitialState();
  if (
    ![CONFIG.preview.reminderMs, CONFIG.preview.everydayReminderMs].includes(
      state.settings.reminderMs,
    )
  ) {
    state.settings.reminderMs = CONFIG.preview.reminderMs;
    state.active.reminderSent = false;
  }
  // Keep existing history and preferences while migrating the earlier visual demo.
  state.active.scenario = state.active.seatedSince !== null ? 'seated' : 'away';
  state.notifications = state.notifications.map((notification) => ({
    ...notification,
    message: notification.message
      .replace(/five-minute|5-minute/g, '10-second')
      .replace(/five minutes|5 minutes/g, '10 seconds'),
  }));
  // Keep browser-preview records separate from Python history.
  const previewState = state;
  let sourceMode = 'preview';
  let backendData = null;
  let backendAvailable = false;
  let serverOffset = 0;
  let liveReminderKey = null;

  function showSampleStatistics() {
    window.SitSyncConnection.preview();
    // Disposable demo state: never save sample rows into browser or Python history.
    state = makeInitialState();
    state.sampleDemo = true;
    state.settings = { ...previewState.settings };
    for (let day = 0; day < 7; day += 1) {
      const anchor = new Date(now());
      anchor.setDate(anchor.getDate() - day);
      const minutesAvailable = anchor.getHours() * 60 + anchor.getMinutes();
      const count = Math.min(5 + (day % 3), Math.floor(minutesAvailable / 50));
      for (let index = 0; index < count; index += 1) {
        const end = anchor.getTime() - (index * 50 + 5) * 60000;
        const duration = (24 + ((day * 7 + index * 3) % 17)) * 60000;
        const start = end - duration;
        const pause = start + 12 * 60000;
        state.sessions.push({
          ...makeSession(start),
          id: 'sample-' + day + '-' + index,
          end,
          seatedMs: duration - 8000,
          seatedSince: null,
          intervals: [
            { start, end: pause },
            { start: pause + 8000, end },
          ],
          breaks: [{ start: pause, end: pause + 8000 }],
          sample: true,
          source: 'sample',
        });
      }
    }
    renderAll();
    toast('Sample statistics loaded. Connect Python to show real hardware sessions.');
  }
  function usingBackend() {
    return sourceMode === 'live';
  }
  function backendFresh() {
    return (
      backendAvailable &&
      backendData?.sensor_connected &&
      now() - (backendData.last_reading_at * 1000 + serverOffset) < 3000
    );
  }
  function backendDate(value) {
    const timestamp = new Date(String(value).replace(' ', 'T')).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  function applyBackendData(data) {
    backendData = data;
    backendAvailable = true;
    serverOffset = now() - (data.server_timestamp || now() / 1000) * 1000;
    const settings = state.settings;
    const records = (data.session_history || data.history || []).flatMap((record, index) => {
      const start = backendDate(record.start_time),
        end = backendDate(record.end_time);
      if (start === null || end === null || !Number.isFinite(record.duration_seconds)) return [];
      return [
        {
          id: 'python-' + start + '-' + index,
          start,
          end,
          seatedMs: record.duration_seconds * 1000,
          seatedSince: null,
          awaySince: null,
          intervals: [{ start, end }],
          breaks: [],
          sample: false,
          source: 'python',
        },
      ];
    });
    const closed = data.status === 'Standing';
    const started = data.start_timestamp ? data.start_timestamp * 1000 + serverOffset : now();
    const reminderKey = data.continuous_start || null;
    state = {
      ...previewState,
      settings,
      sessions: records,
      samples: [],
      active: {
        ...makeSession(started),
        id: 'python-active-' + started,
        end: closed ? now() : null,
        seatedMs: data.session_seconds * 1000,
        seatedSince: null,
        awaySince:
          data.status === 'Paused (Break)'
            ? data.away_since
              ? data.away_since * 1000 + serverOffset
              : now()
            : null,
        lastReset: data.continuous_start ? data.continuous_start * 1000 + serverOffset : now(),
        reminderSent: reminderKey !== null && reminderKey === liveReminderKey,
        source: 'python',
        idle: closed,
        intervals: [],
        breaks: [],
      },
    };
    renderAll();
  }
  function renderConnection() {
    $('weeklyDataCaption').textContent =
      state.sampleDemo && !usingBackend()
        ? 'Sample statistics for demonstration. These are not measured hardware sessions.'
        : state.sessions.length
          ? 'Recorded sessions from the selected data source. Empty days stay empty.'
          : 'No saved sessions yet. Choose Show sample data to preview a populated week, or use live data to track your cushion.';
    for (const view of ['sessions', 'insights']) {
      let notice = document.getElementById(view + 'SampleNotice');
      if (!notice) {
        notice = document.createElement('p');
        notice.id = view + 'SampleNotice';
        notice.className = 'source-panel';
        notice.textContent =
          'SAMPLE DATA · Illustrative statistics. Connect Python from Overview to show real hardware sessions.';
        $('view-' + view).prepend(notice);
      }
      notice.hidden = !state.sampleDemo || usingBackend();
      notice.style.display = notice.hidden ? 'none' : '';
    }
    const label = usingBackend()
      ? !backendAvailable
        ? 'PYTHON DISCONNECTED'
        : backendData?.demo_mode
          ? 'PYTHON DEMO'
          : backendFresh()
            ? 'LIVE SENSOR'
            : 'WAITING FOR ESP32'
      : state.sampleDemo
        ? 'SAMPLE DATA · DEMO'
        : 'BROWSER PREVIEW';
    $('sourceLabel').textContent = label;
    $('sourceLabel').closest('.source-panel').dataset.state =
      usingBackend() && !backendFresh() ? 'waiting' : 'ready';
    $('sourceDescription').textContent = usingBackend()
      ? !backendAvailable
        ? 'Run python main.py, then open http://127.0.0.1:8000.'
        : backendData?.demo_mode
          ? 'Simulated ADC from the Python server. No physical motor is driven.'
          : backendFresh()
            ? 'Moisture-triggered sensor demo. This input does not measure sitting or pressure.'
            : backendData?.serial_error ||
              'Python is reachable, but no recent ESP32 reading is available.'
      : state.sampleDemo
        ? 'Illustrative statistics only. Connect Python for actual hardware records.'
        : 'Manual simulation only. Your real session history stays separate.';
    $('dataSourceValue').textContent = label;
    $('hardwareConnectionValue').textContent =
      usingBackend() && backendFresh() && !backendData.demo_mode
        ? 'Receiving serial readings'
        : 'No live hardware signal';
    $('sourceHealth').textContent = usingBackend()
      ? backendFresh()
        ? 'Receiving'
        : 'Waiting'
      : 'Preview';
    $('sourceHealthLabel').textContent = 'Data source';
    $('signalSourceCaption').textContent = usingBackend()
      ? backendData?.demo_mode
        ? 'Python-demo signal'
        : 'Signal from Python'
      : 'Browser-preview signal';
    $('rawSignalLabel').textContent = usingBackend() ? 'RAW ADC FROM PYTHON' : 'SIMULATED RAW ADC';
    $('liveConnectButton').textContent = usingBackend() ? 'Reconnect' : 'Connect Python';
    document.querySelectorAll('[data-scenario]').forEach((button) => {
      button.disabled = usingBackend();
    });
    document.querySelectorAll('[data-action="haptic"]').forEach((button) => {
      button.disabled =
        state.active.end !== null ||
        state.active.awaySince !== null ||
        (usingBackend() && !backendFresh());
      button.textContent = usingBackend() ? 'Send reminder' : 'Preview pattern';
    });
    $('historySourceLabel').textContent = usingBackend()
      ? 'Python session log'
      : state.sampleDemo
        ? 'Sample sessions · illustrative data'
        : 'Your browser-preview sessions';
    $('todaySourceLabel').textContent = usingBackend()
      ? 'PYTHON DATA'
      : state.sampleDemo
        ? 'SAMPLE DATA'
        : 'PREVIEW DATA';
    $('secondStatLabel').textContent = usingBackend() ? 'Saved sessions today' : 'Movement breaks';
    $('averageStatLabel').textContent = usingBackend()
      ? 'Average saved session'
      : 'Average sitting stretch';
    $('timelineSeatedLabel').textContent = usingBackend() ? 'Session window' : 'Seated';
    $('timelineBreakLegend').hidden = usingBackend();
    $('timelineAwayLabel').textContent = usingBackend() ? 'No session recorded' : 'Away';
    $('previewControls').hidden = usingBackend();
  }
  window.addEventListener('sitsync-connection', (event) => {
    const { kind, data } = event.detail;
    if (kind === 'preview') {
      const settings = state.settings;
      sourceMode = 'preview';
      state = previewState;
      state.settings = settings;
      backendAvailable = false;
      backendData = null;
      stopHapticPreview();
      reconcile();
      renderAll();
    } else {
      sourceMode = 'live';
      if (kind === 'data') applyBackendData(data);
      else {
        backendAvailable = false;
        stopHapticPreview();
        renderAll();
      }
    }
  });

  let storageWarningShown = false;
  function save() {
    if (state.sampleDemo) return;
    try {
      const stored = usingBackend() ? { ...previewState, settings: state.settings } : state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      state.storageAvailable = false;
      if (!storageWarningShown) {
        storageWarningShown = true;
        toast(
          'Browser storage is unavailable. This visit still works; export your data to keep it.',
        );
      }
    }
  }
  // Short notifications and the notification history.
  let toastTimeout;
  function toast(message) {
    $('toastText').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => $('toast').classList.remove('show'), 5000);
  }
  function notify(title, message) {
    state.notifications.unshift({ title, message, time: now() });
    state.notifications = state.notifications.slice(0, 12);
    $('notificationDot').hidden = false;
    save();
  }
  // Session lifecycle: count occupied time, pause, resume, and save.
  function seatedDuration(session, timestamp = now()) {
    if (usingBackend()) return session.seatedMs;
    // Count only occupied time; a brief absence never adds to this total.
    return (
      session.seatedMs +
      (session.seatedSince !== null ? Math.max(0, timestamp - session.seatedSince) : 0)
    );
  }
  function closeSession(timestamp) {
    const session = state.active;
    if (!session || session.end !== null) return false;
    if (session.seatedSince !== null) {
      session.seatedMs += Math.max(0, timestamp - session.seatedSince);
      session.intervals.push({ start: session.seatedSince, end: timestamp });
      session.seatedSince = null;
    }
    session.end = timestamp;
    if (session.awaySince !== null) {
      const latest = session.breaks[session.breaks.length - 1];
      if (latest && latest.end === null) latest.end = timestamp;
    }
    const recorded = session.seatedMs >= MIN_SESSION_MS;
    if (recorded) state.sessions.unshift({ ...session });
    state.active = { ...session, seatedMs: 0, intervals: [], breaks: [], end: timestamp, recorded };
    save();
    return recorded;
  }
  function reconcile(timestamp = now()) {
    if (usingBackend()) return;
    // The Python-style session buffer groups brief interruptions. It is separate
    // from the Arduino reminder, which restarts after every stand-up.
    const session = state.active;
    if (
      session.end === null &&
      session.awaySince !== null &&
      timestamp - session.awaySince >= GRACE_MS
    ) {
      const recorded = closeSession(session.awaySince + GRACE_MS);
      notify(
        recorded ? 'Session saved' : 'Brief pressure ignored',
        recorded
          ? 'Your 10-second buffer ended. Sit down to begin a fresh session.'
          : 'Sessions under 3 seconds are not saved. Sit down to begin a fresh session.',
      );
    }
    // Split at the local midnight boundary if a seated demo remains open overnight.
    if (state.active.end === null && dayKey(state.active.start) !== dayKey(timestamp)) {
      const midnight = new Date(timestamp);
      midnight.setHours(0, 0, 0, 0);
      const wasSeated = state.active.seatedSince !== null;
      closeSession(midnight.getTime());
      if (wasSeated) state.active = makeSession(midnight.getTime());
      save();
    }
  }
  function setScenario(scenario) {
    if (usingBackend()) return;
    if (!['seated', 'away'].includes(scenario)) return;
    reconcile();
    if (usingBackend() && !backendFresh()) {
      $('sessionTime').innerHTML = clock(
        backendData?.session_seconds ? backendData.session_seconds * 1000 : 0,
      )
        .split(':')
        .join('<span>:</span>');
      $('sessionState').textContent = backendAvailable
        ? 'Waiting for a sensor reading.'
        : 'Python connection unavailable.';
      $('timerCaption').textContent = 'Timer is not advancing without fresh sensor data';
      $('resetLabel').textContent = 'No current hardware signal';
      $('resetTime').textContent = 'Waiting';
      $('sessionNote').textContent =
        'Browser simulation will never replace a lost live signal automatically.';
      return;
    }
    const timestamp = now(),
      session = state.active;
    if (scenario === 'away') {
      if (session.end !== null || session.seatedSince === null) return;
      session.seatedMs += timestamp - session.seatedSince;
      session.intervals.push({ start: session.seatedSince, end: timestamp });
      session.seatedSince = null;
      session.awaySince = timestamp;
      session.breaks.push({ start: timestamp, end: null });
      session.scenario = 'away';
      session.reminderSent = false;
      motorReleaseSince = timestamp;
      toast('Seat released. Your session stays open for 10 seconds.');
      notify(
        'A little room to move',
        'Your seated timer is paused. Return before the 10-second buffer ends to resume this session.',
      );
    } else {
      if (session.end !== null) {
        state.active = makeSession(timestamp);
        toast('A fresh session, automatically started.');
      } else if (session.awaySince !== null) {
        const latest = session.breaks[session.breaks.length - 1];
        if (latest && latest.end === null) latest.end = timestamp;
        session.awaySince = null;
        session.seatedSince = timestamp;
        // Arduino resets its reminder whenever pressure drops, even if Python
        // keeps the same sitting session open during its 10-second buffer.
        session.lastReset = timestamp;
        session.reminderSent = false;
        toast('Welcome back. Same session, fresh perspective.');
      }
      state.active.scenario = scenario;
      motorReleaseSince = null;
    }
    save();
    renderAll();
  }
  function sessionToday(session) {
    return dayKey(session.start) === today();
  }
  function completedToday() {
    return state.sessions.filter(sessionToday);
  }
  function breakCount() {
    return (
      completedToday().reduce((sum, s) => sum + s.breaks.filter((b) => b.end !== null).length, 0) +
      (state.active.end === null ? state.active.breaks.filter((b) => b.end !== null).length : 0)
    );
  }
  // Dashboard rendering. These functions read state and update the page.
  let chartPeriod = 'today',
    sessionFilter = 'all',
    currentView = 'overview';
  function renderIdentity() {
    const name = state.settings.name.trim();
    $('overview-heading').textContent = name
      ? 'Good to see you, ' + name + '.'
      : 'Find your rhythm.';
    const accent = document.createElement('span');
    accent.textContent = '.';
    if (!name) {
      $('overview-heading').textContent = 'Find your rhythm';
      $('overview-heading').append(accent);
    }
    $('profileName').textContent = name ? name + "'s workspace" : 'Your workspace';
    $('profileInitial').textContent = name ? name[0].toUpperCase() : 'Y';
    document.querySelector('.header-avatar').textContent = name ? name[0].toUpperCase() : 'S';
    $('todayDate').textContent = new Date()
      .toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
      .toUpperCase();
    $('dayLabel').textContent = new Date()
      .toLocaleDateString([], { month: 'short', day: 'numeric' })
      .toUpperCase();
    const localStatus = document.querySelector('.local-status');
    localStatus.lastChild.textContent = usingBackend()
      ? backendAvailable
        ? ' Python connection'
        : ' Python unavailable'
      : state.storageAvailable === false
        ? ' Session memory only'
        : ' Browser preview';
  }
  function updateTimer() {
    reconcile();
    const timestamp = now(),
      session = state.active;
    const closed = session.end !== null,
      away = session.awaySince !== null || closed;
    $('sessionTime').innerHTML = clock(closed ? 0 : seatedDuration(session, timestamp))
      .split(':')
      .join('<span>:</span>');
    $('sessionState').textContent = closed
      ? 'A fresh start is a seat away.'
      : away
        ? 'A little space to reset.'
        : 'Settled in. Stay mindful.';
    $('sessionDot').style.background = away ? '#d9c58d' : '#afcce8';
    $('timerCaption').textContent = closed
      ? 'Sit down to start your next session'
      : away
        ? 'Paused — time away is not counted'
        : 'Time seated in this session';
    const elapsed = timestamp - (session.lastReset || timestamp);
    let progress = 0;
    if (closed) {
      $('resetLabel').textContent = session.idle
        ? 'Ready for a new session'
        : session.recorded === false
          ? 'Brief pressure ignored'
          : 'Your session has been saved';
      $('resetTime').textContent = 'Ready when you are';
      $('resetTime').style.fontSize = '17px';
      $('sessionNote').textContent = session.idle
        ? 'Sit down on the cushion, or use Sit down in browser preview.'
        : session.recorded === false
          ? 'Sessions under 3 seconds are not saved. Your next session begins when you sit down.'
          : 'Your next session begins automatically when you sit down.';
    } else if (away) {
      $('resetLabel').textContent = 'Holding your session for';
      $('resetTime').textContent = countdown(GRACE_MS - (timestamp - session.awaySince));
      $('resetTime').style.fontSize = '';
      $('sessionNote').textContent =
        'A 10-second buffer handles a brief interruption. Time away is excluded; longer breaks end this session.';
      progress = Math.min(100, ((timestamp - session.awaySince) / GRACE_MS) * 100);
    } else {
      const interval = usingBackend()
        ? (backendData.reminder_seconds || 30) * 1000
        : state.settings.reminderMs;
      $('resetLabel').textContent =
        elapsed >= interval ? 'Your reminder is due' : 'Your next reminder preview';
      $('resetTime').textContent =
        elapsed >= interval ? 'Time to stretch' : countdown(interval - elapsed);
      $('resetTime').style.fontSize = '';
      $('sessionNote').textContent =
        elapsed >= interval
          ? 'Pattern: 500 ms on / 500 ms off. Five continuous seconds away stop it.'
          : usingBackend()
            ? 'Python schedules the hardware cue, even when this page is closed.'
            : 'Browser preview simulates the cue; connect Python for hardware.';
      progress = Math.min(100, (elapsed / interval) * 100);
      if (elapsed >= interval && !session.reminderSent) {
        session.reminderSent = true;
        if (usingBackend()) liveReminderKey = backendData.continuous_start;
        if (state.settings.reminders) {
          toast('A little movement is due. Stand up, stretch, and make some space.');
          notify(
            'Time for a little reset',
            'Your movement cue is due. Motor pattern: 500 ms on/off until five continuous seconds away.',
          );
          if (!usingBackend()) animateHaptic();
        }
        save();
      }
    }
    $('breakProgress').style.width = progress + '%';
    const button = $('breakButton');
    button.innerHTML = away
      ? '<svg><use href="#i-mat"/></svg> Sit back down <span>↙</span>'
      : '<svg><use href="#i-walk"/></svg> Take a little break <span>↗</span>';
    const completed = completedToday();
    const total =
      completed.reduce((sum, s) => sum + s.seatedMs, 0) +
      (closed ? 0 : seatedDuration(session, timestamp));
    $('totalSeated').textContent = shortDuration(total);
    const count = completed.length + (closed ? 0 : 1);
    $('sessionCount').textContent = count;
    // Python logs occupied duration, but does not retain each short break's timestamps.
    const stretches = usingBackend()
      ? completed.map((s) => s.seatedMs)
      : completed.flatMap((s) => s.intervals.map((i) => i.end - i.start));
    if (!usingBackend() && !closed) {
      stretches.push(...session.intervals.map((i) => i.end - i.start));
      if (session.seatedSince !== null) stretches.push(timestamp - session.seatedSince);
    }
    $('averageStretch').innerHTML =
      (stretches.length
        ? Math.round(stretches.reduce((a, b) => a + b, 0) / stretches.length / 60000)
        : 0) + '<span> min</span>';
  }
  function renderOccupancy() {
    // One FSR reports occupancy. It does not report where weight is distributed.
    const session = state.active,
      away = session.end !== null || session.awaySince !== null;
    const scenario = away ? 'away' : 'seated';
    const signal = usingBackend()
      ? backendFresh()
        ? backendData.raw_adc
        : 0
      : away
        ? DEMO_AWAY_SIGNAL
        : DEMO_FSR_SIGNAL;
    const signalPercent = (signal / DEMO_SIGNAL_MAX) * 100;
    const threshold = usingBackend()
      ? (backendData?.sensor_threshold ?? PRESSURE_THRESHOLD)
      : PRESSURE_THRESHOLD;
    const detected = signal <= threshold;
    const status =
      usingBackend() && !backendFresh()
        ? 'No signal'
        : session.end !== null
          ? 'Standing'
          : away
            ? 'Paused (Break)'
            : 'Sitting';
    const badge = $('occupancyBadge');
    badge.classList.toggle('away', away);
    badge.innerHTML =
      '<i></i>' +
      (status === 'Sitting'
        ? 'Sensor active'
        : status === 'Standing'
          ? 'Sensor inactive'
          : status === 'Paused (Break)'
            ? 'Inactive · buffer'
            : status);
    $('cushionStage').classList.toggle('away', away);
    $('occupancyCaption').textContent = away ? 'Sensor inactive' : 'Moisture input active';
    $('seatDetection').textContent =
      usingBackend() && !backendFresh() ? 'Unknown' : detected ? 'Detected' : 'Not detected';
    $('fsrSignal').innerHTML =
      usingBackend() && !backendFresh() ? '—' : signal + '<span> ADC</span>';
    $('fsrSignalFill').style.width = signalPercent + '%';
    $('fsrSignalTrack').setAttribute('aria-valuemax', String(DEMO_SIGNAL_MAX));
    $('fsrSignalTrack').setAttribute('aria-valuenow', String(signal));
    $('fsrSignalTrack').setAttribute(
      'aria-valuetext',
      signal +
        ' ADC. ' +
        (usingBackend() ? 'Python sensor data. ' : 'Browser preview. ') +
        'Active at or below: ' +
        threshold +
        ' ADC.',
    );
    $('fsrThresholdMarker').style.left = (PRESSURE_THRESHOLD / DEMO_SIGNAL_MAX) * 100 + '%';
    $('sensorList').innerHTML = `
  <div class="sensor-row">
   <div class="sensor-label">
    <span>Moisture demo · raw ADC</span>
    <b>${signal} ADC</b>
   </div>
   <div class="sensor-bar"><i style="width:${signalPercent}%"></i></div>
  </div>
  <dl>
   <div><dt>Active threshold</dt><dd>≤ ${threshold} ADC</dd></div>
   <div><dt>Reference status</dt><dd>${status}</dd></div>
   <div><dt>Sensor activated</dt><dd>${detected ? 'Yes' : 'No'}</dd></div>
   <div><dt>Measurement</dt><dd>Moisture-triggered demonstration only</dd></div>
  </dl>
 `;
    document.querySelectorAll('[data-scenario]').forEach((button) => {
      const selected = button.dataset.scenario === scenario;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }
  function renderStats() {
    const count = breakCount(),
      goal = state.settings.goal;
    $('movementCount').innerHTML = count + '<span> / ' + goal + '</span>';
    $('movementHint').textContent =
      count >= goal
        ? 'You made space for your daily goal'
        : goal - count + ' more ' + (goal - count === 1 ? 'moment' : 'moments') + ' for yourself';
    $('breakDots').innerHTML = Array.from(
      { length: goal },
      (_, i) => '<i class="' + (i < count ? 'filled' : '') + '"></i>',
    ).join('');
    $('breakDots').setAttribute('aria-label', count + ' of ' + goal + ' movement breaks');
    if (usingBackend()) {
      $('movementCount').textContent = String(completedToday().length);
      $('movementHint').textContent = 'Completed records from Python';
      $('breakDots').innerHTML = '';
    }
    $('winText').textContent = usingBackend()
      ? 'Session history comes from the Python log.'
      : 'You made room for ' + count + ' ' + (count === 1 ? 'break' : 'breaks') + ' today.';
  }
  // Timeline, recorded weekly sessions, and the session-history table.
  function weekHTML(compact = false) {
    const values = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - 6 + index);
      const key = dayKey(date);
      const records = state.sessions.filter((s) => dayKey(s.start) === key);
      return {
        label: date.toLocaleDateString([], { weekday: 'short' }),
        count: records.length,
      };
    });
    const max = Math.max(1, ...values.map((value) => value.count));
    return values
      .map(
        (value) => `
      <div class="week-col">
        ${compact ? '' : '<b>' + value.count + '</b>'}
        <div class="week-bar" style="height:${(value.count / max) * 78}%"
             title="${value.label}: ${value.count} saved sessions"></div>
        <span>${value.label}</span>
      </div>`,
      )
      .join('');
  }
  function renderChart() {
    // Draw recorded seated intervals and breaks, rather than a made-up pressure graph.
    if (chartPeriod === 'week') {
      $('rhythmChart').innerHTML = '<div class="week-timeline">' + weekHTML(true) + '</div>';
      return;
    }
    const timestamp = now();
    const history = completedToday();
    const active = state.active.end === null ? state.active : null;
    let intervals = history.flatMap((s) => s.intervals.map((i) => ({ ...i, live: false })));
    if (active) {
      intervals.push(...active.intervals.map((i) => ({ ...i, live: false })));
      if (active.seatedSince !== null)
        intervals.push({
          start: active.seatedSince,
          end: timestamp,
          live: true,
        });
    }
    const first = Math.min(...intervals.map((i) => i.start), timestamp - 60000);
    const start = new Date(first);
    start.setMinutes(0, 0, 0);
    const end = new Date(timestamp);
    end.setHours(end.getHours() + 1, 0, 0);
    const duration = end - start;
    const position = (t) => Math.max(0, Math.min(100, ((t - start) / duration) * 100));
    const segments = intervals
      .map(
        (i) =>
          '<span class="timeline-segment ' +
          (i.live ? 'live' : '') +
          '" style="left:' +
          position(i.start) +
          '%;width:' +
          Math.max(0.5, position(i.end) - position(i.start)) +
          '%" title="' +
          (i.live ? 'Current session' : 'Recorded session window') +
          ' · ' +
          timeLabel(i.start) +
          ' · ' +
          durationDetail(i.end - i.start) +
          '"></span>',
      )
      .join('');
    const breaks = [...history, ...(active ? [active] : [])].flatMap((s) => s.breaks);
    const breakSegments = breaks
      .map(
        (b) =>
          '<span class="timeline-segment break" style="left:' +
          position(b.start) +
          '%;width:' +
          Math.max(0.35, position(b.end || timestamp) - position(b.start)) +
          '%" title="Movement break · ' +
          durationDetail((b.end || timestamp) - b.start) +
          '"></span>',
      )
      .join('');
    const hours = Array.from({ length: 6 }, (_, i) =>
      timeLabel(start.getTime() + (duration * i) / 5),
    );
    $('rhythmChart').innerHTML =
      '<div class="chart-grid">' +
      hours.map(() => '<i></i>').join('') +
      '</div><div class="timeline-lane">' +
      segments +
      breakSegments +
      '</div><div class="chart-hours">' +
      hours.map((h) => '<span>' + h + '</span>').join('') +
      '</div>';
  }
  function renderSessions() {
    // Identify each session's source and keep unfinished sessions clearly labeled.
    const active = state.active.end === null ? [state.active] : [];
    let sessions = [...active, ...state.sessions].sort((a, b) => b.start - a.start);
    if (sessionFilter === 'completed') sessions = sessions.filter((s) => s.end !== null);
    $('sessionRows').innerHTML = sessions.length
      ? sessions
          .map((s, i) => {
            const current = s.end === null;
            const breaks = s.breaks.filter((b) => b.end !== null).length;
            return (
              '<tr><td>' +
              (current ? 'Current session' : 'Sitting session') +
              '<small>' +
              (s.sample
                ? 'Sample data'
                : s.source === 'python'
                  ? 'Python log'
                  : 'Browser preview') +
              '</small></td><td>' +
              escapeHTML(timeLabel(s.start)) +
              '<small>' +
              escapeHTML(
                new Date(s.start).toLocaleDateString([], { month: 'short', day: 'numeric' }),
              ) +
              '</small></td><td>' +
              durationDetail(current ? seatedDuration(s) : s.seatedMs) +
              '</td><td>' +
              (s.source === 'python' ? 'Not logged' : breaks) +
              '</td><td><span class="row-badge ' +
              (current ? 'current' : '') +
              '">' +
              (current ? (s.awaySince !== null ? 'On a break' : 'In progress') : 'Completed') +
              '</span></td></tr>'
            );
          })
          .join('')
      : '<tr><td colspan="5" class="empty-state">No completed sessions yet. Your next little habit starts here.</td></tr>';
  }
  function fillSettings() {
    $('nameInput').value = state.settings.name;
    $('intervalInput').value = state.settings.reminderMs;
    $('goalInput').value = state.settings.goal;
    $('reminderInput').checked = state.settings.reminders;
  }
  function renderAll() {
    updateTimer();
    renderIdentity();
    renderOccupancy();
    renderStats();
    renderChart();
    renderSessions();
    renderConnection();
    $('weeklyChart').innerHTML = weekHTML();
    renderSessionComparison();
  }

  function renderSessionComparison() {
    const records = [...state.sessions].sort((a, b) => a.start - b.start).slice(-12);
    const host = $('sessionComparison');
    if (!records.length) {
      host.textContent =
        'Your completed sessions will appear here. Use Show sample data to preview.';
      return;
    }
    const maximum = Math.max(1, ...records.map((session) => session.seatedMs / 60000));
    const points = records.map((session, index) => ({
      x: records.length === 1 ? 300 : 48 + (index * 504) / (records.length - 1),
      y: 170 - (session.seatedMs / 60000 / maximum) * 140,
      minutes: session.seatedMs / 60000,
    }));
    host.innerHTML = `<svg viewBox="0 0 600 210" role="img" aria-label="Sitting duration of the last ${records.length} completed sessions, oldest to newest" class="session-line-chart">
      <path d="M48 20V170H560" stroke="#c4d8ec" fill="none"/>
      <text x="4" y="30">${Math.ceil(maximum)}m</text><text x="12" y="175">0m</text>
      <polyline points="${points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#4085c6" stroke-width="3"/>
      ${points.map((p, index) => `<circle cx="${p.x}" cy="${p.y}" r="5" fill="#285d92"><title>Session ${index + 1}: ${p.minutes.toFixed(1)} minutes</title></circle><text x="${p.x}" y="198" text-anchor="middle">${index + 1}</text>`).join('')}
      </svg><p>${state.sampleDemo ? 'Sample data' : usingBackend() ? 'Python session records' : 'Browser-preview records'} · Oldest → newest · Longer sitting is not a higher health score.</p>
      <div class="session-ranking">${[...records]
        .sort((a, b) => a.seatedMs - b.seatedMs)
        .slice(0, 5)
        .map(
          (session, index) =>
            `<p><b>${index + 1}. ${escapeHTML(timeLabel(session.start))}</b> — ${(session.seatedMs / 60000).toFixed(1)} min seated <small>(${escapeHTML(dayKey(session.start))})</small></p>`,
        )
        .join('')}</div>`;
  }
  function route() {
    // Hash links keep this build usable directly from index.html without a server.
    const requested = location.hash.slice(1) || 'overview';
    currentView = ['overview', 'sessions', 'insights', 'learn', 'device', 'settings'].includes(
      requested,
    )
      ? requested
      : 'overview';
    const labels = {
      overview: 'Overview',
      sessions: 'Sessions',
      insights: 'Insights',
      learn: 'Learn',
      device: 'My cushion',
      settings: 'Preferences',
    };
    document.querySelectorAll('.view').forEach((view) => {
      const visible = view.id === 'view-' + currentView;
      view.hidden = !visible;
      view.classList.toggle('active', visible);
    });
    document.querySelectorAll('[data-view]').forEach((link) => {
      const active = link.dataset.view === currentView;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    $('breadcrumb').textContent = labels[currentView];
    document.title = 'SitSync — ' + labels[currentView];
    if (currentView === 'settings') fillSettings();
    renderAll();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  // Downloads stay local. They do not write to the Python backend.
  function exportCSV() {
    reconcile();
    const active = state.active.end === null ? [state.active] : [];
    const rows = [
      ['id', 'source', 'started_at', 'ended_at', 'seated_seconds', 'completed_breaks', 'status'],
      ...[...state.sessions, ...active].map((s) => [
        s.id,
        s.sample ? 'sample data' : s.source === 'python' ? 'python' : 'browser preview',
        new Date(s.start).toISOString(),
        s.end === null ? '' : new Date(s.end).toISOString(),
        Math.floor((s.end === null ? seatedDuration(s) : s.seatedMs) / 1000),
        s.breaks.filter((b) => b.end !== null).length,
        s.end === null ? (s.awaySince !== null ? 'on break' : 'seated') : 'completed',
      ]),
    ];
    const csv = rows
      .map((row) => row.map((value) => '"' + String(value).replace(/"/g, '""') + '"').join(','))
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download =
      (state.sampleDemo ? 'sitsync-SAMPLE-sessions-' : 'sitsync-sessions-') + today() + '.csv';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Your session history has been exported as a CSV.');
  }
  function formatBackendDate(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');
    return (
      date.getFullYear() +
      '-' +
      pad(date.getMonth() + 1) +
      '-' +
      pad(date.getDate()) +
      ' ' +
      pad(date.getHours()) +
      ':' +
      pad(date.getMinutes()) +
      ':' +
      pad(date.getSeconds())
    );
  }
  function exportSessionsJSON() {
    reconcile();
    // Match Python's sessions.json schema. Export actual completed demo sessions only:
    // no illustrative samples, unfinished sessions, or accidental sub-3-second bumps.
    const records = state.sessions
      .filter(
        (session) => !session.sample && session.end !== null && session.seatedMs >= MIN_SESSION_MS,
      )
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((session) => ({
        start_time: formatBackendDate(session.start),
        end_time: formatBackendDate(session.end),
        duration_seconds: Math.floor(session.seatedMs / 1000),
      }));
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(records, null, 2) + '\n'], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = usingBackend()
      ? 'sitsync-python-sessions.json'
      : 'sitsync-preview-sessions.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(
      records.length
        ? 'Completed sessions exported as JSON.'
        : 'No completed sessions yet. Exported an empty JSON list.',
    );
  }
  let routineTimer = null;
  // Every dialog uses the same container. Closing it also stops its reset timer.
  function closeDialog() {
    clearInterval(routineTimer);
    routineTimer = null;
    $('appDialog').close();
  }
  function showDialog(eyebrow, content) {
    clearInterval(routineTimer);
    routineTimer = null;
    $('dialogEyebrow').textContent = eyebrow;
    $('dialogContent').innerHTML = content;
    if (!$('appDialog').open) $('appDialog').showModal();
  }
  function showRoutine() {
    showDialog(
      'A MOMENT FOR YOURSELF',
      '<div class="dialog-icon"><svg><use href="#i-leaf"/></svg></div><h2>Make a little space.</h2><p>A simple 60-second pause. Stand comfortably, relax your shoulders, and move in a way that feels good to you.</p><div class="routine-timer" id="routineTime">01:00</div><div class="routine-step" id="routineStep">A small pause. No perfect way to do it.</div><button class="button button-blue" id="routineStart">Start my reset <svg><use href="#i-arrow"/></svg></button>',
    );
    $('routineStart').addEventListener(
      'click',
      () => {
        setScenario('away');
        const end = now() + 60000;
        $('routineStart').disabled = true;
        $('routineStart').textContent = 'A moment, just for you…';
        const tick = () => {
          const remaining = Math.max(0, end - now());
          $('routineTime').textContent = countdown(remaining);
          $('routineStep').textContent =
            remaining > 40000
              ? 'Stand up and let your arms relax.'
              : remaining > 20000
                ? 'Gently roll your shoulders. Take your time.'
                : remaining > 0
                  ? 'Take a few easy steps. Come back when you’re ready.'
                  : 'A little reset, complete. Welcome back.';
          if (remaining === 0) {
            clearInterval(routineTimer);
            routineTimer = null;
            $('routineStart').disabled = false;
            $('routineStart').textContent = 'Finish my reset';
            $('routineStart').onclick = () => {
              closeDialog();
              toast('A little space makes a difference. Sit down whenever you’re ready.');
            };
          }
        };
        routineTimer = setInterval(tick, 250);
        tick();
      },
      { once: true },
    );
  }
  // Current firmware: BUZZ starts a repeating 500ms on / 500ms off pattern.
  // Five continuous seconds below the threshold stop it; this is not the 10s session buffer.
  let motorStartedAt = null;
  let motorReleaseSince = null;
  function stopHapticPreview() {
    motorStartedAt = null;
    motorReleaseSince = null;
    $('cushionStage').classList.remove('motor-on');
    $('motorPreviewStatus').textContent = 'Off';
  }
  function updateMotorPreview() {
    if (usingBackend()) {
      if (!backendFresh() || !backendData.buzz_active) {
        stopHapticPreview();
        if (!backendFresh()) $('motorPreviewStatus').textContent = 'Unknown · no signal';
        return;
      }
      motorStartedAt = backendData.buzz_started
        ? backendData.buzz_started * 1000 + serverOffset
        : now();
    }
    if (motorStartedAt === null) return;
    if (
      !usingBackend() &&
      motorReleaseSince !== null &&
      now() - motorReleaseSince >= CONFIG.hardware.breakDurationMs
    ) {
      stopHapticPreview();
      return;
    }
    const cycle = CONFIG.hardware.vibrateMs + CONFIG.hardware.restMs;
    const on = (now() - motorStartedAt) % cycle < CONFIG.hardware.vibrateMs;
    $('cushionStage').classList.toggle('motor-on', on);
    $('motorPreviewStatus').textContent = on ? 'Pulse on · 500 ms' : 'Rest · 500 ms';
  }
  async function animateHaptic() {
    if (state.active.end !== null || state.active.awaySince !== null) return;
    if (usingBackend()) {
      try {
        await window.SitSyncConnection.buzz();
        toast(
          backendData?.demo_mode
            ? 'Python demo motor pattern started.'
            : 'BUZZ command sent to ESP32.',
        );
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    if (motorStartedAt !== null) return;
    motorStartedAt = now();
    motorReleaseSince = null;
    updateMotorPreview();
    toast('Browser pattern preview. Stand for 5 continuous seconds to stop it.');
  }
  function showBreak() {
    if (usingBackend()) {
      showRoutine();
      return;
    }
    if (state.active.end !== null || state.active.awaySince !== null) {
      setScenario('seated');
      return;
    }
    setScenario('away');
    showDialog(
      'A MOMENT AWAY',
      '<div class="dialog-icon"><svg><use href="#i-walk"/></svg></div><h2>A little room to move.</h2><p>Your seated timer is paused. The cushion holds this session for <strong>10 seconds</strong> to handle a brief interruption.</p><p>A washroom trip or longer break will usually end the session. Sitting again starts a fresh one. Time away never counts as sitting.</p><button class="button button-blue" id="returnToSeat">I’m back — sit down <svg><use href="#i-arrow"/></svg></button>',
    );
    $('returnToSeat').onclick = () => {
      setScenario('seated');
      closeDialog();
    };
  }
  function showPrivacy() {
    showDialog(
      'PRIVATE BY DESIGN',
      '<div class="dialog-icon"><svg><use href="#i-shield"/></svg></div><h2>Your data stays local.</h2><p>Your preferences and reading list stay in this browser. Python stores connected sessions in the local sessions.json file. Browser-preview sessions are kept separately.</p><p>There are no analytics or cloud accounts. The source label identifies hardware readings, Python demo readings, or browser preview.</p><button class="button button-blue" id="privacyExport">Export my session data <svg><use href="#i-download"/></svg></button>',
    );
    $('privacyExport').onclick = exportCSV;
  }
  function showNotifications() {
    $('notificationDot').hidden = true;
    const items = state.notifications.length
      ? state.notifications
      : [
          {
            title: 'Your quiet companion is ready',
            message:
              'Try sitting down and standing up. One simulated FSR input detects seat pressure; it does not measure posture.',
            time: now(),
          },
        ];
    showDialog(
      'YOUR LITTLE NUDGES',
      '<h2>A moment of awareness.</h2>' +
        items
          .map(
            (n) =>
              '<div class="notification-item"><svg><use href="#i-leaf"/></svg><div><b>' +
              escapeHTML(n.title) +
              '</b><p>' +
              escapeHTML(n.message) +
              '</p><small>' +
              escapeHTML(timeLabel(n.time)) +
              '</small></div></div>',
          )
          .join(''),
    );
  }
  // One click handler keeps navigation and demo buttons out of the HTML markup.
  document.addEventListener('click', (event) => {
    const scenarioButton = event.target.closest('[data-scenario]');
    if (scenarioButton) {
      setScenario(scenarioButton.dataset.scenario);
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action) {
      ({
        'connect-live': () => window.SitSyncConnection.connect(),
        'browser-preview': () => window.SitSyncConnection.preview(),
        'sample-statistics': showSampleStatistics,
        'python-demo': async () => {
          try {
            await window.SitSyncConnection.mode('demo');
            toast('Python demo enabled.');
          } catch (error) {
            toast(error.message);
          }
        },
        'python-live': async () => {
          try {
            await window.SitSyncConnection.mode('live');
            toast('Hardware mode enabled.');
          } catch (error) {
            toast(error.message);
          }
        },
        export: exportCSV,
        'export-json': exportSessionsJSON,
        break: showBreak,
        routine: showRoutine,
        privacy: showPrivacy,
        notifications: showNotifications,
        device: () => {
          location.hash = 'device';
        },
        haptic: () => {
          animateHaptic();
          notify(
            'Reminder preview',
            'BUZZ requests a 500 ms on/off pattern. Five continuous seconds away stop it.',
          );
          // The pattern controller reports whether this was a live command or a browser preview.
        },
      })[action]?.();
    }
    const chart = event.target.closest('[data-chart]');
    if (chart) {
      chartPeriod = chart.dataset.chart;
      document
        .querySelectorAll('[data-chart]')
        .forEach((b) => b.classList.toggle('active', b === chart));
      renderChart();
    }
    const filter = event.target.closest('[data-filter]');
    if (filter) {
      sessionFilter = filter.dataset.filter;
      document
        .querySelectorAll('[data-filter]')
        .forEach((b) => b.classList.toggle('active', b === filter));
      renderSessions();
    }
  });
  $('settingsForm').addEventListener('submit', (event) => {
    event.preventDefault();
    state.settings = {
      name: $('nameInput').value.trim(),
      reminderMs: Number($('intervalInput').value),
      goal: Number($('goalInput').value),
      reminders: $('reminderInput').checked,
    };
    // Saving a name or goal must not fire another pulse during the same sit.
    save();
    renderAll();
    toast('Your preferences are saved. Make yourself comfortable.');
  });
  $('closeDialog').onclick = closeDialog;
  $('appDialog').addEventListener('close', () => {
    clearInterval(routineTimer);
    routineTimer = null;
  });
  $('appDialog').addEventListener('click', (event) => {
    if (event.target === $('appDialog')) {
      const rect = $('appDialog').getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        closeDialog();
    }
  });
  $('dismissToast').onclick = () => $('toast').classList.remove('show');
  function calculatePastbi() {
    const activity = $('pastbiActivity').value;
    const sitting = $('pastbiSitting').value;
    const minutes = Number(activity),
      hours = Number(sitting);
    $('pastbiResult').textContent =
      activity === '' || sitting === ''
        ? 'Enter both daily totals to calculate your balance index.'
        : !Number.isFinite(minutes) ||
            !Number.isFinite(hours) ||
            minutes < 0 ||
            minutes > 1440 ||
            hours <= 0 ||
            hours > 24
          ? 'Use 0–1440 activity minutes and sitting time greater than 0, up to 24 hours.'
          : `PASTBI: ${(minutes / hours).toFixed(2)} (activity min/day ÷ sitting hours/day)`;
  }
  $('pastbiActivity').addEventListener('input', calculatePastbi);
  $('pastbiSitting').addEventListener('input', calculatePastbi);
  window.addEventListener('hashchange', route);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      renderAll();
    } else save();
  });
  $('weeklyChart').innerHTML = weekHTML();
  // Startup restores saved state, opens the requested view, then refreshes the
  // visible clock every second. Ten-second saves reduce unnecessary storage writes.
  reconcile();
  fillSettings();
  route();
  save();
  setInterval(() => {
    const closedBefore = state.active.end;
    updateTimer();
    if (closedBefore !== state.active.end) {
      renderOccupancy();
      renderStats();
      renderChart();
      renderSessions();
    }
    if (currentView === 'sessions') renderSessions();
  }, 1000);
  setInterval(updateMotorPreview, CONFIG.hardware.sampleIntervalMs);
  if (location.protocol === 'http:' || location.protocol === 'https:')
    window.SitSyncConnection.connect();
  setInterval(() => {
    renderChart();
    save();
  }, 10000);
})();
