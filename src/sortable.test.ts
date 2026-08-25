import { describe, expect, it } from "vitest";
import { moveItem, dropIndex } from "./sortable";

describe("moveItem", () => {
  it("moves down and up", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });
  it("is a no-op for same index or bad input", () => {
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});

describe("dropIndex", () => {
  it("picks the slot by row centres", () => {
    const centers = [10, 30, 50];
    expect(dropIndex(centers, 5)).toBe(0);
    expect(dropIndex(centers, 20)).toBe(1);
    expect(dropIndex(centers, 100)).toBe(3);
  });
});
