import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getState, subscribe, waitingCount } from "./store";
import { getSettings, setBadge } from "./ipc";

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
  const { sessions, selectedId } = getState();
  void setBadge(waitingCount());
  for (const s of sessions) {
    const prev = lastStatuses.get(s.id);
    if (s.status === "waiting" && prev !== "waiting") {
      const focusedOnIt = document.hasFocus() && s.id === selectedId;
      if (enabled && !focusedOnIt) {
        sendNotification({
          title: `${s.name} needs your input`,
          body: `${s.profileName} · ${s.cwd}`,
        });
      }
    }
  }
  lastStatuses = new Map(sessions.map(s => [s.id, s.status]));
}
