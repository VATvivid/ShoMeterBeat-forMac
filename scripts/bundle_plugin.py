"""Build the Send plugin (crates/rm-send-plugin) and lay out CLAP + VST3 bundles in
src-tauri/plugins/ so the app can install them and the NSIS installer ships them.

Usage: python -I -X utf8 scripts/bundle_plugin.py [--no-build]
"""
import os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CRATE = os.path.join(ROOT, "crates", "rm-send-plugin")
NAME = "re-minimeter Send"
OUT = os.path.join(ROOT, "src-tauri", "plugins")

if "--no-build" not in sys.argv:
    cargo = os.path.join(os.path.expanduser("~"), ".cargo", "bin", "cargo.exe")
    if not os.path.exists(cargo):
        cargo = "cargo"
    subprocess.run([cargo, "build", "--release"], cwd=CRATE, check=True)

dll = os.path.join(CRATE, "target", "release", "rm_send_plugin.dll")
if not os.path.exists(dll):
    sys.exit(f"missing {dll}")

os.makedirs(OUT, exist_ok=True)
clap = os.path.join(OUT, f"{NAME}.clap")
shutil.copy2(dll, clap)
vst_dir = os.path.join(OUT, f"{NAME}.vst3", "Contents", "x86_64-win")
os.makedirs(vst_dir, exist_ok=True)
shutil.copy2(dll, os.path.join(vst_dir, f"{NAME}.vst3"))
print("bundled:", clap)
print("bundled:", os.path.join(OUT, f"{NAME}.vst3"))
