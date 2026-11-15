
 // --- PIN DEFINITIONS ---
const int FSR_PIN = 36;
const int MOTOR_PIN = 2;

// --- SETTINGS ---
const int PRESSURE_THRESHOLD = 500;
const unsigned long SAMPLE_INTERVAL_MS = 250;
const unsigned long VIBRATE_MS = 500;
const unsigned long REST_MS = 500;
const unsigned long BREAK_DURATION_MS = 5000;

// --- STATE TRACKING ---
unsigned long lastSampleTime = 0;
unsigned long lastMotorToggle = 0;
unsigned long belowThresholdStart = 0;

bool vibrationActive = false;
bool motorOn = false;
bool belowThresholdTiming = false;

String commandBuffer = "";

void setup() {
  Serial.begin(115200);

  pinMode(MOTOR_PIN, OUTPUT);
  digitalWrite(MOTOR_PIN, LOW);

  delay(500);
}

void loop() {
  unsigned long now = millis();

  // 1. READ PRESSURE SENSOR
  static int pressure = 0;

  if (now - lastSampleTime >= SAMPLE_INTERVAL_MS) {
    lastSampleTime = now;

    pressure = analogRead(FSR_PIN);

    // Send pressure to Python
    Serial.println(pressure);
  }

  // 2. RECEIVE COMMANDS FROM PYTHON
  while (Serial.available() > 0) {
    char incoming = Serial.read();

    if (incoming == '\n') {
      commandBuffer.trim();

      if (commandBuffer == "BUZZ" && !vibrationActive) {
        vibrationActive = true;
        motorOn = true;

        digitalWrite(MOTOR_PIN, HIGH);
        lastMotorToggle = now;
      }

      commandBuffer = "";
    }
    else if (incoming != '\r') {
      commandBuffer += incoming;
    }
  }

  // 3. DETECT WHEN USER STANDS UP
  if (pressure < PRESSURE_THRESHOLD) {

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
