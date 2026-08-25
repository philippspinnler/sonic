// Format dropped file paths the way a native terminal pastes them: each path
// shell-quoted, space-separated, with a trailing space so typing can continue.
export function shellQuote(p: string): string {
  return /^[A-Za-z0-9_\-./~]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

export function formatDroppedPaths(paths: string[]): string {
  if (paths.length === 0) return "";
  return paths.map(shellQuote).join(" ") + " ";
}
