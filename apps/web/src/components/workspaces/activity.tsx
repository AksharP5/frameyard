/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { ToolArgs, ToolOutput } from '@diffusionstudio/dapi';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { mainBridge } from '@/lib/ipc';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogPortal, DialogTitle } from '@/components/ui/dialog';

type Workspace = ToolOutput<'workspace'>['workspaces'][number];
const [open, setOpen] = createSignal(false);
const [state, setState] = createStore<{ workspaces: Workspace[] }>({ workspaces: [] });

export function WorkspaceActivityButton() {
  const active = () => state.workspaces.filter(workspace => workspace.agentActive || workspace.jobs.length > 0).length;
  return <Show when={window.desktop}>
    <Button variant="ghost" class="relative z-30 text-muted-foreground" style="-webkit-app-region: no-drag;"
      onClick={() => setOpen(true)} aria-label="Project activity">
      Activity{active() ? ` (${active()})` : ''}
    </Button>
  </Show>;
}

export function WorkspaceActivity() {
  const [error, setError] = createSignal<string>();
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = createSignal(false);
  let disposed = false;
  let receivedEvent = false;

  onMount(() => {
    if (!window.desktop) return;
    const unsubscribe = mainBridge.handle(MAIN_CHANNELS.WORKSPACES_CHANGED, result => {
      receivedEvent = true;
      setState('workspaces', reconcile(result.workspaces, { key: 'dir' }));
    });
    onCleanup(unsubscribe);
    void mainBridge.call(MAIN_CHANNELS.WORKSPACES_LIST, undefined).then(result => {
      if (!disposed && !receivedEvent) setState('workspaces', reconcile(result.workspaces, { key: 'dir' }));
    }).catch(failure => {
      if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
    });
  });
  onCleanup(() => { disposed = true; });

  const act = async (args: ToolArgs<'workspace'>) => {
    const dir = args.dir;
    if (dir && pending().has(dir)) return false;
    setError(undefined);
    if (dir) setPending(previous => new Set([...previous, dir]));
    try {
      await mainBridge.call(MAIN_CHANNELS.WORKSPACES_ACTION, args);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      if (dir) setPending(previous => new Set([...previous].filter(value => value !== dir)));
    }
  };

  const add = async () => {
    setAdding(true);
    setError(undefined);
    try {
      const dir = await mainBridge.call(MAIN_CHANNELS.PROJECTS_PICK_FOLDER, undefined);
      if (dir) await act({ action: 'open', dir });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setAdding(false); }
  };

  return <Show when={window.desktop}>
    <Dialog open={open()} onOpenChange={setOpen}>
      <DialogPortal><DialogContent class="sm:max-w-2xl">
        <DialogTitle>Project activity</DialogTitle>
        <DialogDescription class="text-xs">Agents work independently in each project. Heavy jobs may wait for available resources.</DialogDescription>
        <Show when={error()}>{message => <p role="alert" class="text-xs text-destructive">{message()}</p>}</Show>
        <div class="max-h-[60vh] overflow-y-auto divide-y divide-border">
          <For each={state.workspaces} fallback={<p class="py-6 text-xs text-muted-foreground">No projects running.</p>}>
            {workspace => <WorkspaceRow workspace={workspace} busy={pending().has(workspace.dir)} act={act} />}
          </For>
        </div>
        <div class="flex justify-end"><Button variant="secondary" disabled={adding()} onClick={() => void add()}>Open project in background</Button></div>
      </DialogContent></DialogPortal>
    </Dialog>
  </Show>;
}

function WorkspaceRow(props: {
  workspace: Workspace;
  busy: boolean;
  act: (args: ToolArgs<'workspace'>) => Promise<boolean>;
}) {
  const [draft, setDraft] = createSignal('');
  const active = () => props.workspace.agentActive || props.workspace.jobs.length > 0;
  const send = async (event: SubmitEvent) => {
    event.preventDefault();
    const message = draft().trim();
    if (!message) return;
    if (await props.act({ action: 'send', dir: props.workspace.dir, message })) setDraft('');
  };

  return <section class="py-4 space-y-2" aria-label={props.workspace.name}>
    <div class="flex items-center gap-3">
      <div class="min-w-0 flex-1">
        <p class="truncate text-xs font-450">{props.workspace.name}</p>
        <p class="truncate text-xxs text-muted-foreground" title={props.workspace.dir}>{props.workspace.dir}</p>
      </div>
      <span class="text-xxs text-muted-foreground">{props.workspace.visible ? 'Visible · ' : ''}{props.workspace.status}</span>
      <Button variant="ghost" disabled={props.busy} onClick={() => void props.act({ action: 'show', dir: props.workspace.dir })}>Review</Button>
      <Show when={active()} fallback={
        <Button variant="ghost" disabled={props.busy} onClick={() => void props.act({ action: 'close', dir: props.workspace.dir })}>Close</Button>
      }>
        <Button variant="ghost" disabled={props.busy} onClick={() => void props.act({ action: 'cancel', dir: props.workspace.dir })}>Cancel work</Button>
      </Show>
    </div>
    <Show when={props.workspace.error}>{message => <p role="alert" class="text-xs text-destructive">{message()}</p>}</Show>
    <For each={props.workspace.jobs}>{job => <p class="text-xxs text-muted-foreground">{job.tool}: {job.state}</p>}</For>
    <form class="flex gap-2" onSubmit={event => void send(event)}>
      <input aria-label={`Task for ${props.workspace.name}`} placeholder="Give Codex a task" value={draft()}
        onInput={event => setDraft(event.currentTarget.value)}
        class="min-w-0 flex-1 rounded border border-border-input bg-transparent px-2 py-1 text-xs focus-ring"
        disabled={props.busy || props.workspace.agentActive || props.workspace.status === 'loading'} />
      <Button type="submit" variant="secondary" disabled={props.busy || props.workspace.agentActive || props.workspace.status === 'loading' || !draft().trim()}>Send</Button>
    </form>
  </section>;
}
