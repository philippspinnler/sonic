export type Status = "idle" | "working" | "waiting" | "exited" | "unknown";

export interface SessionView {
  id: string;
  name: string;
  profileId: string;
  profileName: string;
  profileColor: string;
  cwd: string;
  status: Status;
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

export function setSessions(sessions: SessionView[]): void {
  const stillThere = sessions.some(s => s.id === state.selectedId);
  state = {
    sessions,
    selectedId: stillThere ? state.selectedId : (sessions[0]?.id ?? null),
  };
  notify();
}

export function setStatus(id: string, status: Status): void {
  state = {
    ...state,
    sessions: state.sessions.map(s => (s.id === id ? { ...s, status } : s)),
  };
  notify();
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
