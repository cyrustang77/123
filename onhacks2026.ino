// --- PIN DEFINITIONS ---
const int FSR_PIN = 36;     // VP on the ESP32 board (GPIO 36 / ADC1)
const int MOTOR_PIN = 2;    // D2 on the ESP32 board (GPIO 2)

// --- SETTINGS ---
const int PRESSURE_THRESHOLD = 500;           // Must match PRESSURE_THRESHOLD in main.py
const unsigned long REMINDER_MS = 20000;      // 20-second timer for hackathon demo (change to 1800000 for 30 mins)
const unsigned long BUZZ_DURATION_MS = 800;   // Length of the vibration pulse (0.8 seconds)

// --- STATE TRACKING ---
unsigned long sitStartTime = 0;
bool isSitting = false;
bool hasBuzzed = false;

void setup() {\
  Serial.begin(115200);
  pinMode(MOTOR_PIN, OUTPUT);
  digitalWrite(MOTOR_PIN, LOW); // Ensure motor starts in the OFF state
  delay(500);
}

void loop() {
  // 1. Read the analog voltage from the FSR voltage divider (returns 0 to 4095)
  int adcValue = analogRead(FSR_PIN);

  // 2. Output ONLY the raw integer so main.py's line.isdigit() reads it cleanly
  Serial.println(adcValue);

  // 3. Sit-timer and haptic reminder logic
  if (adcValue >= PRESSURE_THRESHOLD) {
    if (!isSitting) {
      // User just sat down
      isSitting = true;
      sitStartTime = millis();
      hasBuzzed = false;
    }

    // Trigger the vibration motor once when the interval threshold is reached
    if (!hasBuzzed && (millis() - sitStartTime >= REMINDER_MS)) {
      triggerHapticBuzz();
      hasBuzzed = true; // Prevents continuous buzzing; resets when you stand up
    }
  } else {
    // User stood up -> reset session timers and turn off motor
    isSitting = false;
    hasBuzzed = false;
    digitalWrite(MOTOR_PIN, LOW);
  }

  delay(250); // Sample 4 times per second for smooth graph tracking
}

void triggerHapticBuzz() {
  digitalWrite(MOTOR_PIN, HIGH);
  delay(BUZZ_DURATION_MS);
  digitalWrite(MOTOR_PIN, LOW);
}