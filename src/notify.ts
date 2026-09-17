import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getState, subscribe, waitingCount } from "./store";
import { getSettings, setBadge } from "./ipc";
import { terminalLabel } from "./projects";

let lastStatuses = new Map<string, string>();
let enabled = true;

export async function initNotifications(): Promise<void> {
  enabled = (await getSettings()).notifications;
  if (enabled && !(await isPermissionGranted())) {
    enabled = (await requestPermission()) === "granted";
  }
  subscribe(onChange);
}

function onChange(): void {
  const { projects, selectedId } = getState();
  void setBadge(waitingCount());
  const next = new Map<string, string>();
  for (const p of projects) {
    for (const t of p.terminals) {
      next.set(t.id, t.status);
      const prev = lastStatuses.get(t.id);
      if (t.status === "waiting" && prev !== "waiting") {
        const focusedOnIt = document.hasFocus() && t.id === selectedId;
        if (enabled && !focusedOnIt) {
          sendNotification({
            title: `${terminalLabel(p, t)} needs your input`,
            body: `${p.profileName} · ${p.cwd}`,
          });
        }
      }
    }
  }
  lastStatuses = next;
}
