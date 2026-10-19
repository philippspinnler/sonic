import type { ProjectView, TerminalView, Status } from "./store";

/** The first Claude terminal, else the first terminal. Callers guarantee at least one. */
export function primaryTerminal(p: ProjectView): TerminalView {
  return p.terminals.find(t => t.kind === "claude") ?? p.terminals[0];
}

// waiting beats working beats idle beats unknown beats exited
const RANK: Status[] = ["waiting", "working", "idle", "unknown", "exited"];

/** Project-row status. Live shells stay silent; a dead shell counts as exited. */
export function rollupStatus(p: ProjectView): Status {
  const votes = p.terminals
    .filter(t => t.kind === "claude" || t.status === "exited")
    .map(t => t.status);
  if (votes.length === 0) return "idle";
  return RANK.find(s => votes.includes(s)) ?? "idle";
}

/** Next (+1) or previous (-1) terminal in creation order, wrapping around. */
export function cycleTerminal(p: ProjectView, currentId: string | null, dir: 1 | -1): TerminalView {
  const n = p.terminals.length;
  const i = p.terminals.findIndex(t => t.id === currentId);
  return p.terminals[((i < 0 ? 0 : i) + dir + n) % n];
}

/** "proj" for a single-terminal project, "proj · shell 2" otherwise. */
export function terminalLabel(p: ProjectView, t: TerminalView): string {
  return p.terminals.length > 1 ? `${p.name} · ${t.name}` : p.name;
}

/** Sidebar order: a folder sits where its first project is, with all its projects right after. */
export function displayOrder(projects: ProjectView[]): ProjectView[] {
  const out: ProjectView[] = [];
  for (const p of projects) {
    if (out.includes(p)) continue;
    if (p.folder) out.push(...projects.filter(x => x.folder?.id === p.folder!.id));
    else out.push(p);
  }
  return out;
}

/** Projects in sidebar order, minus those hidden in a collapsed folder (⌘1…⌘9). */
export function visibleProjects(projects: ProjectView[]): ProjectView[] {
  return displayOrder(projects).filter(p => !p.folder?.collapsed);
}

/** Folder dot: the most urgent project status inside it. */
export function folderStatus(members: ProjectView[]): Status {
  const votes = members.map(rollupStatus);
  return RANK.find(s => votes.includes(s)) ?? "idle";
}

export interface Placement {
  id: string;
  folder: string | null;
}

/** Each project's position and folder, as `arrange_projects` takes it. */
export function layoutOf(projects: ProjectView[]): Placement[] {
  return displayOrder(projects).map(p => ({ id: p.id, folder: p.folder?.id ?? null }));
}
