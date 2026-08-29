export function chooseNeutralSwap(
  visibleIds: number[],
  rankedIds: number[],
  removedId: number,
  excludedIds: number[] = [],
) {
  const unavailable = new Set([...visibleIds, ...excludedIds]);
  unavailable.delete(removedId);
  const replacementId = rankedIds.find((id) => id !== removedId && !unavailable.has(id));
  if (replacementId === undefined) return { visibleIds, replacementId: null };
  return {
    visibleIds: visibleIds.map((id) => id === removedId ? replacementId : id),
    replacementId,
  };
}

export type PickSlot<T> = {
  id: "pick-slot-1" | "pick-slot-2" | "pick-slot-3";
  value: T | null;
};

const slotIds: PickSlot<never>["id"][] = ["pick-slot-1", "pick-slot-2", "pick-slot-3"];

export function createPickSlots<T>(values: T[] = []): PickSlot<T>[] {
  return slotIds.map((id, index) => ({ id, value: values[index] || null }));
}

export function replacePickSlot<T>(slots: PickSlot<T>[], targetId: number, replacement: T | null, movieId: (value: T) => number): PickSlot<T>[] {
  return slots.map((slot) => slot.value && movieId(slot.value) === targetId ? { ...slot, value: replacement } : slot);
}
