#!/usr/bin/env bash
# Build ShowMeterBeat.app / .dmg on macOS (Apple Silicon or Intel — the arch is auto-detected).
#
#   git clone -b mac-port https://github.com/VATvivid/ShowMeterBeat.git
#   cd ShowMeterBeat
#   bash scripts/build_macos.sh
#
# Prereqs: Xcode Command Line Tools (`xcode-select --install`), Rust (https://rustup.rs),
# Node 18+ and Python 3. cmake is installed automatically (Homebrew or pip) if missing.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> ShowMeterBeat macOS build  ($(uname -m))"

need() { command -v "$1" >/dev/null 2>&1; }

# --- toolchain checks -----------------------------------------------------------
if ! xcode-select -p >/dev/null 2>&1; then
  echo "!! Xcode Command Line Tools missing. Run:  xcode-select --install   then re-run this script."; exit 1
fi
need rustc   || { echo "!! Rust missing. Install:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"; exit 1; }
need node    || { echo "!! Node missing. Install:  brew install node   (or https://nodejs.org)"; exit 1; }
need npm     || { echo "!! npm missing (comes with Node)."; exit 1; }
need python3 || { echo "!! Python 3 missing. Install:  brew install python"; exit 1; }

# --- cmake (whisper.cpp build) --------------------------------------------------
if ! need cmake; then
  echo "==> cmake missing — installing"
  if need brew; then brew install cmake
  else python3 -m pip install --user cmake && export PATH="$(python3 -c 'import cmake,os;print(os.path.join(os.path.dirname(cmake.__file__),"data","bin"))'):$PATH"
  fi
fi
echo "    rustc  $(rustc --version)"
echo "    node   $(node --version)"
echo "    cmake  $(cmake --version | head -1)"

# --- models (onnxruntime dylib for this arch + whisper base/small + yamnet/nmp) --
echo "==> Fetching AI models into src-tauri/models (one-time, a few hundred MB)"
python3 -I -X utf8 scripts/fetch_models.py --whisper base
python3 -I -X utf8 scripts/fetch_models.py --whisper small

# --- frontend deps --------------------------------------------------------------
echo "==> npm install"
npm install

# --- build ----------------------------------------------------------------------
echo "==> tauri build (first run compiles whisper.cpp — this takes a while)"
npx tauri build --config src-tauri/tauri.macos.conf.json

echo
echo "==> Build complete. Artifacts:"
ls -la  src-tauri/target/release/bundle/dmg/*.dmg   2>/dev/null || echo "   (no .dmg — check the log above)"
ls -ld  src-tauri/target/release/bundle/macos/*.app 2>/dev/null || true
echo
echo "This build is unsigned, so Gatekeeper will warn on first open. To run it:"
echo "   • right-click the app → Open → Open,  OR"
echo "   • xattr -dr com.apple.quarantine 'src-tauri/target/release/bundle/macos/ShowMeterBeat.app'"
echo
echo "Note (first macOS build): docking and system-audio loopback are not available yet;"
echo "use an input device or a virtual audio device (e.g. BlackHole) as the capture source."
