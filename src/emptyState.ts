import { getState, subscribe } from "./store";
import { listProfiles } from "./ipc";
import { openNewSessionDialog } from "./newSession";
import iconUrl from "../assets/icon.svg";

let el: HTMLElement | null = null;

export function initEmptyState(): void {
  el = document.createElement("div");
  el.id = "empty";
  document.getElementById("main")!.appendChild(el);
  subscribe(() => void render());
  void render();
}

export async function render(): Promise<void> {
  if (!el) return;
  const { sessions } = getState();
  if (sessions.length > 0) {
    el.classList.remove("visible");
    return;
  }
  const profiles = await listProfiles();
  el.innerHTML = `
    <img class="empty-icon" alt="" />
    <div class="empty-title">No sessions</div>
    <div class="empty-hint">Press <kbd>⌘N</kbd> to start one, or pick a profile:</div>
    <div class="empty-profiles"></div>`;
  el.querySelector<HTMLImageElement>(".empty-icon")!.src = iconUrl;
  const list = el.querySelector(".empty-profiles")!;
  if (profiles.length === 0) {
    const b = document.createElement("button");
    b.textContent = "Create your first profile…";
    b.addEventListener("click", () => window.dispatchEvent(new CustomEvent("sonic:settings")));
    list.appendChild(b);
  }
  for (const p of profiles) {
    const b = document.createElement("button");
    b.className = "tag";
    b.textContent = p.name;
    b.style.color = p.color;
    b.style.borderColor = p.color;
    b.addEventListener("click", () => void openNewSessionDialog(p));
    list.appendChild(b);
  }
  el.classList.add("visible");
}
