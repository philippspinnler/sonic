import { getState, setSessions, setStatus, select, subscribe } from "./store";
import { renderSidebar } from "./sidebar";
import { ensureTerminal, writeData, showTerminal, disposeTerminal, openSearch, setFontSize } from "./terminals";
import * as ipc from "./ipc";
import type { SessionView } from "./store";
import { openNewSessionDialog } from "./newSession";
import { openSettings } from "./settings";
import { initNotifications } from "./notify";
import { maybeRestore } from "./restore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { closeSessionWithConfirm } from "./actions";
import { initSidebarResizer } from "./layout";
import { initEmptyState } from "./emptyState";
import { ask } from "@tauri-apps/plugin-dialog";

async function closeSelected(): Promise<void> {
  const { sessions, selectedId } = getState();
  const s = sessions.find(x => x.id === selectedId);
  if (s) await closeSessionWithConfirm(s);
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
  setFontSize((await ipc.getSettings()).font_size);
  window.addEventListener("sonic:font-size", e => setFontSize((e as CustomEvent<number>).detail));
  initSidebarResizer();
  initEmptyState();
  await refresh();
  renderSidebar();

  const bin = await ipc.checkClaude();
  if (!bin) {
    const banner = document.createElement("div");
    banner.className = "banner";
    banner.textContent =
      "claude not found in your login shell PATH — set the binary path in Settings (⌘,)";
    document.body.prepend(banner);
  }

  await maybeRestore();

  await getCurrentWindow().onCloseRequested(async e => {
    const working = getState().sessions.filter(s => s.status === "working");
    if (working.length > 0) {
      const yes = await ask(
        `${working.length} session(s) are still working. Quit anyway? (They can be resumed on next launch.)`,
        { title: "Quit Sonic" },
      );
      if (!yes) e.preventDefault();
    }
  });
}

window.addEventListener("keydown", e => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === "f") {
    openSearch();
    e.preventDefault();
    return;
  }
  if (/^[1-9]$/.test(e.key)) {
    const s = getState().sessions[+e.key - 1];
    if (s) {
      select(s.id);
      e.preventDefault();
    }
  }
});

void boot();
