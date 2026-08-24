import { getState, setSessions, setStatus, select, subscribe } from "./store";
import { renderSidebar } from "./sidebar";
import { ensureTerminal, writeData, showTerminal, disposeTerminal } from "./terminals";
import * as ipc from "./ipc";
import type { SessionView } from "./store";
import { openNewSessionDialog } from "./newSession";
import { openSettings } from "./settings";
import { initNotifications } from "./notify";
import { ask } from "@tauri-apps/plugin-dialog";

async function closeSelected(): Promise<void> {
  const { sessions, selectedId } = getState();
  const s = sessions.find(x => x.id === selectedId);
  if (!s) return;
  if (s.status === "working") {
    const yes = await ask(`"${s.name}" is still working. Close it anyway?`, { title: "Close session" });
    if (!yes) return;
  }
  await ipc.closeSession(s.id);
}

window.addEventListener("sonic:new-session", () => void openNewSessionDialog());
window.addEventListener("sonic:settings", () => void openSettings());

let knownIds = new Set<string>();

async function refresh(sessions?: SessionView[]): Promise<void> {
  const list = sessions ?? (await ipc.listSessions());
  const ids = new Set<string>(list.map(s => s.id));
  for (const id of knownIds) if (!ids.has(id)) disposeTerminal(id);
  for (const id of ids) ensureTerminal(id);
  knownIds = ids;
  setSessions(list);
}

subscribe(() => showTerminal(getState().selectedId));

async function boot(): Promise<void> {
  await ipc.onSessionsChanged(s => void refresh(s));
  await ipc.onSessionData((id, b64) => writeData(id, b64));
  await ipc.onSessionStatus((id, status) => setStatus(id, status));
  await ipc.onMenu(id => {
    if (id === "new-session") void openNewSessionDialog();
    else if (id === "close-session") void closeSelected();
    else if (id === "settings") window.dispatchEvent(new CustomEvent("sonic:settings"));
  });
  await initNotifications();
  await refresh();
  renderSidebar();
}

window.addEventListener("keydown", e => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (/^[1-9]$/.test(e.key)) {
    const s = getState().sessions[+e.key - 1];
    if (s) {
      select(s.id);
      e.preventDefault();
    }
  }
});

void boot();
