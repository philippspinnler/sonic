import { describe, expect, it } from "vitest";
import { dropIndex } from "./sortable";

describe("dropIndex", () => {
  it("picks the slot by row centres", () => {
    const centers = [10, 30, 50];
    expect(dropIndex(centers, 5)).toBe(0);
    expect(dropIndex(centers, 20)).toBe(1);
    expect(dropIndex(centers, 100)).toBe(3);
  });
});
