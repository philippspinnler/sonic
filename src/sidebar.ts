import { getState, select, subscribe, SessionView } from "./store";
import { renameSession, revealInFinder, copyText, startSession, closeSession } from "./ipc";
import { showContextMenu } from "./contextMenu";
import { closeSessionWithConfirm, shortenHome } from "./actions";

export function renderSidebar(): void {
  const el = document.getElementById("sidebar")!;
  el.innerHTML = "";
  const list = document.createElement("div");
  list.className = "session-list";
  const { sessions, selectedId } = getState();

  for (const s of sessions) {
    const row = document.createElement("div");
    row.className =
      "session-row" +
      (s.id === selectedId ? " selected" : "") +
      (s.status === "waiting" ? " waiting" : "");
    row.innerHTML = `
      <span class="dot ${s.status}"></span>
      <span class="row-main">
        <span class="row-name"></span>
        <span class="row-sub">
          <span class="tag"></span>
          <span class="folder"><bdi></bdi></span>
        </span>
      </span>`;
    row.querySelector<HTMLElement>(".row-name")!.textContent = s.name;
    const tag = row.querySelector<HTMLElement>(".tag")!;
    tag.textContent = s.profileName;
    tag.style.color = s.profileColor;
    tag.style.borderColor = s.profileColor;
    const folder = row.querySelector<HTMLElement>(".folder")!;
    folder.querySelector("bdi")!.textContent = shortenHome(s.cwd);
    folder.title = s.cwd;
    row.addEventListener("click", () => select(s.id));
    row.querySelector(".row-name")!.addEventListener("dblclick", e => {
      e.stopPropagation();
      startRename(row, s.id, s.name);
    });
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      select(s.id);
      showContextMenu(e.clientX, e.clientY, contextItems(s));
    });
    if (s.status === "exited") {
      const bar = document.createElement("span");
      bar.className = "restart";
      bar.textContent = "↻";
      bar.title = "Restart in same folder";
      bar.addEventListener("click", async e => {
        e.stopPropagation();
        await closeSession(s.id);
        const id = await startSession(s.profileId, s.cwd, null, s.name);
        select(id);
      });
      row.appendChild(bar);
    }
    list.appendChild(row);
  }
  el.appendChild(list);

  const footer = document.createElement("div");
  footer.className = "sidebar-footer";
  footer.innerHTML = `<button id="btn-new">＋ New session</button><button id="btn-settings">⚙</button>`;
  el.appendChild(footer);
  footer.querySelector("#btn-new")!.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("sonic:new-session")),
  );
  footer.querySelector("#btn-settings")!.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("sonic:settings")),
  );
}

function contextItems(s: SessionView) {
  return [
    {
      label: "Rename…",
      action: () => {
        const row = [...document.querySelectorAll<HTMLElement>(".session-row")].find(
          r => r.querySelector(".row-name")?.textContent === s.name,
        );
        if (row) startRename(row, s.id, s.name);
      },
    },
    { label: "Reveal folder in Finder", action: () => void revealInFinder(s.cwd) },
    { label: "Copy folder path", action: () => void copyText(s.cwd) },
    { label: "Close session", danger: true, action: () => void closeSessionWithConfirm(s) },
  ];
}

function startRename(row: HTMLElement, id: string, current: string): void {
  const nameEl = row.querySelector<HTMLElement>(".row-name")!;
  const input = document.createElement("input");
  input.value = current;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    void renameSession(id, input.value.trim() || current);
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") {
      done = true;
      input.replaceWith(nameEl);
    }
    e.stopPropagation();
  });
  input.addEventListener("blur", commit);
}

subscribe(renderSidebar);
