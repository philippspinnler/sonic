import { describe, expect, it } from "vitest";
import { dropPointInRect, formatDroppedPaths, shellQuote } from "./dropPaths";

describe("shellQuote", () => {
  it("leaves plain paths alone", () => {
    expect(shellQuote("/Users/x/img.png")).toBe("/Users/x/img.png");
  });
  it("quotes spaces and specials", () => {
    expect(shellQuote("/Users/x/Screen Shot.png")).toBe("'/Users/x/Screen Shot.png'");
    expect(shellQuote("/a/it's.png")).toBe(`'/a/it'\\''s.png'`);
  });
});

describe("formatDroppedPaths", () => {
  it("joins with spaces and adds a trailing space", () => {
    expect(formatDroppedPaths(["/a.png", "/b c.png"])).toBe("/a.png '/b c.png' ");
  });
  it("is empty for no paths", () => {
    expect(formatDroppedPaths([])).toBe("");
  });
});

describe("dropPointInRect", () => {
  const main = { left: 245, top: 0, right: 1000, bottom: 600 };
  it("accepts a drop inside the rect using the position as CSS pixels", () => {
    // On macOS Tauri's "physical" drop position is really logical points, so a
    // drop at x=300 must not be scaled down (e.g. halved on Retina) into the sidebar.
    expect(dropPointInRect({ x: 300, y: 100 }, main)).toBe(true);
  });
  it("rejects a drop left of the rect", () => {
    expect(dropPointInRect({ x: 100, y: 100 }, main)).toBe(false);
  });
  it("rejects a drop below the rect", () => {
    expect(dropPointInRect({ x: 300, y: 601 }, main)).toBe(false);
  });
});
