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
