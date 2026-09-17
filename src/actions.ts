import { ask } from "@tauri-apps/plugin-dialog";
import * as ipc from "./ipc";
import { select } from "./store";
import type { ProjectView, TerminalView, TerminalKind } from "./store";
import { terminalLabel } from "./projects";

export async function closeTerminalWithConfirm(p: ProjectView, t: TerminalView): Promise<void> {
  if (t.status === "working") {
    const yes = await ask(`"${terminalLabel(p, t)}" is still working. Close it anyway?`, { title: "Close terminal" });
    if (!yes) return;
  }
  await ipc.closeTerminal(t.id);
}

export async function closeProjectWithConfirm(p: ProjectView): Promise<void> {
  const working = p.terminals.filter(t => t.status === "working").length;
  if (working > 0) {
    const what = working === 1 ? "a terminal that is" : `${working} terminals that are`;
    const yes = await ask(`"${p.name}" has ${what} still working. Close the project anyway?`, { title: "Close project" });
    if (!yes) return;
  }
  await ipc.closeProject(p.id);
}

export async function addTerminalAndSelect(projectId: string, kind: TerminalKind): Promise<void> {
  const id = await ipc.addTerminal(projectId, kind);
  select(id);
}

/** Replace an exited terminal with a fresh one of the same kind in the same project. */
export async function restartTerminal(p: ProjectView, t: TerminalView): Promise<void> {
  const id = await ipc.addTerminal(p.id, t.kind);
  await ipc.closeTerminal(t.id);
  select(id);
}

export function shortenHome(path: string): string {
  const m = path.match(/^\/Users\/[^/]+(\/.*)?$/);
  return m ? "~" + (m[1] ?? "") : path;
}
