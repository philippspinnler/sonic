import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { writeStdin, resizeSession } from "./ipc";

interface Pane {
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
}

const panes = new Map<string, Pane>();
let activeId: string | null = null;

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
    fontSize: 13,
    fontFamily: "Menlo, monospace",
    theme: { background: "#1a1b26", foreground: "#c0caf5" },
    scrollback: 10000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData(data => {
    void writeStdin(id, b64encode(data));
  });
  term.onResize(({ cols, rows }) => {
    void resizeSession(id, cols, rows);
  });
  panes.set(id, { term, fit, el });
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

window.addEventListener("resize", () => {
  if (activeId) panes.get(activeId)?.fit.fit();
});
