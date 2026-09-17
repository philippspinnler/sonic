import { describe, expect, test, beforeEach } from "vitest";
import {
  getState, setProjects, setStatus, select, selectProject, findTerminal, selectedProject,
  allTerminals, waitingCount, formatElapsed, _reset, ProjectView, TerminalView, Status, TerminalKind,
} from "./store";

const t = (id: string, kind: TerminalKind = "claude", status: Status = "idle"): TerminalView => ({ id, kind, name: id, status });
const pv = (id: string, terminals: TerminalView[]): ProjectView => ({
  id, name: id, profileId: "p", profileName: "P", profileColor: "#fff", cwd: "/x", branch: null, terminals,
});

beforeEach(() => _reset());

describe("store", () => {
  test("first project's primary terminal auto-selected", () => {
    setProjects([pv("a", [t("a-s", "shell"), t("a-c")]), pv("b", [t("b-c")])]);
    expect(getState().selectedId).toBe("a-c");
  });

  test("selection survives list update", () => {
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")])]);
    select("b-c");
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")]), pv("c", [t("c-c")])]);
    expect(getState().selectedId).toBe("b-c");
  });

  test("closing the selected terminal falls back within the same project", () => {
    setProjects([pv("a", [t("a-c"), t("a-s", "shell")]), pv("b", [t("b-c")])]);
    select("a-s");
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")])]);
    expect(getState().selectedId).toBe("a-c");
  });

  test("closing the selected project falls back to the first project", () => {
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")])]);
    select("b-c");
    setProjects([pv("a", [t("a-c")])]);
    expect(getState().selectedId).toBe("a-c");
  });

  test("selectProject remembers the last terminal picked in it", () => {
    setProjects([pv("a", [t("a-c"), t("a-s", "shell")]), pv("b", [t("b-c")])]);
    select("a-s");
    selectProject("b");
    expect(getState().selectedId).toBe("b-c");
    selectProject("a");
    expect(getState().selectedId).toBe("a-s");
  });

  test("a terminal selected before its project's projects event lands is still remembered", () => {
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")])]);
    select("a-s"); // not known to the store yet
    setProjects([pv("a", [t("a-c"), t("a-s", "shell")]), pv("b", [t("b-c")])]);
    selectProject("b");
    selectProject("a");
    expect(getState().selectedId).toBe("a-s");
  });

  test("selectProject falls back to primary when the remembered terminal is gone", () => {
    setProjects([pv("a", [t("a-c"), t("a-s", "shell")]), pv("b", [t("b-c")])]);
    select("a-s");
    selectProject("b");
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")])]);
    selectProject("a");
    expect(getState().selectedId).toBe("a-c");
  });

  test("setStatus updates one terminal", () => {
    setProjects([pv("a", [t("a-c"), t("a-s", "shell")])]);
    setStatus("a-s", "exited");
    expect(findTerminal("a-s")!.terminal.status).toBe("exited");
    expect(findTerminal("a-c")!.terminal.status).toBe("idle");
  });

  test("findTerminal and selectedProject", () => {
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")])]);
    expect(findTerminal("b-c")!.project.id).toBe("b");
    expect(findTerminal("zz")).toBeUndefined();
    select("b-c");
    expect(selectedProject()!.id).toBe("b");
  });

  test("waitingCount counts waiting terminals across projects", () => {
    setProjects([pv("a", [t("a-c", "claude", "waiting"), t("a-s", "shell")]), pv("b", [t("b-c", "claude", "waiting")])]);
    expect(waitingCount()).toBe(2);
    expect(allTerminals(getState().projects).length).toBe(3);
  });

  test("empty list clears selection", () => {
    setProjects([pv("a", [t("a-c")])]);
    setProjects([]);
    expect(getState().selectedId).toBeNull();
  });

  test("workingSince starts on transition to working and survives refreshes", () => {
    setProjects([pv("a", [t("a-c")])], 1000);
    setStatus("a-c", "working", 5000);
    expect(findTerminal("a-c")!.terminal.workingSince).toBe(5000);
    setProjects([pv("a", [t("a-c", "claude", "working")])], 9000);
    expect(findTerminal("a-c")!.terminal.workingSince).toBe(5000);
    setStatus("a-c", "idle", 12000);
    expect(findTerminal("a-c")!.terminal.workingSince).toBeUndefined();
  });
});

describe("formatElapsed", () => {
  test("formats minutes and hours", () => {
    expect(formatElapsed(undefined, 0)).toBeNull();
    expect(formatElapsed(0, 30_000)).toBe("<1m");
    expect(formatElapsed(0, 3 * 60_000)).toBe("3m");
    expect(formatElapsed(0, 65 * 60_000)).toBe("1h 05m");
  });
});
