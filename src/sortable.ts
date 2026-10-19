/** Index a dragged row should take, given the vertical centres of all rows
 *  (in display order) and the pointer's y. */
export function dropIndex(centers: number[], y: number): number {
  let i = 0;
  while (i < centers.length && y > centers[i]) i++;
  return i;
}
