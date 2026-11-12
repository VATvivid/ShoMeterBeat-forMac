// Status-bar notices ("저장됨: …"). The main window has the status bar; a pop-out
// shows the notice as a short toast instead.

let holdUntil = 0;
let toastTimer: number | undefined;

export function notice(text: string, cls: "" | "ok" | "err" = "", holdMs = 4000) {
  const el = document.getElementById("st-state");
  if (el) {
    el.textContent = text;
    el.className = cls;
    holdUntil = performance.now() + holdMs;
    return;
  }
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = text;
  t.className = `show ${cls}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove("show"), holdMs);
}

/** True while a notice should stay visible (the status poll doesn't overwrite it). */
export function noticeHeld() { return performance.now() < holdUntil; }
