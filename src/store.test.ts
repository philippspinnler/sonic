import { describe, expect, test, beforeEach } from "vitest";
import { getState, setSessions, setStatus, select, waitingCount, _reset, SessionView } from "./store";

const sv = (id: string, status = "idle"): SessionView => ({
  id, name: id, profileId: "p", profileName: "P", profileColor: "#fff", cwd: "/x", status: status as SessionView["status"],
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
});
