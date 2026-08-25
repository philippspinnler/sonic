export type Status = "idle" | "working" | "waiting" | "exited" | "unknown";

export interface SessionView {
  id: string;
  name: string;
  profileId: string;
  profileName: string;
  profileColor: string;
  cwd: string;
  status: Status;
  branch: string | null;
  /** epoch ms when the current "working" stretch began */
  workingSince?: number;
}

interface State {
  sessions: SessionView[];
  selectedId: string | null;
}

let state: State = { sessions: [], selectedId: null };
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

function withWorkingSince(next: SessionView, prev: SessionView | undefined, now: number): SessionView {
  if (next.status !== "working") return { ...next, workingSince: undefined };
  return { ...next, workingSince: prev?.workingSince ?? now };
}

export function setSessions(sessions: SessionView[], now = Date.now()): void {
  const stillThere = sessions.some(s => s.id === state.selectedId);
  const prevById = new Map(state.sessions.map(s => [s.id, s]));
  state = {
    sessions: sessions.map(s => withWorkingSince(s, prevById.get(s.id), now)),
    selectedId: stillThere ? state.selectedId : (sessions[0]?.id ?? null),
  };
  notify();
}

export function setStatus(id: string, status: Status, now = Date.now()): void {
  state = {
    ...state,
    sessions: state.sessions.map(s => (s.id === id ? withWorkingSince({ ...s, status }, s, now) : s)),
  };
  notify();
}

/** "3m", "1h 05m" — how long a session has been working; null when it isn't. */
export function formatElapsed(since: number | undefined, now: number): string | null {
  if (since === undefined) return null;
  const mins = Math.max(0, Math.floor((now - since) / 60000));
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

export function select(id: string): void {
  state = { ...state, selectedId: id };
  notify();
}

export function waitingCount(): number {
  return state.sessions.filter(s => s.status === "waiting").length;
}

export function _reset(): void {
  state = { sessions: [], selectedId: null };
  listeners.clear();
}
