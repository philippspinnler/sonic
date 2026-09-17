import { getState, selectProject, subscribe, formatElapsed, ProjectView } from "./store";
import { renameProject, reorderProjects, revealInFinder, copyText } from "./ipc";
import { moveItem, dropIndex } from "./sortable";
import { showContextMenu } from "./contextMenu";
import { closeProjectWithConfirm, restartTerminal, shortenHome } from "./actions";
import { initUpdateBanner } from "./updateBanner";
import { primaryTerminal, rollupStatus } from "./projects";

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
    if (dragged) return; // a completed drag is not a click
    selectProject(id);
  });
  row.addEventListener("mousedown", e => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("input, .restart")) return;
    beginDrag(row, id, e.clientY);
  });
  row.querySelector(".row-name")!.addEventListener("dblclick", e => {
    e.stopPropagation();
    startRename(row, id);
  });
  row.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (getState().selectedId !== id) selectProject(id);
    const s = getState().projects.find(x => x.id === id);
    if (s) showContextMenu(e.clientX, e.clientY, contextItems(row, s));
  });
  return row;
}

function updateRow(row: HTMLElement, s: ProjectView, selected: boolean): void {
  const primary = primaryTerminal(s);
  const status = rollupStatus(s);
  row.className =
    "session-row" + (selected ? " selected" : "") + (status === "waiting" ? " waiting" : "");
  const dot = row.querySelector<HTMLElement>(".dot")!;
  dot.className = `dot ${status}`;
  dot.title = status === "unknown"
    ? "Status unknown: Sonic's hooks are not installed for this profile (its settings.json could not be parsed). See Settings."
    : status;
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
  elapsed.textContent = formatElapsed(primary.workingSince, Date.now()) ?? "";
  row.querySelector<HTMLElement>(".row-meta")!.hidden = !s.branch && !elapsed.textContent;

  const existing = row.querySelector<HTMLElement>(".restart");
  if (status === "exited" && !existing) {
    const bar = document.createElement("span");
    bar.className = "restart";
    bar.textContent = "↻";
    bar.title = "Restart in same folder";
    bar.addEventListener("click", e => {
      e.stopPropagation();
      void restartTerminal(s, primary);
    });
    row.appendChild(bar);
  } else if (status !== "exited" && existing) {
    existing.remove();
  }
}

export function renderSidebar(): void {
  const list = ensureShell();
  const { projects, selectedId } = getState();
  const seen = new Set<string>();
  projects.forEach((s, i) => {
    seen.add(s.id);
    let row = rows.get(s.id);
    if (!row) {
      row = createRow(s.id);
      rows.set(s.id, row);
    }
    const selected = s.terminals.some(t => t.id === selectedId);
    updateRow(row, s, selected);
    // only move nodes whose position actually changed (moving blurs inputs)
    if (!sorting && list.children[i] !== row) list.insertBefore(row, list.children[i] ?? null);
  });
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.remove();
      rows.delete(id);
    }
  }
}

// ---- drag-to-reorder (pointer based: the webview's native DnD is taken by
// Tauri for file drops, so the HTML5 drag API never fires in-page) ----
const DRAG_THRESHOLD = 5;
let dragged = false;
let sorting = false; // renderSidebar must not move nodes while a drag is in flight

function beginDrag(row: HTMLElement, id: string, startY: number): void {
  const list = ensureShell();
  let placeholder: HTMLElement | null = null;
  let target = -1;
  const from = getState().projects.findIndex(s => s.id === id);

  const onMove = (e: MouseEvent): void => {
    const dy = e.clientY - startY;
    if (!placeholder) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return;
      dragged = true;
      placeholder = document.createElement("div");
      placeholder.className = "drop-placeholder";
      placeholder.style.height = `${row.offsetHeight}px`;
      row.classList.add("dragging");
      row.style.width = `${row.offsetWidth}px`;
      list.insertBefore(placeholder, row);
      document.body.classList.add("sorting");
      sorting = true;
    }
    row.style.transform = `translateY(${dy}px)`;
    const others = [...list.querySelectorAll<HTMLElement>(".session-row:not(.dragging)")];
    const centers = others.map(r => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; });
    target = dropIndex(centers, e.clientY);
    list.insertBefore(placeholder, others[target] ?? null);
  };
  const onUp = (): void => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (!placeholder) return;
    placeholder.remove();
    row.classList.remove("dragging");
    row.style.transform = "";
    row.style.width = "";
    document.body.classList.remove("sorting");
    sorting = false;
    const ids = getState().projects.map(s => s.id);
    const next = moveItem(ids, from, target);
    if (next.some((v, i) => v !== ids[i])) void reorderProjects(next);
    // let the click that follows mouseup see `dragged`, then reset
    setTimeout(() => { dragged = false; }, 0);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function contextItems(row: HTMLElement, s: ProjectView) {
  return [
    { label: "Rename…", action: () => startRename(row, s.id) },
    { label: "Reveal folder in Finder", action: () => void revealInFinder(s.cwd) },
    { label: "Copy folder path", action: () => void copyText(s.cwd) },
    { label: "Close session", danger: true, action: () => void closeProjectWithConfirm(s) },
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
    if (save && next && next !== current) void renameProject(id, next);
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
  if (getState().projects.some(p => p.terminals.some(t => t.workingSince !== undefined))) renderSidebar();
}, 30_000);
