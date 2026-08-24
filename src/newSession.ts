import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { listProfiles, recentFolders, startSession, Profile } from "./ipc";
import { select } from "./store";

let overlay: HTMLElement | null = null;

export function closeDialog(): void {
  overlay?.remove();
  overlay = null;
}

export async function openNewSessionDialog(): Promise<void> {
  closeDialog();
  const profiles = await listProfiles();
  if (profiles.length === 0) {
    window.dispatchEvent(new CustomEvent("sonic:settings"));
    return;
  }
  overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.addEventListener("click", e => {
    if (e.target === overlay) closeDialog();
  });
  const box = document.createElement("div");
  box.className = "dialog";
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  renderProfileStep(box, profiles);
}

function keyNav(box: HTMLElement, onPick: (i: number) => void): void {
  let idx = 0;
  const items = () => [...box.querySelectorAll<HTMLElement>(".pick-item")];
  const hi = () => items().forEach((el, i) => el.classList.toggle("selected", i === idx));
  hi();
  box.tabIndex = 0;
  box.focus();
  box.onkeydown = e => {
    const n = items().length;
    if (n === 0) return;
    if (e.key === "ArrowDown") { idx = (idx + 1) % n; hi(); }
    else if (e.key === "ArrowUp") { idx = (idx + n - 1) % n; hi(); }
    else if (e.key === "Enter") onPick(idx);
    else if (e.key === "Escape") closeDialog();
    else if (/^[1-9]$/.test(e.key) && +e.key <= n) onPick(+e.key - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
}

function renderProfileStep(box: HTMLElement, profiles: Profile[]): void {
  box.innerHTML = `<h2>New session — choose profile</h2><div class="pick-list"></div>`;
  const list = box.querySelector(".pick-list")!;
  profiles.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "pick-item";
    el.innerHTML = `<span class="num">${i + 1}</span><span class="tag"></span>`;
    const tag = el.querySelector<HTMLElement>(".tag")!;
    tag.textContent = p.name;
    tag.style.color = p.color;
    tag.style.borderColor = p.color;
    el.addEventListener("click", () => void renderFolderStep(box, p));
    list.appendChild(el);
  });
  keyNav(box, i => void renderFolderStep(box, profiles[i]));
}

async function renderFolderStep(box: HTMLElement, profile: Profile): Promise<void> {
  const recents = await recentFolders(profile.id);
  box.innerHTML = `<h2></h2><div class="pick-list"></div>`;
  box.querySelector("h2")!.textContent = `New session — ${profile.name} — choose folder`;
  const list = box.querySelector(".pick-list")!;
  const options = [...recents, "__browse__"];
  options.forEach((f, i) => {
    const el = document.createElement("div");
    el.className = "pick-item";
    const label = f === "__browse__" ? "Browse…" : f;
    el.innerHTML = `<span class="num">${i + 1}</span><span class="path"></span>`;
    el.querySelector<HTMLElement>(".path")!.textContent = label;
    el.addEventListener("click", () => void pick(f));
    list.appendChild(el);
  });
  keyNav(box, i => void pick(options[i]));

  async function pick(f: string): Promise<void> {
    let folder = f;
    if (f === "__browse__") {
      const chosen = await openFolder({ directory: true, multiple: false });
      if (typeof chosen !== "string") return;
      folder = chosen;
    }
    closeDialog();
    try {
      const id = await startSession(profile.id, folder);
      select(id);
    } catch (e) {
      alert(`Failed to start session: ${e}`);
    }
  }
}
