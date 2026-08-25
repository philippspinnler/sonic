import * as ipc from "./ipc";

export async function maybeRestore(): Promise<void> {
  const prev = await ipc.previousSessions();
  if (prev.length === 0) return;
  // after an update-and-restart, bring everything back without asking
  if (await ipc.autoRestore()) {
    for (const r of prev) {
      try {
        await ipc.startSession(r.profile_id, r.cwd, r.claude_session_id, r.name);
      } catch (e) {
        console.error("restore failed", r, e);
      }
    }
    await ipc.discardPrevious();
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "dialog";
  box.innerHTML = `<h2>Restore previous sessions?</h2><div id="restore-rows"></div>
    <div class="btn-row"><button id="r-yes">Restore selected</button><button id="r-no">Discard</button></div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const rows = box.querySelector("#restore-rows")!;
  const checks = new Map<string, HTMLInputElement>();
  for (const r of prev) {
    const row = document.createElement("label");
    row.className = "field row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    checks.set(r.id, cb);
    const text = document.createElement("span");
    text.textContent = `${r.name} — ${r.cwd}`;
    row.append(cb, text);
    rows.appendChild(row);
  }
  const done = async (restore: boolean): Promise<void> => {
    if (restore) {
      for (const r of prev) {
        if (!checks.get(r.id)!.checked) continue;
        try {
          await ipc.startSession(r.profile_id, r.cwd, r.claude_session_id, r.name);
        } catch (e) {
          console.error("restore failed", r, e);
        }
      }
    }
    await ipc.discardPrevious();
    overlay.remove();
  };
  box.querySelector("#r-yes")!.addEventListener("click", () => void done(true));
  box.querySelector("#r-no")!.addEventListener("click", () => void done(false));
}
