import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { writeStdin, resizeSession, openUrl } from "./ipc";
import { formatDroppedPaths } from "./dropPaths";

interface Pane {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLElement;
}

const panes = new Map<string, Pane>();
let activeId: string | null = null;
let fontSize = 13;

export function setFontSize(size: number): void {
  fontSize = size;
  for (const pane of panes.values()) {
    pane.term.options.fontSize = size;
    if (pane.el.offsetHeight > 0) pane.fit.fit();
  }
}

function b64encode(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

function b64decode(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

export function ensureTerminal(id: string): void {
  if (panes.has(id)) return;
  const el = document.createElement("div");
  el.className = "term-pane";
  document.getElementById("terminals")!.appendChild(el);
  const term = new Terminal({
    fontSize,
    fontFamily: "Menlo, monospace",
    theme: { background: "#1a1b26", foreground: "#c0caf5" },
    scrollback: 10000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));
  const search = new SearchAddon();
  term.loadAddon(search);
  term.open(el);
  term.onData(data => {
    void writeStdin(id, b64encode(data));
  });
  term.onResize(({ cols, rows }) => {
    void resizeSession(id, cols, rows);
  });
  // refit whenever the pane's actual box changes (layout shifts, sidebar,
  // banner insertion) — window resize alone misses those
  const ro = new ResizeObserver(() => {
    if (el.offsetHeight > 0) fit.fit();
  });
  ro.observe(el);
  if (term.element) ro.observe(term.element);
  panes.set(id, { term, fit, search, el });
}

export function writeData(id: string, dataB64: string): void {
  panes.get(id)?.term.write(b64decode(dataB64));
}

export function showTerminal(id: string | null): void {
  activeId = id;
  for (const [pid, pane] of panes) {
    pane.el.classList.toggle("active", pid === id);
  }
  if (id) {
    const pane = panes.get(id);
    requestAnimationFrame(() => {
      pane?.fit.fit();
      pane?.term.focus();
    });
  }
}

export function disposeTerminal(id: string): void {
  const pane = panes.get(id);
  if (!pane) return;
  pane.term.dispose();
  pane.el.remove();
  panes.delete(id);
  if (activeId === id) activeId = null;
}

// ---- ⌘F search bar ----
const searchBar = document.createElement("div");
searchBar.className = "search-bar";
searchBar.hidden = true;
searchBar.innerHTML = `<input placeholder="Find (Enter next, ⇧Enter previous, Esc close)" /><span class="count"></span>`;
document.getElementById("main")!.appendChild(searchBar);
const searchInput = searchBar.querySelector("input")!;
const searchOpts = { caseSensitive: false, decorations: { matchBackground: "#e0af68", matchOverviewRuler: "#e0af68", activeMatchBackground: "#ff9e64", activeMatchColorOverviewRuler: "#ff9e64" } };

function activeSearch(): SearchAddon | undefined {
  return activeId ? panes.get(activeId)?.search : undefined;
}

export function openSearch(): void {
  if (!activeId) return;
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
}

function closeSearch(): void {
  searchBar.hidden = true;
  activeSearch()?.clearDecorations();
  if (activeId) panes.get(activeId)?.term.focus();
}

searchInput.addEventListener("input", () => {
  activeSearch()?.findNext(searchInput.value, { ...searchOpts, incremental: true });
});
searchInput.addEventListener("keydown", e => {
  if (e.key === "Escape") closeSearch();
  else if (e.key === "Enter" && e.shiftKey) activeSearch()?.findPrevious(searchInput.value, searchOpts);
  else if (e.key === "Enter") activeSearch()?.findNext(searchInput.value, searchOpts);
  else return;
  e.preventDefault();
});

// Tauri intercepts OS file drops before the DOM sees them, so listen on the
// webview and paste the paths into the active session like a terminal would.
// Claude Code picks image paths up from the prompt and attaches them.
const mainEl = document.getElementById("main")!;
// Drop positions arrive in physical pixels; DOM rects are in CSS pixels.
function overMain(pos: { x: number; y: number }): boolean {
  const r = mainEl.getBoundingClientRect();
  const x = pos.x / window.devicePixelRatio;
  const y = pos.y / window.devicePixelRatio;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

void getCurrentWebview().onDragDropEvent(ev => {
  const kind = ev.payload.type;
  const hovering = (kind === "enter" || kind === "over") && overMain(ev.payload.position);
  mainEl.classList.toggle("drop-target", hovering);
  if (kind !== "drop" || !activeId || !overMain(ev.payload.position)) return;
  const text = formatDroppedPaths(ev.payload.paths);
  if (!text) return;
  void writeStdin(activeId, b64encode(text));
  panes.get(activeId)?.term.focus();
});

window.addEventListener("resize", () => {
  if (activeId) panes.get(activeId)?.fit.fit();
});
