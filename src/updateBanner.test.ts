import { describe, expect, it } from "vitest";
import { bannerRows } from "./updateBanner";

const base = { installed: "2.1.245", latest: null, needsUpgrade: false, needsRestart: false };

describe("bannerRows", () => {
  it("is empty when nothing to do", () => {
    expect(bannerRows(base, null)).toEqual([]);
  });
  it("offers a Claude update when brew has a newer version", () => {
    expect(bannerRows({ ...base, latest: "2.1.250", needsUpgrade: true, needsRestart: true }, null))
      .toEqual([{ text: "Claude Code 2.1.250 available", label: "Update & restart", action: "update-claude" }]);
  });
  it("offers a restart when sessions run an older binary", () => {
    expect(bannerRows({ ...base, installed: "2.1.250", needsRestart: true }, null))
      .toEqual([{ text: "Claude Code 2.1.250 installed — restart to use it", label: "Restart", action: null }]);
    expect(bannerRows({ ...base, installed: null, needsRestart: true }, null)[0].text)
      .toBe("Claude Code updated — restart to use it");
  });
  it("lists a Sonic update first", () => {
    const rows = bannerRows({ ...base, latest: "2.1.250", needsUpgrade: true }, "0.1.4");
    expect(rows.map(r => r.action)).toEqual(["update-sonic", "update-claude"]);
    expect(rows[0].text).toBe("Sonic 0.1.4 available");
  });
});
