import json
import random
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime
from fastapi import FastAPI
from fastapi.responses import FileResponse
import serial
import uvicorn

# --- CONFIGURATION ---
SERIAL_PORT = "COM3"           # Match your Windows COM port in Device Manager
BAUD_RATE = 115200
PRESSURE_THRESHOLD = 500       # Must match threshold in Arduino code
INTERRUPTION_BUFFER_SEC = 10   # 10s grace period for brief breaks (600 for 10 mins)
JSON_FILE = "sessions.json"
REMINDER_INTERVAL_SEC = 30

# --- LIVE STATE ---
state = {
    "demo_mode": False,        # False = Real ESP32 Hardware | True = Simulated Demo
    "raw_adc": 0,
    "status": "Standing",
    "session_seconds": 0,
    "session_start": None,
    "start_timestamp": None,
    "away_since": None
    "reminder_sent": False,
}

last_printed_status = None
last_heartbeat = 0

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
    print(f"[SAVED] Logged {duration_sec}s session to {JSON_FILE}")

def process_adc_reading(adc_val, ser=None):
    """Core state machine + live terminal status output."""
    global last_printed_status, last_heartbeat
    state["raw_adc"] = adc_val
    now = time.time()

    if adc_val >= PRESSURE_THRESHOLD:
        # User is sitting
        state["away_since"] = None
        if state["status"] == "Standing":
            state["status"] = "Sitting"
            state["session_start"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            state["start_timestamp"] = now
            state["reminder_sent"] = False
        elif state["status"] == "Paused (Break)":
            state["status"] = "Sitting"

        state["session_seconds"] = int(now - state["start_timestamp"])
        # Send reminder once after 30 seconds
        if (state["session_seconds"] >= REMINDER_INTERVAL_SEC
                and not state["reminder_sent"]
                and ser is not None
                and ser.is_open):
        
            ser.write(b"BUZZ\n")
            ser.flush()
        
            state["reminder_sent"] = True
            print("[REMINDER] BUZZ command sent to ESP32!")
    else:
        # No weight -> Handle interruption buffer
        if state["status"] == "Sitting":
            state["status"] = "Paused (Break)"
            state["away_since"] = now
        elif state["status"] == "Paused (Break)":
            if now - state["away_since"] >= INTERRUPTION_BUFFER_SEC:
                log_session(state["session_start"], state["session_seconds"])
                state["status"] = "Standing"
                state["session_seconds"] = 0
                state["session_start"] = None
                state["start_timestamp"] = None
                state["away_since"] = None
                state["reminder_sent"] = False

    # --- LIVE VS CODE TERMINAL OUTPUT ---
    # Prints immediately on state change, plus a heartbeat every 2 seconds
    if state["status"] != last_printed_status or (now - last_heartbeat >= 2.0):
        timestamp = datetime.now().strftime("%H:%M:%S")
        if state["status"] == "Sitting":
            print(f"[{timestamp}] SITTING     | ADC: {adc_val:4d} | Timer: {state['session_seconds']}s")
        elif state["status"] == "Paused (Break)":
            away_elapsed = int(now - state["away_since"])
            print(f"[{timestamp}] PAUSED      | ADC: {adc_val:4d} | Break: {away_elapsed}s / {INTERRUPTION_BUFFER_SEC}s")
        else:
            print(f"[{timestamp}] NOT SITTING | ADC: {adc_val:4d}")

        last_printed_status = state["status"]
        last_heartbeat = now

def sensor_loop():
    """Infinite background loop reading from ESP32 USB Serial or Demo Mode."""
    ser = None
    demo_cycle_start = time.time()

    while True:
        if state["demo_mode"]:
            if ser and ser.is_open:
                ser.close()
                ser = None

            elapsed = (time.time() - demo_cycle_start) % 28
            fake_adc = random.randint(2200, 2600) if elapsed < 15 else random.randint(0, 30)
            process_adc_reading(fake_adc, None)
            time.sleep(0.25)

        else:
            try:
                if ser is None or not ser.is_open:
                    ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
                    print(f"\n>>> Connected to ESP32 on {SERIAL_PORT} <<<\n")

                line = ser.readline().decode("utf-8", errors="ignore").strip()
                if line.isdigit():
                    process_adc_reading(int(line), ser)

            except Exception as e:
                if ser:
                    try:
                        ser.close()
                    except Exception:
                        pass
                    ser = None
                print(f"[WAITING] Serial not ready ({e})... retrying in 2s")
                time.sleep(2)

# --- LIFESPAN STARTUP ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    thread = threading.Thread(target=sensor_loop, daemon=True)
    thread.start()
    yield

app = FastAPI(lifespan=lifespan)

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
        "demo_mode": state["demo_mode"],
        "raw_adc": state["raw_adc"],
        "status": state["status"],
        "session_seconds": state["session_seconds"],
        "history": history[-5:]
    }

@app.post("/mode/{mode_name}")
def set_mode(mode_name: str):
    if mode_name.lower() == "demo":
        state["demo_mode"] = True
        print("\n>>> Switched to DEMO MODE <<<\n")
    elif mode_name.lower() == "live":
        state["demo_mode"] = False
        print("\n>>> Switched to LIVE HARDWARE MODE <<<\n")
    return {"demo_mode": state["demo_mode"]}

# --- KEEP RUNNING INFINITELY WHEN CLICKING "RUN" IN VS CODE ---
if __name__ == "__main__":
    print("Starting Sitting Strava server... Press Ctrl+C in terminal to stop.")
    uvicorn.run(app, host="127.0.0.1", port=8000)
