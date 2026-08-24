export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

let current: HTMLElement | null = null;

export function closeContextMenu(): void {
  current?.remove();
  current = null;
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const item of items) {
    const el = document.createElement("div");
    el.className = "ctx-item" + (item.danger ? " danger" : "");
    el.textContent = item.label;
    el.addEventListener("click", () => {
      closeContextMenu();
      item.action();
    });
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  // keep the menu inside the window
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  current = menu;
}

window.addEventListener("mousedown", e => {
  if (current && !current.contains(e.target as Node)) closeContextMenu();
});
window.addEventListener("keydown", e => {
  if (e.key === "Escape") closeContextMenu();
});
window.addEventListener("blur", closeContextMenu);
