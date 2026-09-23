/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useNavigate } from "@solidjs/router";
import {
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
} from "solid-js";
import { toast } from "somoto";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Composer } from "@/agent-chat/composer";
import { createCodexCapabilities } from "@/components/agent/use-codex-capabilities";
import type { CodexSkill } from "@desktop/codex-capabilities";
import { localMode } from "@/lib/local-mode";
import {
  attachmentPaths,
  currentModel,
  setStoredModel,
  startChat,
  type Attachment,
} from "@/agent-chat";
import { projectRoute, useReturnHere } from "@/hooks/use-project-route";
import { track } from "@/lib/analytics";
import { generateProjectName } from "@/lib/db";
import {
  createProject,
  ensureProjectsRoot,
  isDesktop,
  listProjects,
  openProjectFolder,
  pickProjectFolder,
  projectKey,
  projectsRevision,
  projectsRoot,
  type ProjectInfo,
} from "@/projects";

import { DeleteProjectDialog } from "./delete-project-dialog";
import { DashboardProjectCard } from "./project-card";
import {
  DashboardCardButton,
  DashboardCardMeta,
  DashboardCardPreview,
  createBackgroundClickHandler,
  createNewProject,
  openProjectFromList,
} from "./shared";
import { parseTimestamp } from "./utils";

/**
 * Where the prompt lands: a project chosen from the recents, a folder chosen
 * from the picker — any folder will do, `resolveTarget` makes it a Diffusion
 * Studio project — or, until either is chosen, a fresh project under the
 * application folder.
 */
type PromptTarget =
  | { kind: "new" }
  | { kind: "project"; project: ProjectInfo }
  | { kind: "folder"; dir: string };

/** Cards that fit the one row the design gives recents, the new one included. */
const RECENT_COLUMNS = 5;

/** Recent projects the target menu offers before it gets unwieldy. */
const MENU_PROJECTS = 8;


export function DashboardHomeView() {
  const navigate = useNavigate();
  const returnHere = useReturnHere();

  const [prompt, setPrompt] = createSignal("");
  const [target, setTarget] = createSignal<PromptTarget>({ kind: "new" });
  const [selectedProject, setSelectedProject] = createSignal<string | null>(
    null,
  );
  const [busy, setBusy] = createSignal(false);
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);

  const [skills, setSkills] = createSignal<CodexSkill[]>([]);

  // The projects the app knows — created here, or opened from a folder —
  // refetched whenever that list changes.
  const [projects, { refetch: refetchProjects }] = createResource(
    projectsRevision,
    () => listProjects(),
  );
  // The model is shared with the chat panel and remembered across sessions;
  // the picker is fed by the agent host's probes, so what it offers is what
  // is installed and signed in.
  const model = createMemo(() => currentModel());
  const capabilities = createCodexCapabilities(() => {
    const current = target();
    return current.kind === "project" ? current.project.dir : current.kind === "folder" ? current.dir : projectsRoot();
  }, () => localMode && isDesktop() && model()?.harness === "codex");

  const recentProjects = createMemo(() =>
    [...(projects() ?? [])].sort(
      (a, b) => parseTimestamp(b.modifiedAt) - parseTimestamp(a.modifiedAt),
    ),
  );

  const targetLabel = () => {
    const current = target();
    if (current.kind === "project") return current.project.displayName;
    if (current.kind === "folder") return folderName(current.dir);
    return "Choose project";
  };

  const canSubmit = () => !!(prompt().trim() || attachments().length || skills().length) && !busy() && model() !== null;

  const handlePickFolder = async () => {
    try {
      const dir = await pickProjectFolder();
      if (dir) setTarget({ kind: "folder", dir });
    } catch (e) {
      toast.error("Failed to choose folder", {
        description: (e as Error).message,
      });
    }
  };

  /**
   * The folder the agent will work in. A picked folder is opened as a project,
   * which scaffolds an entry into it when it is not one already — so any
   * folder on disk can be the answer, not only a project we made. With none
   * picked, a fresh project under the application folder.
   */
  const resolveTarget = async (): Promise<ProjectInfo | null> => {
    const current = target();
    // A project off the list is its record; the folder is looked at now.
    if (current.kind === "project") return openProjectFromList(current.project);
    if (current.kind === "folder") return openProjectFolder(current.dir);

    // Waits for the roots to come back from the database, and asks for one
    // when there is none to wait for.
    if (!(await ensureProjectsRoot())) return null;
    return createProject(generateProjectName());
  };

  const handleSubmit = async () => {
    if (!canSubmit()) return;

    if (!isDesktop()) {
      toast.error("Projects on disk are only available in the desktop app");
      return;
    }

    const attached = attachments();
    const selectedSkills = skills();
    const paths = attachmentPaths(attached);
    const ref = model();
    if (!ref) return;
    const text = prompt();
    setBusy(true);

    try {
      const project = await resolveTarget();
      if (!project) return;

      track("home_prompt_sent", {
        agent: `${ref.harness}/${ref.model}`,
        target: target().kind,
        attachments: paths.length,
      });
      // The chat starts before the page switches: the host has the turn as
      // soon as it answers, and the editor lands with the reply streaming.
      // On failure the text survives as the project's draft (see startChat).
      await startChat({ project, text, attachments: paths, model: ref, skills: selectedSkills });
      setPrompt("");
      setAttachments([]);
      setSkills([]);
      setTarget({ kind: "new" });
      refetchProjects();
      navigate(projectRoute(projectKey(project)), { state: returnHere() });
    } catch (e) {
      toast.error("Could not open the project", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  // Anything outside a card clears the selection — the grid's gaps, the space
  // around it, and the composer above it. A click on a card is that card's.
  const clearSelection = createBackgroundClickHandler(() =>
    setSelectedProject(null),
  );

  const [pendingDelete, setPendingDelete] = createSignal<ProjectInfo | null>(null);

  const handleDeleted = (project: ProjectInfo) => {
    setSelectedProject((current) => (current === project.dir ? null : current));
    refetchProjects();
  };

  const openProject = async (project: ProjectInfo) => {
    const found = await openProjectFromList(project);
    if (!found) return;
    track("project_opened");
    navigate(projectRoute(projectKey(found)), { state: returnHere() });
  };

  const handleCreateProject = async () => {
    if (busy()) return;
    setBusy(true);

    try {
      const project = await createNewProject();
      if (!project) return;
      setSelectedProject(null);
      refetchProjects();
      openProject(project);
    } catch (e) {
      toast.error("Failed to create project", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        class="flex min-h-0 flex-1 flex-col overflow-y-auto"
        onClick={clearSelection}
      >
        <div class="flex flex-1 flex-col items-center justify-center gap-6.5 px-6 py-8 pt-[15%]">
          <h1 class="w-full text-center text-5xl leading-normal font-450 tracking-[0.0864px] text-muted-foreground">
            What should we edit?
          </h1>

          <div class="flex w-full max-w-149 flex-col items-center" inert={busy()} aria-busy={busy()}>
            <div class="flex w-[calc(100%-40px)] flex-col items-start rounded-t-xl border border-b-0 border-border bg-accent/50 px-1 pt-1 pb-0.5">
              <DropdownMenu placement="bottom-start">
                <DropdownMenuTrigger
                  as="button"
                  type="button"
                  aria-label="Choose the folder to work in"
                  class="flex h-7 shrink-0 items-center rounded-md pl-0.5 pr-2 text-xs font-450 text-muted-foreground hover:bg-accent focus-ring"
                >
                  <span class="grid size-6 shrink-0 place-items-center overflow-clip">
                    <Icon name="navigation.folder" />
                  </span>
                  <span class="max-w-60 truncate">{targetLabel()}</span>
                  <span class="grid h-7 w-5 shrink-0 place-items-center overflow-clip">
                    <Icon name="chevron-down" />
                  </span>
                </DropdownMenuTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuContent class="w-60">
                    {/* One action, not a new/open pair: the picker takes any
                        folder, and a folder that is not a project yet becomes
                        one when the prompt is sent. */}
                    <DropdownMenuGroup>
                      <DropdownMenuItem onSelect={handlePickFolder}>
                        <Icon name="plus-add" />
                        <span class="min-w-0 flex-1 truncate">
                          Create project...
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <Show when={recentProjects().length > 0}>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuGroupLabel>
                          Recent projects
                        </DropdownMenuGroupLabel>
                        <For each={recentProjects().slice(0, MENU_PROJECTS)}>
                          {(project) => (
                            <DropdownMenuItem
                              onSelect={() =>
                                setTarget({ kind: "project", project })
                              }
                            >
                              <Icon name="navigation.folder" />
                              <span class="min-w-0 flex-1 truncate">
                                {project.displayName}
                              </span>
                            </DropdownMenuItem>
                          )}
                        </For>
                      </DropdownMenuGroup>
                    </Show>
                  </DropdownMenuContent>
                </DropdownMenuPortal>
              </DropdownMenu>
            </div>

            <Composer
              variant="home"
              text={prompt()}
              onText={(text) => !busy() && setPrompt(text)}
              attachments={attachments()}
              onAttachments={(items) => !busy() && setAttachments(items)}
              running={false}
              waiting={false}
              blocked={busy() ? "Opening chat…" : null}
              sendDisabled={busy()}
              hasContent={!!(prompt().trim() || attachments().length || skills().length)}
              model={model()}
              onModel={setStoredModel}
              onSend={() => void handleSubmit()}
              onStop={() => {}}
              label="Describe the edit you want"
              placeholder="Describe an edit, or type $ to use a skill…"
              catalog={capabilities}
              skills={skills()}
              onSkills={(items) => !busy() && setSkills(items)}
            />
          </div>
        </div>

        <div class="flex shrink-0 flex-col">
          <div class="flex items-end gap-6 px-6 pt-4 pb-3">
            <h2 class="min-w-0 flex-1 text-2xl leading-6 font-450 text-foreground">
              Recents
            </h2>
          </div>
          <div
            data-slot="card-grid"
            class="grid grid-cols-5 items-start gap-x-0.5 gap-y-3 px-4 pb-4"
          >
            <DashboardCardButton onClick={handleCreateProject}>
              <DashboardCardPreview class="bg-overlay-soft group-hover:bg-overlay">
                <Icon
                  name="plus-add"
                  class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-muted-foreground"
                />
              </DashboardCardPreview>
              <DashboardCardMeta title="New project" />
            </DashboardCardButton>
            <For each={recentProjects().slice(0, RECENT_COLUMNS - 1)}>
              {(project) => (
                <DashboardProjectCard
                  project={project}
                  active={selectedProject() === project.dir}
                  onSelect={() => setSelectedProject(project.dir)}
                  onDeselect={() => setSelectedProject(null)}
                  onOpen={() => openProject(project)}
                  onDelete={() => setPendingDelete(project)}
                  onChanged={refetchProjects}
                />
              )}
            </For>
          </div>
        </div>
      </div>

      <DeleteProjectDialog
        project={pendingDelete()}
        onClose={() => setPendingDelete(null)}
        onDeleted={handleDeleted}
      />
    </>
  );
}

/** The last segment of a path, for naming a folder the user picked. */
function folderName(dir: string): string {
  return (
    dir
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || dir
  );
}
