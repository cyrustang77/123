"""Convenience entry point. The application lives in backend/main.py."""
import runpy
from pathlib import Path

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).resolve().parent / "backend" / "main.py"), run_name="__main__")
