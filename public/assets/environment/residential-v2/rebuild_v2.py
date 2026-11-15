from pathlib import Path
import runpy
ROOT = Path(__file__).resolve().parent
runpy.run_path(str(ROOT / "build_assets_v2.py"), run_name="__main__")
runpy.run_path(str(ROOT / "refine_assets_v2.py"), run_name="__main__")
