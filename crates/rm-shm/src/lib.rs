//! Lock-free shared-memory bridge: DAW plugin instances (writers) → ShowMeterBeat app (reader).
//!
//! One named shared mapping holds `SLOTS` slots — a Win32 file mapping (`Local\re-minimeter-bridge-v1`)
//! on Windows, a POSIX shared-memory object (`/smb-bridge-v1`, shm_open + mmap) on macOS/Linux.
//! A plugin instance claims a slot whose heartbeat is stale, then every process() call writes
//! interleaved stereo f32 into the slot ring and bumps `write_pos` + `heartbeat`.
//! The app sums every live slot. Everything is plain atomics (x86-64 / arm64); no locks.
//!
//! Layout (bytes):
//!   0    u32 magic 0x484D5352 ("RSMH")   4 u32 version
//!   64   slot 0 … each slot = SLOT_HEADER + RING_FRAMES * 2 * 4
//! Slot header:
//!   0 AtomicU64 heartbeat_ms   8 AtomicU64 write_pos (frames, monotonic)
//!   16 AtomicU32 sample_rate   20 AtomicU32 channels  24 AtomicU32 pid  28.. reserved → 64

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
#[cfg(windows)]
use windows_sys::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_ALL_ACCESS, PAGE_READWRITE,
};

pub const MAGIC: u32 = 0x484D_5352;
pub const VERSION: u32 = 1;
pub const SLOTS: usize = 8;
pub const RING_FRAMES: usize = 32_768; // ~0.68 s at 48 kHz
pub const GLOBAL_HEADER: usize = 64;
pub const SLOT_HEADER: usize = 64;
pub const SLOT_BYTES: usize = SLOT_HEADER + RING_FRAMES * 2 * 4;
pub const TOTAL_BYTES: usize = GLOBAL_HEADER + SLOTS * SLOT_BYTES;
pub const STALE_MS: u64 = 1500;
#[cfg(windows)]
const NAME: &str = "Local\\re-minimeter-bridge-v1";
// POSIX shm names start with '/' and macOS caps them at 31 chars.
#[cfg(unix)]
const NAME: &str = "/smb-bridge-v1";

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct Mapping {
    #[cfg(windows)]
    handle: HANDLE,
    base: *mut u8,
}

unsafe impl Send for Mapping {}
unsafe impl Sync for Mapping {}

/// First opener of a fresh (zero-filled) mapping stamps the magic + version.
unsafe fn init_header(base: *mut u8) {
    let magic = &*(base as *const AtomicU32);
    let version = &*(base.add(4) as *const AtomicU32);
    if magic.load(Ordering::Acquire) != MAGIC {
        version.store(VERSION, Ordering::Release);
        magic.store(MAGIC, Ordering::Release);
    }
}

impl Mapping {
    /// Opens (or creates, zero-filled) the shared mapping.
    #[cfg(windows)]
    pub fn open() -> Result<Self, String> {
        let wide: Vec<u16> = NAME.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let handle = CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                std::ptr::null(),
                PAGE_READWRITE,
                0,
                TOTAL_BYTES as u32,
                wide.as_ptr(),
            );
            if handle.is_null() {
                return Err("CreateFileMappingW failed".into());
            }
            let view = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, TOTAL_BYTES);
            if view.Value.is_null() {
                CloseHandle(handle);
                return Err("MapViewOfFile failed".into());
            }
            let base = view.Value as *mut u8;
            init_header(base);
            Ok(Self { handle, base })
        }
    }

    /// Opens (or creates, zero-filled) the shared mapping — POSIX shared memory (macOS / Linux).
    #[cfg(unix)]
    pub fn open() -> Result<Self, String> {
        let cname = std::ffi::CString::new(NAME).map_err(|e| e.to_string())?;
        unsafe {
            let fd = libc::shm_open(cname.as_ptr(), libc::O_CREAT | libc::O_RDWR, 0o600 as libc::c_uint);
            if fd < 0 {
                return Err(format!("shm_open failed: {}", std::io::Error::last_os_error()));
            }
            // Size it only when it is new: on macOS ftruncate on an already-sized shm object fails with EINVAL.
            let mut st: libc::stat = std::mem::zeroed();
            if libc::fstat(fd, &mut st) != 0 {
                let e = std::io::Error::last_os_error();
                libc::close(fd);
                return Err(format!("fstat failed: {e}"));
            }
            if (st.st_size as u64) < TOTAL_BYTES as u64 && libc::ftruncate(fd, TOTAL_BYTES as libc::off_t) != 0 {
                let e = std::io::Error::last_os_error();
                libc::close(fd);
                return Err(format!("ftruncate failed: {e}"));
            }
            let p = libc::mmap(std::ptr::null_mut(), TOTAL_BYTES, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, fd, 0);
            libc::close(fd); // the mapping outlives the descriptor
            if p == libc::MAP_FAILED {
                return Err(format!("mmap failed: {}", std::io::Error::last_os_error()));
            }
            let base = p as *mut u8;
            init_header(base);
            Ok(Self { base })
        }
    }

    fn slot_ptr(&self, i: usize) -> *mut u8 {
        unsafe { self.base.add(GLOBAL_HEADER + i * SLOT_BYTES) }
    }

    pub fn slot(&self, i: usize) -> Slot<'_> {
        assert!(i < SLOTS);
        let p = self.slot_ptr(i);
        unsafe {
            Slot {
                heartbeat: &*(p as *const AtomicU64),
                write_pos: &*(p.add(8) as *const AtomicU64),
                sample_rate: &*(p.add(16) as *const AtomicU32),
                channels: &*(p.add(20) as *const AtomicU32),
                pid: &*(p.add(24) as *const AtomicU32),
                ring: p.add(SLOT_HEADER) as *mut f32,
            }
        }
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        unsafe {
            #[cfg(windows)]
            {
                UnmapViewOfFile(windows_sys::Win32::System::Memory::MEMORY_MAPPED_VIEW_ADDRESS { Value: self.base as _ });
                CloseHandle(self.handle);
            }
            // POSIX: unmap only — the object stays for the other process (no shm_unlink), as on Windows
            // where the mapping lives while any handle is open.
            #[cfg(unix)]
            {
                libc::munmap(self.base as *mut libc::c_void, TOTAL_BYTES);
            }
        }
    }
}

pub struct Slot<'a> {
    pub heartbeat: &'a AtomicU64,
    pub write_pos: &'a AtomicU64,
    pub sample_rate: &'a AtomicU32,
    pub channels: &'a AtomicU32,
    pub pid: &'a AtomicU32,
    ring: *mut f32,
}

impl Slot<'_> {
    pub fn is_live(&self, now: u64) -> bool {
        let hb = self.heartbeat.load(Ordering::Acquire);
        hb != 0 && now.saturating_sub(hb) < STALE_MS
    }

    /// Writer: append interleaved stereo frames.
    pub fn write(&self, interleaved: &[f32]) {
        let frames = interleaved.len() / 2;
        let mut wp = self.write_pos.load(Ordering::Relaxed) as usize;
        for f in 0..frames {
            let idx = (wp % RING_FRAMES) * 2;
            unsafe {
                *self.ring.add(idx) = interleaved[2 * f];
                *self.ring.add(idx + 1) = interleaved[2 * f + 1];
            }
            wp += 1;
        }
        self.write_pos.store(wp as u64, Ordering::Release);
        self.heartbeat.store(now_ms(), Ordering::Release);
    }

    /// Reader: copy frames `[from, to)` (absolute positions) into `out` (interleaved).
    pub fn read(&self, from: u64, to: u64, out: &mut Vec<f32>) {
        for p in from..to {
            let idx = ((p as usize) % RING_FRAMES) * 2;
            unsafe {
                out.push(*self.ring.add(idx));
                out.push(*self.ring.add(idx + 1));
            }
        }
    }
}

/// Plugin-side helper: claims a free slot and streams into it.
pub struct Writer {
    map: Mapping,
    slot: usize,
}

impl Writer {
    pub fn claim(sample_rate: u32) -> Result<Self, String> {
        let map = Mapping::open()?;
        let now = now_ms();
        let pid = std::process::id();
        let mut chosen = None;
        for i in 0..SLOTS {
            let s = map.slot(i);
            if !s.is_live(now) {
                chosen = Some(i);
                break;
            }
        }
        let slot = chosen.ok_or_else(|| format!("모든 슬롯({SLOTS})이 사용 중"))?;
        let s = map.slot(slot);
        s.sample_rate.store(sample_rate, Ordering::Release);
        s.channels.store(2, Ordering::Release);
        s.pid.store(pid, Ordering::Release);
        s.write_pos.store(0, Ordering::Release);
        s.heartbeat.store(now, Ordering::Release);
        Ok(Self { map, slot })
    }

    pub fn slot_index(&self) -> usize {
        self.slot
    }

    pub fn set_sample_rate(&self, sr: u32) {
        self.map.slot(self.slot).sample_rate.store(sr, Ordering::Release);
    }

    pub fn write(&self, interleaved: &[f32]) {
        self.map.slot(self.slot).write(interleaved);
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        // Release the slot immediately so a new instance can reuse it.
        self.map.slot(self.slot).heartbeat.store(0, Ordering::Release);
    }
}

/// App-side helper: sums every live slot, resampling each to `out_rate` (linear).
pub struct Reader {
    map: Mapping,
    read_pos: [u64; SLOTS],
    frac: [f64; SLOTS],
    last_frame: [[f32; 2]; SLOTS],
    scratch: Vec<f32>,
}

impl Reader {
    pub fn open() -> Result<Self, String> {
        Ok(Self { map: Mapping::open()?, read_pos: [0; SLOTS], frac: [0.0; SLOTS], last_frame: [[0.0; 2]; SLOTS], scratch: Vec::new() })
    }

    pub fn live_count(&self) -> usize {
        let now = now_ms();
        (0..SLOTS).filter(|&i| self.map.slot(i).is_live(now)).count()
    }

    /// Sample rate of the first live slot, if any.
    pub fn live_sample_rate(&self) -> Option<u32> {
        let now = now_ms();
        (0..SLOTS).map(|i| self.map.slot(i)).find(|s| s.is_live(now)).map(|s| s.sample_rate.load(Ordering::Acquire))
    }

    /// Pulls everything new from live slots, resampled to `out_rate`, summed into `out`
    /// (interleaved stereo, appended). Returns the number of frames appended.
    pub fn pull(&mut self, out_rate: u32, out: &mut Vec<f32>) -> usize {
        let now = now_ms();
        let start = out.len();
        let mut max_frames = 0usize;
        for i in 0..SLOTS {
            let s = self.map.slot(i);
            if !s.is_live(now) {
                self.read_pos[i] = 0;
                continue;
            }
            let wp = s.write_pos.load(Ordering::Acquire);
            if self.read_pos[i] == 0 || wp < self.read_pos[i] || wp - self.read_pos[i] > RING_FRAMES as u64 {
                // (re)sync: start a little behind the writer
                self.read_pos[i] = wp.saturating_sub((RING_FRAMES / 8) as u64);
            }
            if wp == self.read_pos[i] {
                continue;
            }
            self.scratch.clear();
            s.read(self.read_pos[i], wp, &mut self.scratch);
            self.read_pos[i] = wp;
            let in_rate = s.sample_rate.load(Ordering::Acquire).max(1) as f64;
            let step = in_rate / out_rate.max(1) as f64;
            // linear resample scratch (in_rate) → out (out_rate)
            let in_frames = self.scratch.len() / 2;
            let mut pos = self.frac[i];
            let mut n = 0usize;
            let prev = self.last_frame[i];
            while pos < in_frames as f64 {
                let k = pos.floor() as isize;
                let t = (pos - k as f64) as f32;
                let (a, b) = if k < 0 {
                    (prev, [self.scratch[0], self.scratch[1]])
                } else {
                    let k = k as usize;
                    let a = [self.scratch[2 * k], self.scratch[2 * k + 1]];
                    let b = if k + 1 < in_frames { [self.scratch[2 * k + 2], self.scratch[2 * k + 3]] } else { a };
                    (a, b)
                };
                let l = a[0] + (b[0] - a[0]) * t;
                let r = a[1] + (b[1] - a[1]) * t;
                let idx = start + 2 * n;
                if idx + 1 < out.len() {
                    out[idx] += l;
                    out[idx + 1] += r;
                } else {
                    out.push(l);
                    out.push(r);
                }
                n += 1;
                pos += step;
            }
            self.frac[i] = pos - in_frames as f64;
            self.last_frame[i] = [self.scratch[2 * in_frames - 2], self.scratch[2 * in_frames - 1]];
            max_frames = max_frames.max(n);
        }
        max_frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_reader_roundtrip_same_rate() {
        let w = Writer::claim(48_000).unwrap();
        let mut r = Reader::open().unwrap();
        // prime so the reader syncs
        w.write(&[0.0; 64]);
        let mut out = Vec::new();
        r.pull(48_000, &mut out);
        out.clear();
        let data: Vec<f32> = (0..200).map(|i| i as f32 * 0.01).collect();
        w.write(&data);
        let n = r.pull(48_000, &mut out);
        assert_eq!(n, 100);
        assert!((out[2] - 0.02).abs() < 1e-6 && (out[3] - 0.03).abs() < 1e-6);
        // Tests share one process-wide mapping and may run in parallel, so only check
        // that dropping this writer frees exactly one slot.
        let before = r.live_count();
        assert!(before >= 1);
        drop(w);
        assert_eq!(r.live_count(), before - 1);
    }

    #[test]
    fn resamples_44k_to_48k() {
        let w = Writer::claim(44_100).unwrap();
        let mut r = Reader::open().unwrap();
        w.write(&[0.0; 64]);
        let mut out = Vec::new();
        r.pull(48_000, &mut out);
        out.clear();
        w.write(&vec![0.5; 2 * 4410]);
        let n = r.pull(48_000, &mut out);
        assert!((n as i64 - 4800).abs() <= 2, "{n}");
        assert!(out.iter().all(|v| (v - 0.5).abs() < 1e-5));
    }
}
