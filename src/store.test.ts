import { describe, expect, test, beforeEach } from "vitest";
import { getState, setSessions, setStatus, select, waitingCount, formatElapsed, _reset, SessionView } from "./store";

const sv = (id: string, status = "idle"): SessionView => ({
  id, name: id, profileId: "p", profileName: "P", profileColor: "#fff", cwd: "/x", status: status as SessionView["status"], branch: null,
});

beforeEach(() => _reset());

describe("store", () => {
  test("first session auto-selected", () => {
    setSessions([sv("a"), sv("b")]);
    expect(getState().selectedId).toBe("a");
  });

  test("selection survives list update, falls back when removed", () => {
    setSessions([sv("a"), sv("b")]);
    select("b");
    setSessions([sv("a"), sv("b"), sv("c")]);
    expect(getState().selectedId).toBe("b");
    setSessions([sv("a"), sv("c")]);
    expect(getState().selectedId).toBe("a");
  });

  test("setStatus updates one session", () => {
    setSessions([sv("a"), sv("b")]);
    setStatus("b", "waiting");
    expect(getState().sessions.find(s => s.id === "b")!.status).toBe("waiting");
    expect(getState().sessions.find(s => s.id === "a")!.status).toBe("idle");
  });

  test("waitingCount counts waiting sessions", () => {
    setSessions([sv("a", "waiting"), sv("b"), sv("c", "waiting")]);
    expect(waitingCount()).toBe(2);
  });

  test("empty list clears selection", () => {
    setSessions([sv("a")]);
    setSessions([]);
    expect(getState().selectedId).toBeNull();
  });

  test("workingSince starts on transition to working and survives refreshes", () => {
    setSessions([sv("a")], 1000);
    setStatus("a", "working", 5000);
    expect(getState().sessions[0].workingSince).toBe(5000);
    setSessions([sv("a", "working")], 9000);
    expect(getState().sessions[0].workingSince).toBe(5000);
    setStatus("a", "idle", 12000);
    expect(getState().sessions[0].workingSince).toBeUndefined();
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
