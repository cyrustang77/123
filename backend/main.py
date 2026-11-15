import json
import os
import random
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import serial
from serial.tools import list_ports
import uvicorn

# --- CONFIGURATION ---
SERIAL_PORT = os.environ.get("SITSYNC_SERIAL_PORT", "").strip()  # Blank: discover USB board.
REMINDER_SEC = 30  # Thirty seconds; keep firmware REMINDER_MS in sync.
BAUD_RATE = 115200
PRESSURE_THRESHOLD = 2000      # Moisture-demo AO threshold; match Arduino SENSOR_THRESHOLD.
INTERRUPTION_BUFFER_SEC = 10   # 10s grace period for brief breaks (600 for 10 mins)
BASE_DIR = Path(__file__).resolve().parents[1]  # Project root, regardless of launch directory.
JSON_FILE = BASE_DIR / "moisture_sessions.json"  # Keep substitute-sensor runs out of sitting history.

# --- LIVE STATE ---
state = {
    "demo_mode": False,        # False = Real ESP32 Hardware | True = Simulated Demo
    "raw_adc": 0,
    "status": "Standing",
    "session_seconds": 0,
    "session_start": None,
    "start_timestamp": None,
    "away_since": None,
    "paused_seconds": 0,
    "continuous_start": None,
    "last_reading_at": None,
    "buzz_active": False,
    "buzz_started": None
}

last_printed_status = None
last_heartbeat = 0
serial_connection = None  # Shares the existing handle with the BUZZ endpoint.
serial_error = None
connected_port = None

def find_serial_port():
    """Choose a USB board, never an unrelated Bluetooth serial device."""
    if SERIAL_PORT:
        return SERIAL_PORT
    ports = list(list_ports.comports())
    usb = [port for port in ports if port.vid is not None
           or any(word in (port.device + " " + port.description).lower()
                  for word in ("usbserial", "usbmodem", "cp210", "ch340", "esp32"))]
    if len(usb) == 1:
        return usb[0].device
    if len(usb) > 1:
        raise RuntimeError("Multiple USB devices: set SITSYNC_SERIAL_PORT to "
                           + ", ".join(port.device for port in usb))
    raise RuntimeError("No USB serial board found. Connect the ESP32 and close Arduino Serial Monitor.")

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

def process_adc_reading(adc_val):
    """Core state machine + live terminal status output."""
    global last_printed_status, last_heartbeat
    state["raw_adc"] = adc_val
    now = time.time()
    state["last_reading_at"] = now

    # Close at the deadline, even if the next reading is already occupied.
    if (state["status"] == "Paused (Break)" and state["away_since"] is not None
            and now - state["away_since"] >= INTERRUPTION_BUFFER_SEC):
        log_session(state["session_start"], state["session_seconds"])
        state.update({"status": "Standing", "session_seconds": 0, "session_start": None,
                      "start_timestamp": None, "away_since": None, "continuous_start": None,
                      "paused_seconds": 0, "buzz_active": False})

    # AO is normally high when dry and falls with moisture. Calibrate on the actual module.
    if adc_val <= PRESSURE_THRESHOLD:
        # User is sitting
        # Keep a short break in the session without counting it as seated time.
        if state["status"] == "Paused (Break)":
            if now - state["away_since"] >= 5:
                state["buzz_active"] = False
            state["paused_seconds"] += now - state["away_since"]
            state["continuous_start"] = now
        state["away_since"] = None
        if state["status"] == "Standing":
            state["status"] = "Sitting"
            state["session_start"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            state["start_timestamp"] = now
            state["continuous_start"] = now
            state["paused_seconds"] = 0
        elif state["status"] == "Paused (Break)":
            state["status"] = "Sitting"

        state["session_seconds"] = int(now - state["start_timestamp"] - state["paused_seconds"])
        # Schedule on the serial-reading thread, even when the browser is closed.
        if now - state["continuous_start"] >= float(os.environ.get("SITSYNC_REMINDER_SECONDS", REMINDER_SEC)):
            try:
                request_buzz()
            except HTTPException as error:
                print(f"[MOTOR] {error.detail}")
    else:
        # No weight -> Handle interruption buffer
        if state["status"] == "Sitting":
            state["session_seconds"] = int(now - state["start_timestamp"] - state["paused_seconds"])
            state["continuous_start"] = None
            state["status"] = "Paused (Break)"
            state["away_since"] = now
        elif state["status"] == "Paused (Break)":
            # Match the Arduino's separate five-second motor-release rule.
            if now - state["away_since"] >= 5:
                state["buzz_active"] = False
            if now - state["away_since"] >= INTERRUPTION_BUFFER_SEC:
                log_session(state["session_start"], state["session_seconds"])
                state["status"] = "Standing"
                state["session_seconds"] = 0
                state["session_start"] = None
                state["start_timestamp"] = None
                state["away_since"] = None

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
    global serial_connection, serial_error, connected_port
    ser = None
    demo_cycle_start = time.time()

    while True:
        if state["demo_mode"]:
            if ser and ser.is_open:
                ser.close()
                ser = None
                serial_connection = None

            elapsed = (time.time() - demo_cycle_start) % 28
            fake_adc = random.randint(800, 1200) if elapsed < 15 else random.randint(3400, 3900)
            process_adc_reading(fake_adc)
            time.sleep(0.25)

        else:
            try:
                if ser is None or not ser.is_open:
                    port = find_serial_port()
                    ser = serial.Serial(port, BAUD_RATE, timeout=1, write_timeout=1)
                    serial_connection = ser
                    connected_port = port
                    serial_error = None
                    print(f"\n>>> Connected to ESP32 on {port} <<<\n")

                line = ser.readline().decode("utf-8", errors="ignore").strip()
                if line.isdigit() and 0 <= int(line) <= 4095:
                    process_adc_reading(int(line))

            except Exception as e:
                if ser:
                    try:
                        ser.close()
                    except Exception:
                        pass
                    ser = None
                serial_connection = None
                connected_port = None
                serial_error = str(e)
                print(f"[WAITING] Serial not ready ({e})... retrying in 2s")
                time.sleep(2)

# --- LIFESPAN STARTUP ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    thread = threading.Thread(target=sensor_loop, daemon=True)
    thread.start()
    yield

app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# --- API ENDPOINTS ---
@app.get("/")
def serve_dashboard():
    return FileResponse(BASE_DIR / "frontend" / "index.html")

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
        "history": history[-5:],
        "session_history": history,
        "sensor_kind": "moisture-demo",
        "sensor_threshold": PRESSURE_THRESHOLD,
        "sensor_active_low": True,
        "serial_port": connected_port,
        "serial_error": serial_error,
        "reminder_seconds": float(os.environ.get("SITSYNC_REMINDER_SECONDS", REMINDER_SEC)),
        "session_start": state["session_start"],
        "start_timestamp": state["start_timestamp"],
        "continuous_start": state["continuous_start"],
        "away_since": state["away_since"],
        "last_reading_at": state["last_reading_at"],
        "sensor_connected": (
            state["last_reading_at"] is not None
            and time.time() - state["last_reading_at"] < 3
            and (state["demo_mode"] or (serial_connection is not None and serial_connection.is_open))
        ),
        "buzz_active": state["buzz_active"],
        "buzz_started": state["buzz_started"],
        "server_timestamp": time.time()
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


@app.post("/buzz")
def request_buzz():
    """Send the existing Arduino command without changing the firmware."""
    if state["status"] != "Sitting":
        raise HTTPException(status_code=409, detail="The cushion must be occupied")
    if state["last_reading_at"] is None or time.time() - state["last_reading_at"] >= 3:
        raise HTTPException(status_code=503, detail="No recent sensor reading")
    if not state["buzz_active"]:
        if not state["demo_mode"]:
            if serial_connection is None or not serial_connection.is_open:
                raise HTTPException(status_code=503, detail="ESP32 is not connected")
            try:
                serial_connection.write(b"BUZZ\n")
                serial_connection.flush()
            except Exception as error:
                raise HTTPException(status_code=503, detail="Could not send BUZZ") from error
        state["buzz_active"] = True
        state["buzz_started"] = time.time()
    return {"buzz_active": state["buzz_active"], "demo_mode": state["demo_mode"]}

# Expose frontend assets only, not the session log or other project files.
app.mount("/", StaticFiles(directory=str(BASE_DIR / "frontend")), name="frontend")

# --- KEEP RUNNING INFINITELY WHEN CLICKING "RUN" IN VS CODE ---
if __name__ == "__main__":
    print("Starting SitSync server... Press Ctrl+C in terminal to stop.")
    uvicorn.run(app, host="127.0.0.1", port=8000)
