/**
 * Board edits that keep stacking order: each group removes `ids` and puts `elements` where the first of them was.
 * Used by the eraser (split / remove) and its undo. Pure, no imports: the server uses it for `elements-replace`.
 */
export interface ElementGroup<T extends { id: string } = any> {
  ids: string[];
  elements: T[];
  /**
   * Where to put `elements` when none of `ids` is on the board (an undo bringing back something that was removed):
   * right after this element, or first when null. Left out, or that element gone: at the end.
   */
  after?: string | null;
}

/**
 * Applies groups in order: each removes its ids and inserts its elements at the index of the first removed one
 * (when none of its ids is present: after `after`, else at the end). Elements whose id is already on the board are skipped, so
 * applying the same groups twice is harmless. Returns a new array.
 */
export function applyElementGroups<T extends { id: string }>(list: T[], groups: ElementGroup<T>[]): T[] {
  let out = list;
  for (const g of groups) {
    const ids = new Set(g.ids);
    let at = -1;
    const kept: T[] = [];
    for (let i = 0; i < out.length; i++) {
      if (ids.has(out[i].id)) {
        if (at === -1) {
      if (g.after === null) at = 0;
      else {
        const prev = typeof g.after === 'string' ? kept.findIndex((el) => el.id === g.after) : -1;
        at = prev === -1 ? kept.length : prev + 1;
      }
    }
      } else kept.push(out[i]);
    }
    const present = new Set(kept.map((el) => el.id));
    const add = g.elements.filter((el) => el && el.id && !present.has(el.id) && (present.add(el.id), true));
    if (at === -1) {
      if (g.after === null) at = 0;
      else {
        const prev = typeof g.after === 'string' ? kept.findIndex((el) => el.id === g.after) : -1;
        at = prev === -1 ? kept.length : prev + 1;
      }
    }
    kept.splice(at, 0, ...add);
    out = kept;
  }
  return out;
}

