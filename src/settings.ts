import { open as openFolder, ask } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
import * as ipc from "./ipc";
import { select } from "./store";

let overlay: HTMLElement | null = null;

export function closeSettings(): void {
  overlay?.remove();
  overlay = null;
}

export async function openSettings(): Promise<void> {
  closeSettings();
  overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.addEventListener("click", e => {
    if (e.target === overlay) closeSettings();
  });
  const box = document.createElement("div");
  box.className = "dialog settings";
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  await render(box);
}

async function render(box: HTMLElement): Promise<void> {
  const [profiles, settings] = await Promise.all([ipc.listProfiles(), ipc.getSettings()]);
  box.innerHTML = `
    <h2>Profiles</h2>
    <div id="profile-rows"></div>
    <div class="btn-row">
      <button id="p-new">New profile…</button>
      <button id="p-import">Import existing dir…</button>
    </div>
    <h2>App</h2>
    <label class="field">claude binary
      <input id="s-bin" placeholder="auto (from login shell PATH)" />
    </label>
    <label class="field row">Terminal font size <input id="s-font" type="number" min="9" max="24" style="width:60px" /></label>
    <label class="field row"><input type="checkbox" id="s-notif" /> Notifications when a session needs input</label>
    <div class="btn-row"><button id="s-close">Close</button></div>`;

  const rows = box.querySelector("#profile-rows")!;
  for (const p of profiles) {
    const row = document.createElement("div");
    row.className = "profile-row";
    row.innerHTML = `
      <span class="tag"></span>
      <span class="pr-dir"></span>
      ${p.hooksOk ? "" : `<span class="warn" title="hooks not installed; status will show as unknown">⚠ status</span>`}
      <button class="pr-term">Terminal</button>
      <button class="pr-rename">Rename</button>
      <button class="pr-del">Delete</button>`;
    const tag = row.querySelector<HTMLElement>(".tag")!;
    tag.textContent = p.name + (p.managed ? "" : " (imported)");
    tag.style.color = p.color;
    tag.style.borderColor = p.color;
    const dir = row.querySelector<HTMLElement>(".pr-dir")!;
    dir.textContent = p.configDir;
    dir.title = p.configDir;
    row.querySelector(".pr-term")!.addEventListener("click", async () => {
      const id = await ipc.startSession(p.id, await homeDir(), null, `setup: ${p.name}`);
      closeSettings();
      select(id);
    });
    row.querySelector(".pr-rename")!.addEventListener("click", async () => {
      const name = prompt("Profile name", p.name);
      if (name) {
        await ipc.updateProfile({ ...p, name });
        await render(box);
      }
    });
    row.querySelector(".pr-del")!.addEventListener("click", async () => {
      const msg = p.managed
        ? `Delete profile "${p.name}"? Its config dir (login, MCPs) will be moved to the Trash.`
        : `Remove profile "${p.name}"? The directory ${p.configDir} will NOT be touched.`;
      if (!(await ask(msg, { title: "Delete profile" }))) return;
      try {
        await ipc.deleteProfile(p.id);
      } catch (e) {
        alert(String(e));
      }
      await render(box);
    });
    rows.appendChild(row);
  }

  box.querySelector("#p-new")!.addEventListener("click", async () => {
    const name = prompt("Profile name (e.g. acme corp)");
    if (!name) return;
    const p = await ipc.createProfile(name);
    const id = await ipc.startSession(p.id, await homeDir(), null, `setup: ${p.name}`);
    closeSettings();
    select(id);
  });
  box.querySelector("#p-import")!.addEventListener("click", async () => {
    const dir = await openFolder({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    const name = prompt("Profile name for this config dir", dir.split("/").pop() ?? "imported");
    if (!name) return;
    await ipc.importProfile(name, dir);
    await render(box);
  });

  const bin = box.querySelector<HTMLInputElement>("#s-bin")!;
  bin.value = settings.claude_bin ?? "";
  const notif = box.querySelector<HTMLInputElement>("#s-notif")!;
  notif.checked = settings.notifications;
  const font = box.querySelector<HTMLInputElement>("#s-font")!;
  font.value = String(settings.font_size);
  const saveApp = () => {
    const font_size = Math.min(24, Math.max(9, Number(font.value) || 13));
    window.dispatchEvent(new CustomEvent("sonic:font-size", { detail: font_size }));
    void ipc.setSettings({
      claude_bin: bin.value.trim() || null,
      notifications: notif.checked,
      font_size,
    });
  };
  bin.addEventListener("change", saveApp);
  notif.addEventListener("change", saveApp);
  font.addEventListener("change", saveApp);
  box.querySelector("#s-close")!.addEventListener("click", closeSettings);
}
