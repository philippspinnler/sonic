import { getState, select, selectProject, subscribe, formatElapsed, ProjectView, TerminalView } from "./store";
import { renameProject, renameTerminal, reorderProjects, revealInFinder, copyText } from "./ipc";
import { moveItem, dropIndex } from "./sortable";
import { showContextMenu } from "./contextMenu";
import {
  closeProjectWithConfirm, closeTerminalWithConfirm, addTerminalAndSelect, restartTerminal, shortenHome,
} from "./actions";
import { primaryTerminal, rollupStatus } from "./projects";
import { initUpdateBanner } from "./updateBanner";

// Each project is a `.project-group`: its project row followed by one
// `.terminal-row` per terminal when there are two or more. Nodes are updated
// in place and keyed by id: rebuilding the DOM on every store change breaks
// double-click (second click hits a new node) and would destroy an
// in-progress rename input on any status event.
const groups = new Map<string, HTMLElement>();
const termRows = new Map<string, HTMLElement>();
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
  footer.innerHTML = `<button id="btn-new">＋ New project</button><button id="btn-settings">⚙</button>`;
  el.appendChild(footer);
  footer.querySelector("#btn-new")!.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("sonic:new-session")),
  );
  footer.querySelector("#btn-settings")!.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("sonic:settings")),
  );
  return list;
}

function project(id: string): ProjectView | undefined {
  return getState().projects.find(p => p.id === id);
}

// ---- project rows ----

function createGroup(id: string): HTMLElement {
  const group = document.createElement("div");
  group.className = "project-group";
  group.dataset.id = id;
  const row = document.createElement("div");
  row.className = "session-row project";
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
    beginDrag(group, id, e.clientY);
  });
  row.querySelector(".row-name")!.addEventListener("dblclick", e => {
    e.stopPropagation();
    startRename(row, name => void renameProject(id, name));
  });
  row.addEventListener("contextmenu", e => {
    e.preventDefault();
    selectProject(id);
    const p = project(id);
    if (p) showContextMenu(e.clientX, e.clientY, projectMenu(row, p));
  });
  group.appendChild(row);
  return group;
}

function setDot(dot: HTMLElement, status: TerminalView["status"]): void {
  dot.className = `dot ${status}`;
  dot.title = status === "unknown"
    ? "Status unknown: Sonic's hooks are not installed for this profile (its settings.json could not be parsed). See Settings."
    : status;
}

function setRestart(row: HTMLElement, show: boolean, onClick: () => void): void {
  const existing = row.querySelector<HTMLElement>(".restart");
  if (show && !existing) {
    const bar = document.createElement("span");
    bar.className = "restart";
    bar.textContent = "↻";
    bar.title = "Restart in same folder";
    bar.addEventListener("click", e => {
      e.stopPropagation();
      onClick();
    });
    row.appendChild(bar);
  } else if (!show && existing) {
    existing.remove();
  }
}

function updateProjectRow(row: HTMLElement, p: ProjectView, selected: boolean, expanded: boolean): void {
  const status = rollupStatus(p);
  const primary = primaryTerminal(p);
  row.className =
    "session-row project" +
    (selected ? (expanded ? " group-selected" : " selected") : "") +
    (status === "waiting" ? " waiting" : "");
  setDot(row.querySelector<HTMLElement>(".dot")!, status);
  const nameEl = row.querySelector<HTMLElement>(".row-name");
  if (nameEl && nameEl.textContent !== p.name) nameEl.textContent = p.name; // absent while renaming
  const tag = row.querySelector<HTMLElement>(".tag")!;
  tag.textContent = p.profileName;
  tag.style.color = p.profileColor;
  tag.style.borderColor = p.profileColor;
  const folder = row.querySelector<HTMLElement>(".folder")!;
  folder.querySelector("bdi")!.textContent = shortenHome(p.cwd);
  folder.title = p.cwd;
  const branch = row.querySelector<HTMLElement>(".branch")!;
  branch.textContent = p.branch ? `⎇ ${p.branch}` : "";
  const elapsed = row.querySelector<HTMLElement>(".elapsed")!;
  elapsed.textContent = expanded ? "" : (formatElapsed(primary.workingSince, Date.now()) ?? "");
  row.querySelector<HTMLElement>(".row-meta")!.hidden = !p.branch && !elapsed.textContent;
  setRestart(row, !expanded && primary.status === "exited", () => void restartTerminal(p, primary));
}

// ---- terminal rows (only when a project has two or more) ----

function createTerminalRow(projectId: string, id: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "terminal-row";
  row.dataset.id = id;
  row.innerHTML = `<span class="dot"></span><span class="kind"></span><span class="row-name"></span><span class="elapsed"></span>`;
  row.addEventListener("click", () => {
    if (dragged) return;
    select(id);
  });
  row.querySelector(".row-name")!.addEventListener("dblclick", e => {
    e.stopPropagation();
    startRename(row, name => void renameTerminal(id, name));
  });
  row.addEventListener("contextmenu", e => {
    e.preventDefault();
    select(id);
    const p = project(projectId);
    const t = p?.terminals.find(x => x.id === id);
    if (p && t) showContextMenu(e.clientX, e.clientY, terminalMenu(row, p, t));
  });
  return row;
}

function updateTerminalRow(row: HTMLElement, p: ProjectView, t: TerminalView, selected: boolean): void {
  row.className = "terminal-row" + (selected ? " selected" : "") + (t.status === "waiting" ? " waiting" : "");
  setDot(row.querySelector<HTMLElement>(".dot")!, t.status);
  row.querySelector<HTMLElement>(".kind")!.textContent = t.kind === "claude" ? "✦" : "$";
  const nameEl = row.querySelector<HTMLElement>(".row-name");
  if (nameEl && nameEl.textContent !== t.name) nameEl.textContent = t.name;
  row.querySelector<HTMLElement>(".elapsed")!.textContent = formatElapsed(t.workingSince, Date.now()) ?? "";
  setRestart(row, t.status === "exited", () => void restartTerminal(p, t));
}

export function renderSidebar(): void {
  const list = ensureShell();
  const { projects, selectedId } = getState();
  const seen = new Set<string>();
  projects.forEach((p, i) => {
    seen.add(p.id);
    if (p.terminals.length === 0) return;
    let group = groups.get(p.id);
    if (!group) {
      group = createGroup(p.id);
      groups.set(p.id, group);
    }
    const expanded = p.terminals.length > 1;
    const selectedInProject = p.terminals.some(t => t.id === selectedId);
    updateProjectRow(group.firstElementChild as HTMLElement, p, selectedInProject, expanded);

    const wanted = expanded ? p.terminals : [];
    wanted.forEach((t, j) => {
      let row = termRows.get(t.id);
      if (!row) {
        row = createTerminalRow(p.id, t.id);
        termRows.set(t.id, row);
      }
      updateTerminalRow(row, p, t, t.id === selectedId);
      const slot = group!.children[j + 1] ?? null; // index 0 is the project row
      if (slot !== row) group!.insertBefore(row, slot);
    });
    for (const el of [...group.querySelectorAll<HTMLElement>(".terminal-row")]) {
      const tid = el.dataset.id!;
      if (!wanted.some(t => t.id === tid)) {
        el.remove();
        termRows.delete(tid);
      }
    }
    // only move nodes whose position actually changed (moving blurs inputs)
    if (!sorting && list.children[i] !== group) list.insertBefore(group, list.children[i] ?? null);
  });
  for (const [id, group] of groups) {
    if (!seen.has(id)) {
      for (const el of group.querySelectorAll<HTMLElement>(".terminal-row")) termRows.delete(el.dataset.id!);
      group.remove();
      groups.delete(id);
    }
  }
}

// ---- drag-to-reorder projects (pointer based: the webview's native DnD is
// taken by Tauri for file drops, so the HTML5 drag API never fires in-page) ----
const DRAG_THRESHOLD = 5;
let dragged = false;
let sorting = false; // renderSidebar must not move nodes while a drag is in flight

function beginDrag(group: HTMLElement, id: string, startY: number): void {
  const list = ensureShell();
  let placeholder: HTMLElement | null = null;
  let target = -1;
  const from = getState().projects.findIndex(p => p.id === id);

  const onMove = (e: MouseEvent): void => {
    const dy = e.clientY - startY;
    if (!placeholder) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return;
      dragged = true;
      placeholder = document.createElement("div");
      placeholder.className = "drop-placeholder";
      placeholder.style.height = `${group.offsetHeight}px`;
      group.classList.add("dragging");
      group.style.width = `${group.offsetWidth}px`;
      list.insertBefore(placeholder, group);
      document.body.classList.add("sorting");
      sorting = true;
    }
    group.style.transform = `translateY(${dy}px)`;
    const others = [...list.querySelectorAll<HTMLElement>(".project-group:not(.dragging)")];
    const centers = others.map(g => { const b = g.getBoundingClientRect(); return b.top + b.height / 2; });
    target = dropIndex(centers, e.clientY);
    list.insertBefore(placeholder, others[target] ?? null);
  };
  const onUp = (): void => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (!placeholder) return;
    placeholder.remove();
    group.classList.remove("dragging");
    group.style.transform = "";
    group.style.width = "";
    document.body.classList.remove("sorting");
    sorting = false;
    const ids = getState().projects.map(p => p.id);
    const next = moveItem(ids, from, target);
    if (next.some((v, i) => v !== ids[i])) void reorderProjects(next);
    // let the click that follows mouseup see `dragged`, then reset
    setTimeout(() => { dragged = false; }, 0);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// ---- context menus ----

function projectMenu(row: HTMLElement, p: ProjectView) {
  return [
    { label: "Rename…", action: () => startRename(row, name => void renameProject(p.id, name)) },
    { label: "New shell here", action: () => void addTerminalAndSelect(p.id, "shell") },
    { label: "New Claude terminal here", action: () => void addTerminalAndSelect(p.id, "claude") },
    { label: "Reveal folder in Finder", action: () => void revealInFinder(p.cwd) },
    { label: "Copy folder path", action: () => void copyText(p.cwd) },
    { label: "Close project", danger: true, action: () => void closeProjectWithConfirm(p) },
  ];
}

function terminalMenu(row: HTMLElement, p: ProjectView, t: TerminalView) {
  return [
    { label: "Rename…", action: () => startRename(row, name => void renameTerminal(t.id, name)) },
    { label: "Close terminal", danger: true, action: () => void closeTerminalWithConfirm(p, t) },
  ];
}

// ---- inline rename (shared by project and terminal rows) ----

function startRename(row: HTMLElement, save: (name: string) => void): void {
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
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    input.replaceWith(nameEl);
    const next = input.value.trim();
    if (commit && next && next !== current) save(next);
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", e => e.stopPropagation());
  input.addEventListener("mousedown", e => e.stopPropagation());
  input.addEventListener("dblclick", e => e.stopPropagation());
}

subscribe(renderSidebar);

// keep the elapsed-time labels moving
setInterval(() => {
  if (getState().projects.some(p => p.terminals.some(t => t.workingSince !== undefined))) renderSidebar();
}, 30_000);
