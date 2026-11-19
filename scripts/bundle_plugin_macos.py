"""Build the Send plugin (crates/rm-send-plugin) and lay out macOS .clap + .vst3 bundles in
src-tauri/plugins/ so the app can install them (to ~/Library/Audio/Plug-Ins) and the .dmg ships them.

On macOS a CLAP and a VST3 are *bundle directories*:
    Name.clap/Contents/{MacOS/Name, Info.plist, PkgInfo}
    Name.vst3/Contents/{MacOS/Name, Info.plist, PkgInfo}
Both wrap the same cdylib (librm_send_plugin.dylib); the host loads Contents/MacOS/<CFBundleExecutable>.

  python3 -I -X utf8 scripts/bundle_plugin_macos.py [--no-build]
"""
import os, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CRATE = os.path.join(ROOT, "crates", "rm-send-plugin")
NAME = "ShowMeterBeat Send"
IDENT = "com.vatvivid.showmeterbeat.send"
VER = "0.1.0"
OUT = os.path.join(ROOT, "src-tauri", "plugins")

if sys.platform != "darwin":
    sys.exit("this script builds macOS bundles; run it on macOS (use bundle_plugin.py on Windows)")

if "--no-build" not in sys.argv:
    cargo = os.path.join(os.path.expanduser("~"), ".cargo", "bin", "cargo")
    if not os.path.exists(cargo):
        cargo = "cargo"
    subprocess.run([cargo, "build", "--release"], cwd=CRATE, check=True)

dylib = os.path.join(CRATE, "target", "release", "librm_send_plugin.dylib")
if not os.path.exists(dylib):
    sys.exit(f"missing {dylib}")


def plist(pkg_type):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>{NAME}</string>
  <key>CFBundleIdentifier</key><string>{IDENT}</string>
  <key>CFBundleName</key><string>{NAME}</string>
  <key>CFBundleDisplayName</key><string>{NAME}</string>
  <key>CFBundlePackageType</key><string>{pkg_type}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleVersion</key><string>{VER}</string>
  <key>CFBundleShortVersionString</key><string>{VER}</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
"""


def make_bundle(ext):
    bdir = os.path.join(OUT, f"{NAME}.{ext}")
    if os.path.exists(bdir):
        shutil.rmtree(bdir)
    macos = os.path.join(bdir, "Contents", "MacOS")
    os.makedirs(macos, exist_ok=True)
    shutil.copy2(dylib, os.path.join(macos, NAME))
    with open(os.path.join(bdir, "Contents", "Info.plist"), "w", encoding="utf-8") as f:
        f.write(plist("BNDL"))
    with open(os.path.join(bdir, "Contents", "PkgInfo"), "w", encoding="utf-8") as f:
        f.write("BNDL????")
    print("bundled:", bdir)


os.makedirs(OUT, exist_ok=True)
make_bundle("clap")
make_bundle("vst3")
print("done ->", OUT)
