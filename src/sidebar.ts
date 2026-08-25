import { getState, select, subscribe, formatElapsed, SessionView } from "./store";
import { renameSession, revealInFinder, copyText, startSession, closeSession } from "./ipc";
import { showContextMenu } from "./contextMenu";
import { closeSessionWithConfirm, shortenHome } from "./actions";
import { initUpdateBanner } from "./updateBanner";

// Rows are updated in place and keyed by session id: rebuilding the DOM on
// every store change breaks double-click (second click hits a new node) and
// would destroy an in-progress rename input on any status event.
const rows = new Map<string, HTMLElement>();
let list: HTMLElement | null = null;

function ensureShell(): HTMLElement {
  if (list) return list;
  const el = document.getElementById("sidebar")!;
  list = document.createElement("div");
  list.className = "session-list";
  el.appendChild(list);
  const update = document.createElement("div");
  update.className = "update-banner";
  el.appendChild(update);
  initUpdateBanner(update);
  const version = document.createElement("div");
  version.className = "sidebar-version";
  version.textContent = `Sonic ${__APP_VERSION__}`;
  el.appendChild(version);
  const footer = document.createElement("div");
  footer.className = "sidebar-footer";
  footer.innerHTML = `<button id="btn-new">＋ New session</button><button id="btn-settings">⚙</button>`;
  el.appendChild(footer);
  footer.querySelector("#btn-new")!.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("sonic:new-session")),
  );
  footer.querySelector("#btn-settings")!.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("sonic:settings")),
  );
  return list;
}

function createRow(id: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "session-row";
  row.innerHTML = `
    <span class="dot"></span>
    <span class="row-main">
      <span class="row-top">
        <span class="row-name"></span>
        <span class="tag"></span>
      </span>
      <span class="folder"><bdi></bdi></span>
      <span class="row-meta"><span class="branch"></span><span class="elapsed"></span></span>
    </span>`;
  row.addEventListener("click", () => {
    if (getState().selectedId !== id) select(id);
  });
  row.querySelector(".row-name")!.addEventListener("dblclick", e => {
    e.stopPropagation();
    startRename(row, id);
  });
  row.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (getState().selectedId !== id) select(id);
    const s = getState().sessions.find(x => x.id === id);
    if (s) showContextMenu(e.clientX, e.clientY, contextItems(row, s));
  });
  return row;
}

function updateRow(row: HTMLElement, s: SessionView, selected: boolean): void {
  row.className =
    "session-row" + (selected ? " selected" : "") + (s.status === "waiting" ? " waiting" : "");
  const dot = row.querySelector<HTMLElement>(".dot")!;
  dot.className = `dot ${s.status}`;
  dot.title = s.status === "unknown"
    ? "Status unknown: Sonic's hooks are not installed for this profile (its settings.json could not be parsed). See Settings."
    : s.status;
  const nameEl = row.querySelector<HTMLElement>(".row-name");
  if (nameEl && nameEl.textContent !== s.name) nameEl.textContent = s.name; // absent while renaming
  const tag = row.querySelector<HTMLElement>(".tag")!;
  tag.textContent = s.profileName;
  tag.style.color = s.profileColor;
  tag.style.borderColor = s.profileColor;
  const folder = row.querySelector<HTMLElement>(".folder")!;
  folder.querySelector("bdi")!.textContent = shortenHome(s.cwd);
  folder.title = s.cwd;
  const branch = row.querySelector<HTMLElement>(".branch")!;
  branch.textContent = s.branch ? `⎇ ${s.branch}` : "";
  const elapsed = row.querySelector<HTMLElement>(".elapsed")!;
  elapsed.textContent = formatElapsed(s.workingSince, Date.now()) ?? "";
  row.querySelector<HTMLElement>(".row-meta")!.hidden = !s.branch && !elapsed.textContent;

  const existing = row.querySelector<HTMLElement>(".restart");
  if (s.status === "exited" && !existing) {
    const bar = document.createElement("span");
    bar.className = "restart";
    bar.textContent = "↻";
    bar.title = "Restart in same folder";
    bar.addEventListener("click", async e => {
      e.stopPropagation();
      await closeSession(s.id);
      const id = await startSession(s.profileId, s.cwd, null, s.name);
      select(id);
    });
    row.appendChild(bar);
  } else if (s.status !== "exited" && existing) {
    existing.remove();
  }
}

export function renderSidebar(): void {
  const list = ensureShell();
  const { sessions, selectedId } = getState();
  const seen = new Set<string>();
  sessions.forEach((s, i) => {
    seen.add(s.id);
    let row = rows.get(s.id);
    if (!row) {
      row = createRow(s.id);
      rows.set(s.id, row);
    }
    updateRow(row, s, s.id === selectedId);
    // only move nodes whose position actually changed (moving blurs inputs)
    if (list.children[i] !== row) list.insertBefore(row, list.children[i] ?? null);
  });
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.remove();
      rows.delete(id);
    }
  }
}

function contextItems(row: HTMLElement, s: SessionView) {
  return [
    { label: "Rename…", action: () => startRename(row, s.id) },
    { label: "Reveal folder in Finder", action: () => void revealInFinder(s.cwd) },
    { label: "Copy folder path", action: () => void copyText(s.cwd) },
    { label: "Close session", danger: true, action: () => void closeSessionWithConfirm(s) },
  ];
}

function startRename(row: HTMLElement, id: string): void {
  const nameEl = row.querySelector<HTMLElement>(".row-name");
  if (!nameEl) return; // already renaming
  const current = nameEl.textContent ?? "";
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = current;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    input.replaceWith(nameEl);
    const next = input.value.trim();
    if (save && next && next !== current) void renameSession(id, next);
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", e => e.stopPropagation());
  input.addEventListener("dblclick", e => e.stopPropagation());
}

subscribe(renderSidebar);

// keep the elapsed-time labels moving
setInterval(() => {
  if (getState().sessions.some(s => s.workingSince !== undefined)) renderSidebar();
}, 30_000);
