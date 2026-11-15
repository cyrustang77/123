"""Exercise the USB-to-API path without a physical board or session-log writes."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location("sitsync", Path(__file__).resolve().parents[1] / "backend" / "main.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class IntegrationTests(TestCase):
    def test_serial_readings_reach_api_and_trigger_motor_without_browser(self):
        initial = server.state.copy()
        board = Mock(is_open=True)
        clock = [1000.0]
        readings = iter([(1000, b"1000\n"), (1029, b"1100\n"), (1030, b"1200\n")])

        def read():
            try:
                at, value = next(readings)
            except StopIteration:
                raise KeyboardInterrupt  # Stop the otherwise infinite sensor thread.
            clock[0] = at
            if at <= 1030:
                board.write.assert_not_called()
            return value

        board.readline.side_effect = read
        try:
            with patch.object(server, "SERIAL_PORT", "TEST"), \
                 patch.object(server.serial, "Serial", return_value=board), \
                 patch.object(server.time, "time", side_effect=lambda: clock[0]), \
                 patch.dict(server.os.environ, {"SITSYNC_REMINDER_SECONDS": "30"}):
                with self.assertRaises(KeyboardInterrupt):
                    server.sensor_loop()
                client = TestClient(server.app)  # No context: do not start a real sensor thread.
                data = client.get("/data").json()
                self.assertEqual(data["status"], "Sitting")
                self.assertEqual(data["raw_adc"], 1200)
                self.assertEqual(data["session_seconds"], 30)
                self.assertTrue(data["sensor_connected"])
                board.write.assert_called_once_with(b"BUZZ\n")
                client.post("/buzz")
                board.write.assert_called_once()  # A browser request cannot restart the pattern.
                self.assertEqual(client.get("/").status_code, 200)
                self.assertEqual(client.get("/connection.js").status_code, 200)
                response = client.get("/data", headers={"Origin": "http://127.0.0.1:5500"})
                self.assertEqual(response.headers["access-control-allow-origin"], "http://127.0.0.1:5500")
                clock[0] = 1031
                server.process_adc_reading(3800)
                self.assertEqual(server.state['status'], 'Paused (Break)')
                clock[0] = 1036
                server.process_adc_reading(3800)
                self.assertFalse(server.state['buzz_active'])
        finally:
            server.state.update(initial)
            server.serial_connection = None

    def test_discovery_ignores_bluetooth_and_requires_an_unambiguous_usb_board(self):
        bluetooth = SimpleNamespace(device="/dev/cu.Bluetooth", description="Bluetooth", vid=None)
        board = SimpleNamespace(device="/dev/cu.usbserial", description="CP2102", vid=0x10C4)
        with patch.object(server, "SERIAL_PORT", ""), patch.object(server.list_ports, "comports") as ports:
            ports.return_value = [bluetooth, board]
            self.assertEqual(server.find_serial_port(), board.device)
            ports.return_value = [bluetooth]
            with self.assertRaisesRegex(RuntimeError, "No USB"):
                server.find_serial_port()
            ports.return_value = [board, board]
            with self.assertRaisesRegex(RuntimeError, "Multiple USB"):
                server.find_serial_port()


if __name__ == "__main__":
    main()
