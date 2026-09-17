import { getState, setProjects, setStatus, select, selectProject, selectedProject, findTerminal, allTerminals, subscribe } from "./store";
import { renderSidebar } from "./sidebar";
import { ensureTerminal, writeData, showTerminal, disposeTerminal, openSearch, setFontSize } from "./terminals";
import * as ipc from "./ipc";
import type { ProjectView } from "./store";
import { openNewSessionDialog } from "./newSession";
import { openSettings } from "./settings";
import { initNotifications } from "./notify";
import { maybeRestore } from "./restore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { closeTerminalWithConfirm, closeProjectWithConfirm, addTerminalAndSelect } from "./actions";
import { cycleTerminal } from "./projects";
import { initSidebarResizer } from "./layout";
import { initEmptyState } from "./emptyState";
import { ask } from "@tauri-apps/plugin-dialog";

async function closeSelectedTerminal(): Promise<void> {
  const hit = findTerminal(getState().selectedId);
  if (hit) await closeTerminalWithConfirm(hit.project, hit.terminal);
}

async function closeSelectedProject(): Promise<void> {
  const p = selectedProject();
  if (p) await closeProjectWithConfirm(p);
}

async function addToSelected(kind: "claude" | "shell"): Promise<void> {
  const p = selectedProject();
  if (p) await addTerminalAndSelect(p.id, kind);
}

function cycleSelected(dir: 1 | -1): void {
  const p = selectedProject();
  if (!p || p.terminals.length < 2) return;
  select(cycleTerminal(p, getState().selectedId, dir).id);
}

window.addEventListener("sonic:new-session", () => void openNewSessionDialog());
window.addEventListener("sonic:settings", () => void openSettings());

let knownIds = new Set<string>();

async function refresh(projects?: ProjectView[]): Promise<void> {
  const list = projects ?? (await ipc.listProjects());
  const ids = new Set<string>(allTerminals(list).map(t => t.id));
  for (const id of knownIds) if (!ids.has(id)) disposeTerminal(id);
  for (const id of ids) ensureTerminal(id);
  knownIds = ids;
  setProjects(list);
}

subscribe(() => showTerminal(getState().selectedId));

async function boot(): Promise<void> {
  await ipc.onProjectsChanged(p => void refresh(p));
  await ipc.onTerminalData((id, b64) => writeData(id, b64));
  await ipc.onTerminalStatus((id, status) => setStatus(id, status));
  await ipc.onMenu(id => {
    if (id === "new-project") void openNewSessionDialog();
    else if (id === "new-shell") void addToSelected("shell");
    else if (id === "new-claude") void addToSelected("claude");
    else if (id === "close-terminal") void closeSelectedTerminal();
    else if (id === "close-project") void closeSelectedProject();
    else if (id === "settings") window.dispatchEvent(new CustomEvent("sonic:settings"));
  });
  await initNotifications();
  setFontSize((await ipc.getSettings()).font_size);
  window.addEventListener("sonic:font-size", e => setFontSize((e as CustomEvent<number>).detail));
  initSidebarResizer();
  initEmptyState();
  await refresh();
  renderSidebar();
  setInterval(() => void refresh(), 30_000); // picks up branch switches

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
    const working = allTerminals(getState().projects).filter(t => t.status === "working");
    if (working.length > 0) {
      const yes = await ask(
        `${working.length} terminal(s) are still working. Quit anyway? (Claude terminals can be resumed on next launch.)`,
        { title: "Quit Sonic" },
      );
      if (!yes) e.preventDefault();
    }
  });
}

window.addEventListener("keydown", e => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === "f" && !e.shiftKey) {
    openSearch();
    e.preventDefault();
    return;
  }
  // ⌘⇧] / ⌘⇧[ cycle terminals inside the selected project (codes, since ⇧ changes e.key)
  if (e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
    cycleSelected(e.code === "BracketRight" ? 1 : -1);
    e.preventDefault();
    return;
  }
  if (/^[1-9]$/.test(e.key)) {
    const p = getState().projects[+e.key - 1];
    if (p) {
      selectProject(p.id);
      e.preventDefault();
    }
  }
});

void boot();
