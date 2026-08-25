import * as ipc from "./ipc";
import { getState } from "./store";
import { ask } from "@tauri-apps/plugin-dialog";
import type { UpdateInfo } from "./ipc";

export interface BannerRow {
  text: string;
  label: string;
  /** what to run before restarting */
  action: "update-sonic" | "update-claude" | null;
}

// Rows the sidebar banner should show; empty means hide it.
export function bannerRows(claude: UpdateInfo, sonicLatest: string | null): BannerRow[] {
  const rows: BannerRow[] = [];
  if (sonicLatest) {
    rows.push({ text: `Sonic ${sonicLatest} available`, label: "Update & restart", action: "update-sonic" });
  }
  if (claude.needsUpgrade) {
    rows.push({ text: `Claude Code ${claude.latest} available`, label: "Update & restart", action: "update-claude" });
  } else if (claude.needsRestart) {
    const v = claude.installed ? `Claude Code ${claude.installed} installed` : "Claude Code updated";
    rows.push({ text: `${v} — restart to use it`, label: "Restart", action: null });
  }
  return rows;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let el: HTMLElement | null = null;

async function act(row: BannerRow, btn: HTMLButtonElement, err: HTMLElement): Promise<void> {
  const working = getState().sessions.filter(s => s.status === "working").length;
  if (working > 0) {
    const yes = await ask(
      `${working} session(s) are still working. Restart anyway? (They will be resumed after the restart.)`,
      { title: "Restart Sonic" },
    );
    if (!yes) return;
  }
  btn.disabled = true;
  err.textContent = "";
  try {
    if (row.action) {
      btn.textContent = "Updating…";
      await (row.action === "update-sonic" ? ipc.updateSonic() : ipc.updateClaude());
    }
    btn.textContent = "Restarting…";
    await ipc.restartWithSessions();
  } catch (e) {
    err.textContent = String(e);
    btn.disabled = false;
    btn.textContent = "Retry";
  }
}

export function renderUpdateBanner(rows: BannerRow[]): void {
  if (!el) return;
  el.hidden = rows.length === 0;
  el.innerHTML = "";
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "update-row";
    item.innerHTML = `<div class="text"></div><button></button><div class="err"></div>`;
    item.querySelector(".text")!.textContent = row.text;
    const btn = item.querySelector("button")!;
    btn.textContent = row.label;
    const err = item.querySelector<HTMLElement>(".err")!;
    btn.addEventListener("click", () => void act(row, btn, err));
    el.appendChild(item);
  }
}

export async function checkNow(): Promise<void> {
  try {
    const [claude, sonic] = await Promise.all([ipc.checkClaudeUpdate(), ipc.checkSonicUpdate()]);
    renderUpdateBanner(bannerRows(claude, sonic));
  } catch (e) {
    console.error("update check failed", e);
  }
}

export function initUpdateBanner(container: HTMLElement): void {
  el = container;
  el.hidden = true;
  void checkNow();
  setInterval(() => void checkNow(), CHECK_INTERVAL_MS);
}
