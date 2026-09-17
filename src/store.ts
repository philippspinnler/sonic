import { primaryTerminal } from "./projects";

export type Status = "idle" | "working" | "waiting" | "exited" | "unknown";
export type TerminalKind = "claude" | "shell";

export interface TerminalView {
  id: string;
  kind: TerminalKind;
  name: string;
  status: Status;
  /** epoch ms when the current "working" stretch began */
  workingSince?: number;
}

export interface ProjectView {
  id: string;
  name: string;
  profileId: string;
  profileName: string;
  profileColor: string;
  cwd: string;
  branch: string | null;
  terminals: TerminalView[];
}

interface State {
  projects: ProjectView[];
  /** selected terminal id */
  selectedId: string | null;
  /** project id → terminal id last selected in that project */
  lastSelected: Record<string, string>;
}

const empty = (): State => ({ projects: [], selectedId: null, lastSelected: {} });
let state: State = empty();
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function subscribe(fn: () => void): void {
  listeners.add(fn);
}

function notify(): void {
  listeners.forEach(fn => fn());
}

export function allTerminals(projects: ProjectView[]): TerminalView[] {
  return projects.flatMap(p => p.terminals);
}

export function findTerminal(id: string | null): { project: ProjectView; terminal: TerminalView } | undefined {
  if (!id) return undefined;
  for (const project of state.projects) {
    const terminal = project.terminals.find(t => t.id === id);
    if (terminal) return { project, terminal };
  }
  return undefined;
}

export function selectedProject(): ProjectView | undefined {
  return findTerminal(state.selectedId)?.project;
}

function withWorkingSince(next: TerminalView, prev: TerminalView | undefined, now: number): TerminalView {
  if (next.status !== "working") return { ...next, workingSince: undefined };
  return { ...next, workingSince: prev?.workingSince ?? now };
}

/** The terminal to show for a project: the one last picked in it, else its primary. */
function terminalFor(p: ProjectView, lastSelected: Record<string, string>): TerminalView {
  return p.terminals.find(t => t.id === lastSelected[p.id]) ?? primaryTerminal(p);
}

export function setProjects(projects: ProjectView[], now = Date.now()): void {
  const prev = new Map(allTerminals(state.projects).map(t => [t.id, t]));
  const next = projects.map(p => ({
    ...p,
    terminals: p.terminals.map(t => withWorkingSince(t, prev.get(t.id), now)),
  }));
  let selectedId = state.selectedId;
  if (!allTerminals(next).some(t => t.id === selectedId)) {
    const prevProjectId = selectedProject()?.id;
    const p = next.find(x => x.id === prevProjectId) ?? next[0];
    selectedId = p && p.terminals.length > 0 ? terminalFor(p, state.lastSelected).id : null;
  }
  state = { ...state, projects: next, selectedId };
  notify();
}

export function setStatus(id: string, status: Status, now = Date.now()): void {
  state = {
    ...state,
    projects: state.projects.map(p => ({
      ...p,
      terminals: p.terminals.map(t => (t.id === id ? withWorkingSince({ ...t, status }, t, now) : t)),
    })),
  };
  notify();
}

/** "3m", "1h 05m" — how long a terminal has been working; null when it isn't. */
export function formatElapsed(since: number | undefined, now: number): string | null {
  if (since === undefined) return null;
  const mins = Math.max(0, Math.floor((now - since) / 60000));
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** Select a terminal and remember it as the project's current one. */
export function select(id: string): void {
  const hit = findTerminal(id);
  const lastSelected = hit ? { ...state.lastSelected, [hit.project.id]: id } : state.lastSelected;
  state = { ...state, selectedId: id, lastSelected };
  notify();
}

/** Select a project: its remembered terminal, else its primary. */
export function selectProject(projectId: string): void {
  const p = state.projects.find(x => x.id === projectId);
  if (!p || p.terminals.length === 0) return;
  select(terminalFor(p, state.lastSelected).id);
}

export function waitingCount(): number {
  return allTerminals(state.projects).filter(t => t.status === "waiting").length;
}

export function _reset(): void {
  state = empty();
  listeners.clear();
}
