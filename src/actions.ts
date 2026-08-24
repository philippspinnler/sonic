import { ask } from "@tauri-apps/plugin-dialog";
import * as ipc from "./ipc";
import type { SessionView } from "./store";

export async function closeSessionWithConfirm(s: SessionView): Promise<void> {
  if (s.status === "working") {
    const yes = await ask(`"${s.name}" is still working. Close it anyway?`, { title: "Close session" });
    if (!yes) return;
  }
  await ipc.closeSession(s.id);
}

export function shortenHome(path: string): string {
  const m = path.match(/^\/Users\/[^/]+(\/.*)?$/);
  return m ? "~" + (m[1] ?? "") : path;
}
