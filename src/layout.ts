const KEY = "sonic.sidebarWidth";
const MIN = 180;
const MAX = 520;

export function initSidebarResizer(): void {
  const sidebar = document.getElementById("sidebar")!;
  const handle = document.getElementById("sidebar-resizer")!;

  let saved: number | null = null;
  try {
    const v = localStorage.getItem(KEY);
    if (v) saved = Number(v);
  } catch {
    /* storage unavailable — use default width */
  }
  if (saved && saved >= MIN && saved <= MAX) sidebar.style.width = `${saved}px`;

  handle.addEventListener("mousedown", e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebar.getBoundingClientRect().width;
    document.body.classList.add("resizing");
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(MAX, Math.max(MIN, startW + ev.clientX - startX));
      sidebar.style.width = `${w}px`;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
      try {
        localStorage.setItem(KEY, String(Math.round(sidebar.getBoundingClientRect().width)));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}
