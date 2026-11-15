import json
import threading
import time
from datetime import datetime
from fastapi import FastAPI
from fastapi.responses import FileResponse
import serial

app = FastAPI()

# --- CONFIGURATION ---
SERIAL_PORT = "COM3"           # Match this to your Windows COM port (e.g., COM3, COM4)
BAUD_RATE = 115200
PRESSURE_THRESHOLD = 500       # Must match threshold in Arduino code
INTERRUPTION_BUFFER_SEC = 10   # 10s grace period for brief breaks (change to 600 for 10 mins)
JSON_FILE = "sessions.json"

# --- LIVE STATE ---
state = {
    "raw_adc": 0,
    "status": "Standing",
    "session_seconds": 0,
    "session_start": None,
    "start_timestamp": None,
    "away_since": None
}

def log_session(start_time, duration_sec):
    """Appends a completed sitting session to sessions.json."""
    if duration_sec < 3:  # Ignore accidental 1-2 second bumps
        return
    try:
        with open(JSON_FILE, "r") as f:
            sessions = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        sessions = []

    sessions.append({
        "start_time": start_time,
        "end_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "duration_seconds": duration_sec
    })

    with open(JSON_FILE, "w") as f:
        json.dump(sessions, f, indent=2)

def read_serial_loop():
    """Background thread that continuously listens to the ESP32 over USB Serial."""
    while True:
        try:
            ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
            print(f"Connected to ESP32 on {SERIAL_PORT}")

            while True:
                line = ser.readline().decode("utf-8").strip()
                if line.isdigit():
                    adc_val = int(line)
                    state["raw_adc"] = adc_val
                    now = time.time()

                    if adc_val >= PRESSURE_THRESHOLD:
                        # User is sitting
                        state["away_since"] = None
                        if state["status"] == "Standing":
                            state["status"] = "Sitting"
                            state["session_start"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                            state["start_timestamp"] = now
                        elif state["status"] == "Paused (Break)":
                            state["status"] = "Sitting"

                        state["session_seconds"] = int(now - state["start_timestamp"])
                    else:
                        # No weight -> Handle interruption buffer
                        if state["status"] == "Sitting":
                            state["status"] = "Paused (Break)"
                            state["away_since"] = now
                        elif state["status"] == "Paused (Break)":
                            if now - state["away_since"] >= INTERRUPTION_BUFFER_SEC:
                                # Break exceeded buffer -> Save session and reset
                                log_session(state["session_start"], state["session_seconds"])
                                state["status"] = "Standing"
                                state["session_seconds"] = 0
                                state["session_start"] = None
                                state["start_timestamp"] = None
                                state["away_since"] = None

        except Exception as e:
            # Safely waits and retries if the ESP32 is unplugged or COM port is busy
            print(f"Serial waiting ({e})... retrying in 2s")
            time.sleep(2)

# Automatically launch the serial listener in a background thread when FastAPI starts
@app.on_event("startup")
def start_serial_thread():
    thread = threading.Thread(target=read_serial_loop, daemon=True)
    thread.start()

# --- API ENDPOINTS ---
@app.get("/")
def serve_dashboard():
    return FileResponse("index.html")

@app.get("/data")
def get_live_data():
    try:
        with open(JSON_FILE, "r") as f:
            history = json.load(f)
    except Exception:
        history = []

    return {
        "raw_adc": state["raw_adc"],
        "status": state["status"],
        "session_seconds": state["session_seconds"],
        "history": history[-5:]
    }