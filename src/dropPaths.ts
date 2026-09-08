// Format dropped file paths the way a native terminal pastes them: each path
// shell-quoted, space-separated, with a trailing space so typing can continue.
export function shellQuote(p: string): string {
  return /^[A-Za-z0-9_\-./~]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

export function formatDroppedPaths(paths: string[]): string {
  if (paths.length === 0) return "";
  return paths.map(shellQuote).join(" ") + " ";
}

// Is a drop position inside a DOM rect? Both are in CSS pixels: Tauri types
// the drop position as PhysicalPosition, but on macOS wry forwards
// NSDraggingInfo.draggingLocation, which is in logical points, unscaled. Do
// not divide by devicePixelRatio here; on Retina that halves the coordinates
// and drops on the left half of the terminal land "in the sidebar".
export function dropPointInRect(
  pos: { x: number; y: number },
  r: { left: number; top: number; right: number; bottom: number },
): boolean {
  return pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom;
}
