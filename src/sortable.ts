/** Move the item at `from` so that it ends up at index `to`. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list.slice();
  const out = list.slice();
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

/** Index a dragged row should take, given the vertical centres of all rows
 *  (in display order) and the pointer's y. */
export function dropIndex(centers: number[], y: number): number {
  let i = 0;
  while (i < centers.length && y > centers[i]) i++;
  return i;
}
