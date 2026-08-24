import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SessionView, Status } from "./store";

export type { SessionView };

export interface Profile {
  id: string;
  name: string;
  configDir: string;
  managed: boolean;
  env: Record<string, string>;
  color: string;
  hooksOk: boolean;
}

export interface SessionRecord {
  id: string;
  name: string;
  profile_id: string;
  cwd: string;
  claude_session_id: string | null;
  created_at: string;
}

export interface AppSettings {
  claude_bin: string | null;
  notifications: boolean;
}

export const listProfiles = () => invoke<Profile[]>("list_profiles");
export const createProfile = (name: string) => invoke<Profile>("create_profile", { name });
export const importProfile = (name: string, dir: string) => invoke<Profile>("import_profile", { name, dir });
export const updateProfile = (profile: Profile) => invoke<void>("update_profile", { profile });
export const deleteProfile = (id: string) => invoke<void>("delete_profile", { id });
export const listSessions = () => invoke<SessionView[]>("list_sessions");
export const startSession = (profileId: string, cwd: string, resumeId?: string | null, name?: string | null) =>
  invoke<string>("start_session", { profileId, cwd, resumeId: resumeId ?? null, name: name ?? null });
export const writeStdin = (id: string, dataB64: string) => invoke<void>("write_stdin", { id, dataB64 });
export const resizeSession = (id: string, cols: number, rows: number) =>
  invoke<void>("resize_session", { id, cols, rows });
export const renameSession = (id: string, name: string) => invoke<void>("rename_session", { id, name });
export const closeSession = (id: string) => invoke<void>("close_session", { id });
export const recentFolders = (profileId: string) => invoke<string[]>("recent_folders", { profileId });
export const previousSessions = () => invoke<SessionRecord[]>("previous_sessions");
export const discardPrevious = () => invoke<void>("discard_previous");
export const getSettings = () => invoke<AppSettings>("get_settings");
export const setSettings = (settings: AppSettings) => invoke<void>("set_settings", { settings });
export const checkClaude = () => invoke<string | null>("check_claude");
export const setBadge = (count: number) => invoke<void>("set_badge", { count });

export const onSessionsChanged = (fn: (s: SessionView[]) => void) =>
  listen<SessionView[]>("sessions-changed", e => fn(e.payload));
export const onSessionData = (fn: (id: string, dataB64: string) => void) =>
  listen<{ id: string; dataB64: string }>("session-data", e => fn(e.payload.id, e.payload.dataB64));
export const onSessionStatus = (fn: (id: string, status: Status) => void) =>
  listen<{ id: string; status: Status }>("session-status", e => fn(e.payload.id, e.payload.status));
export const onMenu = (fn: (id: string) => void) => listen<string>("menu", e => fn(e.payload));
