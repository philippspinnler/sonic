import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProjectView, TerminalView, TerminalKind, Status } from "./store";

export type { ProjectView, TerminalView, TerminalKind };

export interface Profile {
  id: string;
  name: string;
  configDir: string;
  managed: boolean;
  env: Record<string, string>;
  color: string;
  hooksOk: boolean;
}

export interface TerminalRecord {
  id: string;
  kind: TerminalKind;
  name: string | null;
  claude_session_id: string | null;
  created_at: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  profile_id: string;
  cwd: string;
  created_at: string;
  terminals: TerminalRecord[];
}

export interface AppSettings {
  claude_bin: string | null;
  notifications: boolean;
  font_size: number;
}

export interface NewProject {
  projectId: string;
  terminalId: string;
}

export const listProfiles = () => invoke<Profile[]>("list_profiles");
export const createProfile = (name: string) => invoke<Profile>("create_profile", { name });
export const importProfile = (name: string, dir: string) => invoke<Profile>("import_profile", { name, dir });
export const updateProfile = (profile: Profile) => invoke<void>("update_profile", { profile });
export const deleteProfile = (id: string) => invoke<void>("delete_profile", { id });
export const listProjects = () => invoke<ProjectView[]>("list_projects");
export const newProject = (profileId: string, cwd: string, name?: string | null, resumeId?: string | null) =>
  invoke<NewProject>("new_project", { profileId, cwd, name: name ?? null, resumeId: resumeId ?? null });
export const addTerminal = (projectId: string, kind: TerminalKind, resumeId?: string | null) =>
  invoke<string>("add_terminal", { projectId, kind, resumeId: resumeId ?? null });
export const writeStdin = (id: string, dataB64: string) => invoke<void>("write_stdin", { id, dataB64 });
export const resizeTerminal = (id: string, cols: number, rows: number) =>
  invoke<void>("resize_terminal", { id, cols, rows });
export const reorderProjects = (ids: string[]) => invoke<void>("reorder_projects", { ids });
export const renameProject = (id: string, name: string) => invoke<void>("rename_project", { id, name });
export const renameTerminal = (id: string, name: string) => invoke<void>("rename_terminal", { id, name });
export const closeTerminal = (id: string) => invoke<void>("close_terminal", { id });
export const closeProject = (id: string) => invoke<void>("close_project", { id });
export const recentFolders = (profileId: string) => invoke<string[]>("recent_folders", { profileId });
export const previousProjects = () => invoke<ProjectRecord[]>("previous_projects");
export const discardPrevious = () => invoke<void>("discard_previous");
export const getSettings = () => invoke<AppSettings>("get_settings");
export const openUrl = (url: string) => invoke<void>("open_url", { url });
export const setSettings = (settings: AppSettings) => invoke<void>("set_settings", { settings });
export const checkClaude = () => invoke<string | null>("check_claude");

export interface UpdateInfo {
  installed: string | null;
  latest: string | null;
  needsUpgrade: boolean;
  needsRestart: boolean;
}
export const autoRestore = () => invoke<boolean>("auto_restore");
export const checkClaudeUpdate = () => invoke<UpdateInfo>("check_claude_update");
export const updateClaude = () => invoke<void>("update_claude");
export const checkSonicUpdate = () => invoke<string | null>("check_sonic_update");
export const updateSonic = () => invoke<void>("update_sonic");
export const restartWithSessions = () => invoke<void>("restart_with_sessions");
export const setBadge = (count: number) => invoke<void>("set_badge", { count });
export const revealInFinder = (path: string) => invoke<void>("reveal_in_finder", { path });
export const copyText = (text: string) => invoke<void>("copy_text", { text });

export const onProjectsChanged = (fn: (p: ProjectView[]) => void) =>
  listen<ProjectView[]>("projects-changed", e => fn(e.payload));
export const onTerminalData = (fn: (id: string, dataB64: string) => void) =>
  listen<{ id: string; dataB64: string }>("terminal-data", e => fn(e.payload.id, e.payload.dataB64));
export const onTerminalStatus = (fn: (id: string, status: Status) => void) =>
  listen<{ id: string; status: Status }>("terminal-status", e => fn(e.payload.id, e.payload.status));
export const onMenu = (fn: (id: string) => void) => listen<string>("menu", e => fn(e.payload));
