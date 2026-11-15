window.SITSYNC_CONFIG = Object.freeze({
  // Match the supplied ESP32 firmware. These are not live hardware controls.
  hardware: Object.freeze({
    fsrPin: 36,
    motorPin: 2,
    adcMax: 4095,
    pressureThreshold: 2000,
    activeLow: true,
    sensorKind: 'moisture-demo',
    serialBaud: 115200,
    sampleIntervalMs: 250,
    command: 'BUZZ',
    vibrateMs: 500,
    restMs: 500,
    breakDurationMs: 5000,
  }),

  // Python's logging rules, independent of the Arduino reminder timer.
  session: Object.freeze({
    interruptionBufferMs: 10000,
    minimumSavedMs: 3000,
  }),

  // Readings are inside the ranges used by the Python demo.
  demo: Object.freeze({
    seatedAdc: 1000,
    awayAdc: 3800,
  }),
  // Preview intervals only. Connected mode displays Python's reminder interval.
  preview: Object.freeze({
    reminderMs: 30000,
    everydayReminderMs: 1800000,
  }),
});
