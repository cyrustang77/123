
 // --- PIN DEFINITIONS ---
const int SENSOR_PIN = 36; // Moisture module AO, powered from 3.3 V; common ground.
const int MOTOR_PIN = 2;

// --- SETTINGS ---
const int SENSOR_THRESHOLD = 2000; // Starting point only: calibrate dry versus damp AO.
const unsigned long SAMPLE_INTERVAL_MS = 250;
const unsigned long VIBRATE_MS = 500;
const unsigned long REST_MS = 500;
const unsigned long BREAK_DURATION_MS = 5000;
const unsigned long REMINDER_MS = 30000; // 30 seconds continuously seated.

// --- STATE TRACKING ---
unsigned long lastSampleTime = 0;
unsigned long lastMotorToggle = 0;
unsigned long belowThresholdStart = 0;
unsigned long sittingStart = 0;
bool sittingTiming = false;

bool vibrationActive = false;
bool motorOn = false;
bool belowThresholdTiming = false;

String commandBuffer = "";

void startVibration(unsigned long now) {
  if (vibrationActive) return;
  vibrationActive = true;
  motorOn = true;
  lastMotorToggle = now;
  digitalWrite(MOTOR_PIN, HIGH);
}

void setup() {
  Serial.begin(115200);

  pinMode(MOTOR_PIN, OUTPUT);
  digitalWrite(MOTOR_PIN, LOW);

  delay(500);
}

void loop() {
  unsigned long now = millis();

  // 1. READ ANALOG SENSOR (dry usually high, moisture usually low).
  static int pressure = 4095; // Start inactive until the first sample.

  if (now - lastSampleTime >= SAMPLE_INTERVAL_MS) {
    lastSampleTime = now;

    pressure = analogRead(SENSOR_PIN);

    // Send pressure to Python
    Serial.println(pressure);
  }

  // 2. RECEIVE COMMANDS FROM PYTHON
  while (Serial.available() > 0) {
    char incoming = Serial.read();

    if (incoming == '\n') {
      commandBuffer.trim();

      if (commandBuffer == "BUZZ" && pressure <= SENSOR_THRESHOLD) {
        startVibration(now);
      }

      commandBuffer = "";
    }
    else if (incoming != '\r' && commandBuffer.length() < 32) {
      commandBuffer += incoming;
    }
  }

  // 3. An inactive (dry) plate resets the activation timer.
  if (pressure > SENSOR_THRESHOLD) {
    sittingTiming = false; // The reminder counts uninterrupted sitting.

    if (!belowThresholdTiming) {
      belowThresholdTiming = true;
      belowThresholdStart = now;
    }

    // Stop vibration after 5 continuous seconds
    if (vibrationActive &&
        now - belowThresholdStart >= BREAK_DURATION_MS) {

      vibrationActive = false;
      motorOn = false;

      digitalWrite(MOTOR_PIN, LOW);
    }

  } else {
    // User sat down again; reset break timer
    belowThresholdTiming = false;
    if (!sittingTiming) {
      sittingTiming = true;
      sittingStart = now;
    }
    // The board can remind on its own; Python BUZZ remains supported.
    if (now - sittingStart >= REMINDER_MS) {
      startVibration(now);
    }
  }

  // 4. REPEATING VIBRATION PATTERN
  if (vibrationActive) {

    unsigned long interval = motorOn ? VIBRATE_MS : REST_MS;

    if (now - lastMotorToggle >= interval) {

      motorOn = !motorOn;

      digitalWrite(MOTOR_PIN, motorOn ? HIGH : LOW);

      lastMotorToggle = now;
    }
  }
}
