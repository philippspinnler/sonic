import { getState, select, selectProject, subscribe, formatElapsed, Folder, ProjectView, TerminalView } from "./store";
import {
  renameProject, renameTerminal, arrangeProjects, revealInFinder, copyText,
  newFolder, renameFolder, setFolderCollapsed, removeFolder,
} from "./ipc";
import { dropIndex } from "./sortable";
import { showContextMenu } from "./contextMenu";
import {
  closeProjectWithConfirm, closeTerminalWithConfirm, addTerminalAndSelect, restartTerminal, shortenHome,
} from "./actions";
import { primaryTerminal, rollupStatus, displayOrder, folderStatus, layoutOf, Placement } from "./projects";
import { initUpdateBanner } from "./updateBanner";

// Each project is a `.project-group`: its project row followed by one
// `.terminal-row` per terminal when there are two or more. A folder is a
// `.folder-group`: its `.folder-header` followed by its projects' groups;
// loose projects sit directly in the list. Nodes are updated
// in place and keyed by id: rebuilding the DOM on every store change breaks
// double-click (second click hits a new node) and would destroy an
// in-progress rename input on any status event.
const groups = new Map<string, HTMLElement>();
const termRows = new Map<string, HTMLElement>();
const folderEls = new Map<string, HTMLElement>();
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
    beginDrag(group, e.clientY);
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

// ---- folders ----

function createFolderGroup(id: string): HTMLElement {
  const fg = document.createElement("div");
  fg.className = "folder-group";
  fg.dataset.id = id;
  const header = document.createElement("div");
  header.className = "folder-header";
  header.innerHTML = `<span class="chev"></span><span class="row-name"></span><span class="count"></span><span class="dot"></span>`;
  // a click toggles, so renaming lives in the menu (a double-click would toggle twice)
  header.addEventListener("click", () => {
    if (dragged || header.querySelector("input")) return;
    void setFolderCollapsed(id, !fg.classList.contains("collapsed"));
  });
  header.addEventListener("mousedown", e => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("input")) return;
    beginDrag(fg, e.clientY);
  });
  header.addEventListener("contextmenu", e => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: "Rename…", action: () => startRename(header, name => void renameFolder(id, name)) },
      { label: "Remove folder (keeps its projects)", action: () => void removeFolder(id) },
    ]);
  });
  fg.appendChild(header);
  return fg;
}

function updateFolderGroup(fg: HTMLElement, f: Folder, members: ProjectView[]): void {
  fg.classList.toggle("collapsed", f.collapsed);
  const header = fg.firstElementChild as HTMLElement;
  header.querySelector(".chev")!.textContent = f.collapsed ? "▸" : "▾";
  const nameEl = header.querySelector<HTMLElement>(".row-name");
  if (nameEl && nameEl.textContent !== f.name) nameEl.textContent = f.name; // absent while renaming
  header.querySelector(".count")!.textContent = `· ${members.length}`;
  const dot = header.querySelector<HTMLElement>(".dot")!;
  setDot(dot, folderStatus(members));
  dot.hidden = !f.collapsed; // open folders show their projects' own dots
}

/** A folder made from the menu opens in rename mode once its header exists. */
let renameOnCreate: string | null = null;

function renamePendingFolder(): void {
  const fg = renameOnCreate ? folderEls.get(renameOnCreate) : undefined;
  if (!fg?.isConnected) return;
  const id = renameOnCreate!;
  renameOnCreate = null;
  startRename(fg.firstElementChild as HTMLElement, name => void renameFolder(id, name));
}

async function makeFolder(p: ProjectView): Promise<void> {
  renameOnCreate = await newFolder(p.id, "New folder");
  renamePendingFolder();
}

function moveToFolder(id: string, folder: string | null): void {
  void arrangeProjects(layoutOf(getState().projects).map(x => (x.id === id ? { id, folder } : x)));
}

/** Put `els` into `parent` in order from child index `offset`, moving only what changed (moving blurs inputs). */
function place(parent: HTMLElement, els: HTMLElement[], offset: number): void {
  els.forEach((el, i) => {
    const slot = parent.children[i + offset] ?? null;
    if (slot !== el) parent.insertBefore(el, slot);
  });
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
  const top: HTMLElement[] = []; // the list's children, in order
  const folders = new Map<string, { folder: Folder; members: ProjectView[]; els: HTMLElement[] }>();
  for (const p of displayOrder(projects)) {
    seen.add(p.id);
    if (p.terminals.length === 0) continue;
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

    if (!p.folder) {
      top.push(group);
      continue;
    }
    let f = folders.get(p.folder.id);
    if (!f) {
      let fg = folderEls.get(p.folder.id);
      if (!fg) {
        fg = createFolderGroup(p.folder.id);
        folderEls.set(p.folder.id, fg);
      }
      top.push(fg);
      f = { folder: p.folder, members: [], els: [] };
      folders.set(p.folder.id, f);
    }
    f.members.push(p);
    f.els.push(group);
  }
  for (const [id, f] of folders) updateFolderGroup(folderEls.get(id)!, f.folder, f.members);
  if (!sorting) {
    place(list, top, 0);
    for (const [id, f] of folders) place(folderEls.get(id)!, f.els, 1); // index 0 is the header
  }
  for (const [id, group] of groups) {
    if (!seen.has(id)) {
      for (const el of group.querySelectorAll<HTMLElement>(".terminal-row")) termRows.delete(el.dataset.id!);
      group.remove();
      groups.delete(id);
    }
  }
  // after placing, so projects leaving a removed folder are already out of it
  for (const [id, fg] of folderEls) {
    if (!folders.has(id) && !sorting) {
      fg.remove();
      folderEls.delete(id);
    }
  }
  renamePendingFolder();
}

// ---- drag-to-reorder projects and folders (pointer based: the webview's native DnD is
// taken by Tauri for file drops, so the HTML5 drag API never fires in-page) ----
const DRAG_THRESHOLD = 5;
let dragged = false;
let sorting = false; // renderSidebar must not move nodes while a drag is in flight

/** Read the sidebar back as a layout, with `moving` taken out and put where `slot` is. */
function domLayout(list: HTMLElement, moving: HTMLElement, slot: HTMLElement): Placement[] {
  const out: Placement[] = [];
  const walk = (parent: Element, folder: string | null): void => {
    for (const c of parent.children) {
      if (c === moving) continue;
      const node = (c === slot ? moving : c) as HTMLElement;
      if (node.classList.contains("folder-group")) walk(node, node.dataset.id!);
      else if (node.classList.contains("project-group")) out.push({ id: node.dataset.id!, folder });
    }
  };
  walk(list, null);
  return out;
}

/** Drag a `.project-group` (anywhere, or onto a folder header to join it) or a whole `.folder-group`. */
function beginDrag(el: HTMLElement, startY: number): void {
  const list = ensureShell();
  const isFolder = el.classList.contains("folder-group");
  let placeholder: HTMLElement | null = null;
  let into: HTMLElement | null = null; // the folder header a project is held over

  const onMove = (e: MouseEvent): void => {
    const dy = e.clientY - startY;
    if (!placeholder) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return;
      dragged = true;
      placeholder = document.createElement("div");
      placeholder.className = "drop-placeholder";
      placeholder.style.height = `${el.offsetHeight}px`;
      el.classList.add("dragging");
      el.style.width = `${el.offsetWidth}px`;
      el.parentElement!.insertBefore(placeholder, el);
      document.body.classList.add("sorting");
      sorting = true;
    }
    el.style.transform = `translateY(${dy}px)`;
    into?.classList.remove("drop-into");
    into = isFolder ? null : [...list.querySelectorAll<HTMLElement>(".folder-header")].find(h => {
      const b = h.getBoundingClientRect();
      return e.clientY >= b.top && e.clientY < b.bottom;
    }) ?? null;
    if (into) {
      into.classList.add("drop-into");
      into.parentElement!.appendChild(placeholder); // joins at the end, even when collapsed
      return;
    }
    // a folder moves among the top-level items; a project among every visible project and header
    const targets = isFolder
      ? [...list.children].filter(c => c !== el && c !== placeholder) as HTMLElement[]
      : [...list.querySelectorAll<HTMLElement>(".project-group:not(.dragging), .folder-header")]
          .filter(x => x.offsetHeight > 0);
    const centers = targets.map(g => { const b = g.getBoundingClientRect(); return b.top + b.height / 2; });
    const t = targets[dropIndex(centers, e.clientY)];
    if (!t) list.appendChild(placeholder);
    else if (t.classList.contains("folder-header")) list.insertBefore(placeholder, t.parentElement); // above the folder, loose
    else t.parentElement!.insertBefore(placeholder, t);
  };
  const onUp = (): void => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (!placeholder) return;
    const next = domLayout(list, el, placeholder);
    into?.classList.remove("drop-into");
    placeholder.remove();
    el.classList.remove("dragging");
    el.style.transform = "";
    el.style.width = "";
    document.body.classList.remove("sorting");
    sorting = false;
    if (JSON.stringify(next) !== JSON.stringify(layoutOf(getState().projects))) void arrangeProjects(next);
    renderSidebar(); // put nodes back where the store says until the new layout arrives
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
    { label: "New sidebar folder…", action: () => void makeFolder(p) },
    ...(p.folder ? [{ label: `Remove from “${p.folder.name}”`, action: () => moveToFolder(p.id, null) }] : []),
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
