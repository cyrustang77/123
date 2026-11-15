/**
 * Local Python connection. No fake fallback is used when a live request fails.
 * The dashboard is served by main.py, so all requests stay on the same origin.
 */
(() => {
  'use strict';
  let timer;
  let generation = 0;
  let enabled = false;
  let latest = null;
  // Live Server and file previews use the local Python API on port 8000.
  const apiBase = location.port === '8000' ? location.origin : 'http://127.0.0.1:8000';

  function announce(kind, data) {
    window.dispatchEvent(new CustomEvent('sitsync-connection', { detail: { kind, data } }));
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(apiBase + path, {
        cache: 'no-store',
        ...options,
        signal: controller.signal,
      });
      if (!response.ok) {
        let message = 'Python request failed (' + response.status + ')';
        try {
          message = (await response.json()).detail || message;
        } catch {}
        throw new Error(message);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function poll(version) {
    try {
      const data = await request('/data');
      if (
        !['Sitting', 'Standing', 'Paused (Break)'].includes(data.status) ||
        !Number.isFinite(data.raw_adc) ||
        !Number.isFinite(data.session_seconds)
      ) {
        throw new Error('The server did not return SitSync sensor data.');
      }
      if (enabled && version === generation) {
        latest = data;
        announce('data', data);
      }
    } catch (error) {
      if (enabled && version === generation) announce('error', error.message);
    } finally {
      if (enabled && version === generation) timer = setTimeout(() => poll(version), 250);
    }
  }

  window.SitSyncConnection = Object.freeze({
    connect() {
      clearTimeout(timer);
      enabled = true;
      generation += 1;
      announce('connecting');
      poll(generation);
    },
    preview() {
      enabled = false;
      generation += 1;
      clearTimeout(timer);
      announce('preview');
    },
    async mode(name) {
      if (!enabled) throw new Error('Connect to Python first.');
      if (latest && latest.status !== 'Standing')
        throw new Error('Finish the current session before changing modes.');
      return request('/mode/' + name, { method: 'POST' });
    },
    async buzz() {
      if (!enabled) throw new Error('Python is not connected.');
      return request('/buzz', { method: 'POST' });
    },
  });
})();
