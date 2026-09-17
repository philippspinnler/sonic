import { describe, expect, it } from "vitest";
import { primaryTerminal, rollupStatus, cycleTerminal, terminalLabel } from "./projects";
import type { ProjectView, TerminalView, Status, TerminalKind } from "./store";

const t = (id: string, kind: TerminalKind, status: Status = "idle"): TerminalView => ({ id, kind, name: id, status });
const p = (terminals: TerminalView[]): ProjectView => ({
  id: "p", name: "proj", profileId: "x", profileName: "X", profileColor: "#fff", cwd: "/w", branch: null, terminals,
});

describe("primaryTerminal", () => {
  it("is the first claude terminal, else the first terminal", () => {
    expect(primaryTerminal(p([t("s", "shell"), t("c", "claude")])).id).toBe("c");
    expect(primaryTerminal(p([t("s", "shell")])).id).toBe("s");
  });
});

describe("rollupStatus", () => {
  it("ranks waiting over working over idle over exited", () => {
    expect(rollupStatus(p([t("a", "claude", "idle"), t("b", "claude", "working")]))).toBe("working");
    expect(rollupStatus(p([t("a", "claude", "working"), t("b", "claude", "waiting")]))).toBe("waiting");
    expect(rollupStatus(p([t("a", "claude", "exited"), t("b", "claude", "idle")]))).toBe("idle");
    expect(rollupStatus(p([t("a", "claude", "exited")]))).toBe("exited");
  });
  it("ignores live shells but shows a dead one", () => {
    expect(rollupStatus(p([t("a", "claude", "idle"), t("s", "shell", "working")]))).toBe("idle");
    expect(rollupStatus(p([t("a", "claude", "idle"), t("s", "shell", "exited")]))).toBe("idle");
    expect(rollupStatus(p([t("a", "claude", "exited"), t("s", "shell", "exited")]))).toBe("exited");
    expect(rollupStatus(p([t("s", "shell", "exited")]))).toBe("exited");
    expect(rollupStatus(p([t("s", "shell", "idle")]))).toBe("idle");
  });
  it("keeps unknown visible when nothing else is known", () => {
    expect(rollupStatus(p([t("a", "claude", "unknown")]))).toBe("unknown");
    expect(rollupStatus(p([t("a", "claude", "unknown"), t("b", "claude", "idle")]))).toBe("idle");
  });
});

describe("cycleTerminal", () => {
  const proj = p([t("a", "claude"), t("b", "shell"), t("c", "claude")]);
  it("wraps forwards and backwards", () => {
    expect(cycleTerminal(proj, "a", 1).id).toBe("b");
    expect(cycleTerminal(proj, "c", 1).id).toBe("a");
    expect(cycleTerminal(proj, "a", -1).id).toBe("c");
  });
  it("starts from the first terminal when the current one is unknown", () => {
    expect(cycleTerminal(proj, "zz", 1).id).toBe("b");
  });
});

describe("terminalLabel", () => {
  it("adds the terminal name only when the project has several", () => {
    const one = p([t("a", "claude")]);
    expect(terminalLabel(one, one.terminals[0])).toBe("proj");
    const two = p([t("a", "claude"), t("b", "shell")]);
    expect(terminalLabel(two, two.terminals[1])).toBe("proj · b");
  });
});
