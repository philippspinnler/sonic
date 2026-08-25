import { describe, expect, it } from "vitest";
import { formatDroppedPaths, shellQuote } from "./dropPaths";

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
