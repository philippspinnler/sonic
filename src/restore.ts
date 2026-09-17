import * as ipc from "./ipc";
import type { ProjectRecord } from "./ipc";

/** Rebuild one project: its first Claude terminal comes with the project (resumed),
 *  every other terminal is added after it. Shells come back fresh. */
async function restoreProject(r: ProjectRecord): Promise<void> {
  const first = r.terminals.find(t => t.kind === "claude");
  const { projectId, terminalId } = await ipc.newProject(r.profile_id, r.cwd, r.name, first?.claude_session_id ?? null);
  if (first?.name) await ipc.renameTerminal(terminalId, first.name);
  for (const t of r.terminals) {
    if (t === first) continue;
    const id = await ipc.addTerminal(projectId, t.kind, t.kind === "claude" ? t.claude_session_id : null);
    if (t.name) await ipc.renameTerminal(id, t.name);
  }
}

async function restoreAll(records: ProjectRecord[]): Promise<void> {
  for (const r of records) {
    try {
      await restoreProject(r);
    } catch (e) {
      console.error("restore failed", r, e);
    }
  }
}

export async function maybeRestore(): Promise<void> {
  const prev = await ipc.previousProjects();
  if (prev.length === 0) return;
  // after an update-and-restart, bring everything back without asking
  if (await ipc.autoRestore()) {
    await restoreAll(prev);
    await ipc.discardPrevious();
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "dialog";
  box.innerHTML = `<h2>Restore previous projects?</h2><div id="restore-rows"></div>
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
    const n = r.terminals.length;
    text.textContent = `${r.name} — ${r.cwd}` + (n > 1 ? ` (${n} terminals)` : "");
    row.append(cb, text);
    rows.appendChild(row);
  }
  const done = async (restore: boolean): Promise<void> => {
    if (restore) await restoreAll(prev.filter(r => checks.get(r.id)!.checked));
    await ipc.discardPrevious();
    overlay.remove();
  };
  box.querySelector("#r-yes")!.addEventListener("click", () => void done(true));
  box.querySelector("#r-no")!.addEventListener("click", () => void done(false));
}
