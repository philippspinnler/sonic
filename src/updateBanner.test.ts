import { describe, expect, it } from "vitest";
import { bannerView } from "./updateBanner";

const base = { installed: "2.1.245", latest: null, needsUpgrade: false, needsRestart: false };

describe("bannerView", () => {
  it("hides when nothing to do", () => {
    expect(bannerView(base)).toBeNull();
  });
  it("offers update when brew has a newer version", () => {
    expect(bannerView({ ...base, latest: "2.1.250", needsUpgrade: true, needsRestart: true }))
      .toEqual({ text: "Claude Code 2.1.250 available", button: "update" });
  });
  it("offers restart when sessions run an older binary", () => {
    expect(bannerView({ ...base, installed: "2.1.250", needsRestart: true }))
      .toEqual({ text: "Claude Code 2.1.250 installed — restart to use it", button: "restart" });
    expect(bannerView({ ...base, installed: null, needsRestart: true })!.text)
      .toBe("Claude Code updated — restart to use it");
  });
});
