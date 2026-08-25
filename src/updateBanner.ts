import * as ipc from "./ipc";
import type { UpdateInfo } from "./ipc";

export interface BannerView {
  text: string;
  button: "update" | "restart";
}

// What the sidebar banner should say for a given update check, or null to hide it.
export function bannerView(info: UpdateInfo): BannerView | null {
  if (info.needsUpgrade) {
    return { text: `Claude Code ${info.latest} available`, button: "update" };
  }
  if (info.needsRestart) {
    const v = info.installed ? `Claude Code ${info.installed} installed` : "Claude Code updated";
    return { text: `${v} — restart to use it`, button: "restart" };
  }
  return null;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let el: HTMLElement | null = null;

async function act(view: BannerView, btn: HTMLButtonElement, err: HTMLElement): Promise<void> {
  btn.disabled = true;
  err.textContent = "";
  try {
    if (view.button === "update") {
      btn.textContent = "Updating…";
      await ipc.updateClaude();
    }
    btn.textContent = "Restarting…";
    await ipc.restartWithSessions();
  } catch (e) {
    err.textContent = String(e);
    btn.disabled = false;
    btn.textContent = view.button === "update" ? "Update & restart" : "Restart";
  }
}

export function renderUpdateBanner(info: UpdateInfo): void {
  if (!el) return;
  const view = bannerView(info);
  el.hidden = !view;
  if (!view) return;
  el.innerHTML = `<div class="text"></div><button></button><div class="err"></div>`;
  el.querySelector(".text")!.textContent = view.text;
  const btn = el.querySelector("button")!;
  btn.textContent = view.button === "update" ? "Update & restart" : "Restart";
  const err = el.querySelector<HTMLElement>(".err")!;
  btn.addEventListener("click", () => void act(view, btn, err));
}

export async function checkNow(): Promise<void> {
  try {
    renderUpdateBanner(await ipc.checkClaudeUpdate());
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
