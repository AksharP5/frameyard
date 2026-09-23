import { For, Match, Show, Switch, createSignal } from "solid-js";
import { formChoices, type CodexFormField, type CodexFormValue, type CodexPendingRequest, type CodexRequestResponse } from "@desktop/codex-requests";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { Button } from "@/components/ui/button";

const inputClass = "w-full rounded border border-border-input bg-transparent px-2 py-1.5 text-xs";

function FormField(props: { name: string; field: CodexFormField; required: boolean; disabled: boolean; value: CodexFormValue | undefined; onChange: (value: CodexFormValue | undefined) => void }) {
  const choices = () => formChoices(props.field);
  return <fieldset class="min-w-0 flex flex-col gap-1.5 text-xs" disabled={props.disabled}>
    <legend class="mb-1.5">{props.field.title ?? props.name}{props.required ? " *" : ""}</legend>
    <Show when={props.field.description}><span class="text-muted-foreground">{props.field.description}</span></Show>
    <Switch fallback={<input aria-label={props.field.title ?? props.name} class={inputClass} required={props.required} value={typeof props.value === "string" ? props.value : ""}
      type={props.field.format === "email" ? "email" : props.field.format === "date" ? "date" : "text"}
      minLength={props.field.minLength} maxLength={props.field.maxLength}
      onInput={(event) => props.onChange(event.currentTarget.value || undefined)} />}>
      <Match when={props.field.type === "boolean"}>
        <select aria-label={props.field.title ?? props.name} class={inputClass} required={props.required} value={props.value === undefined ? "" : String(props.value)} onChange={(event) => props.onChange(event.currentTarget.value === "" ? undefined : event.currentTarget.value === "true")}>
          <option value="">Choose</option><option value="true">Yes</option><option value="false">No</option>
        </select>
      </Match>
      <Match when={props.field.type === "number" || props.field.type === "integer"}>
        <input aria-label={props.field.title ?? props.name} class={inputClass} required={props.required} type="number" step={props.field.type === "integer" ? "1" : "any"} min={props.field.minimum} max={props.field.maximum}
          value={typeof props.value === "number" ? props.value : ""} onInput={(event) => props.onChange(event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber)} />
      </Match>
      <Match when={props.field.type === "array"}>
        <For each={choices()}>{(choice) => <label class="flex items-center gap-2">
          <input type="checkbox" checked={Array.isArray(props.value) && props.value.includes(choice.value)} onChange={(event) => {
            const values = Array.isArray(props.value) ? props.value : [];
            props.onChange(event.currentTarget.checked ? [...values, choice.value] : values.filter((value) => value !== choice.value));
          }} />{choice.label}
        </label>}</For>
      </Match>
      <Match when={choices()}>
        <select aria-label={props.field.title ?? props.name} class={inputClass} required={props.required} value={typeof props.value === "string" ? props.value : ""} onChange={(event) => props.onChange(event.currentTarget.value || undefined)}>
          <option value="">Choose</option><For each={choices()}>{(choice) => <option value={choice.value}>{choice.label}</option>}</For>
        </select>
      </Match>
    </Switch>
  </fieldset>;
}

export function CodexRequest(props: { request: CodexPendingRequest; onRespond: (response: CodexRequestResponse) => Promise<void> }) {
  const [answers, setAnswers] = createSignal<Record<string, string[]>>({});
  const [other, setOther] = createSignal<Record<string, boolean>>({});
  const [content, setContent] = createSignal<Record<string, CodexFormValue>>(props.request.kind === "form"
    ? Object.fromEntries(Object.entries(props.request.schema.properties).flatMap(([key, field]) => field.default === undefined ? [] : [[key, field.default]])) : {});
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [opened, setOpened] = createSignal(false);
  async function respond(response: CodexRequestResponse) {
    if (busy()) return;
    setBusy(true);
    setError("");
    await props.onRespond(response).catch((error: unknown) => setError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
  }
  async function openUrl(url: string) {
    if (!/^https?:\/\//i.test(url)) { setError("Unsupported URL scheme"); return; }
    await mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url }).then(() => setOpened(true)).catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
  }
  return <form class="min-w-0 flex flex-col gap-3 border-y border-border py-3 text-xs break-words" onSubmit={(event) => {
    event.preventDefault();
    void respond(props.request.kind === "input" ? { action: "accept", answers: answers() } : props.request.kind === "form" ? { action: "accept", content: content() } : { action: "accept", scope: "turn" });
  }}>
    <Switch>
      <Match when={props.request.kind === "input" ? props.request : undefined}>{(request) => <>
        <For each={request().questions}>{(question) => <fieldset class="min-w-0 flex flex-col gap-2" disabled={busy()}>
          <legend class="mb-2 font-medium">{question.question}</legend>
          <For each={question.options ?? []}>{(option) => <label class="flex items-start gap-2">
            <input class="mt-0.5" type="radio" required name={`${request().id}-${question.id}`} checked={!other()[question.id] && answers()[question.id]?.[0] === option.label}
              onChange={() => { setOther((value) => ({ ...value, [question.id]: false })); setAnswers((value) => ({ ...value, [question.id]: [option.label] })); }} />
            <span>{option.label}<span class="mt-0.5 block text-muted-foreground">{option.description}</span></span>
          </label>}</For>
          <Show when={question.isOther && question.options?.length}><label class="flex items-center gap-2">
            <input type="radio" name={`${request().id}-${question.id}`} checked={other()[question.id] ?? false} onChange={() => { setOther((value) => ({ ...value, [question.id]: true })); setAnswers((value) => ({ ...value, [question.id]: [""] })); }} />Other
          </label></Show>
          <Show when={!question.options?.length || other()[question.id]}>
            <input aria-label={question.header || question.question} class={inputClass} type={question.isSecret ? "password" : "text"} autocomplete="off" required value={answers()[question.id]?.[0] ?? ""}
              onInput={(event) => setAnswers((value) => ({ ...value, [question.id]: [event.currentTarget.value] }))} />
          </Show>
        </fieldset>}</For>
      </>}</Match>
      <Match when={props.request.kind === "permissions" ? props.request : undefined}>{(request) => <>
        <p class="font-medium">Allow additional permissions?</p>
        <Show when={request().reason}><p>{request().reason}</p></Show>
        <p class="break-all text-muted-foreground">{request().cwd}</p>
        <Show when={request().permissions.network}><p>Network: {request().permissions.network?.enabled === true ? "enabled" : request().permissions.network?.enabled === false ? "disabled" : "unspecified"}</p></Show>
        <Show when={request().permissions.fileSystem}>{(filesystem) => <>
          <For each={filesystem().read ?? []}>{(path) => <p class="break-all">Read: {path}</p>}</For>
          <For each={filesystem().write ?? []}>{(path) => <p class="break-all">Write: {path}</p>}</For>
          <For each={filesystem().entries ?? []}>{(entry) => <p class="break-all">{entry.access}: {entry.path.type === "path" ? entry.path.path : entry.path.type === "glob_pattern" ? entry.path.pattern : JSON.stringify(entry.path.value)}</p>}</For>
          <Show when={filesystem().globScanMaxDepth !== undefined}><p>Glob scan depth: {filesystem().globScanMaxDepth}</p></Show>
        </>}</Show>
      </>}</Match>
      <Match when={props.request.kind === "form" ? props.request : undefined}>{(request) => <>
        <p class="font-medium">{request().serverName}</p><p>{request().message}</p>
        <For each={Object.entries(request().schema.properties)}>{([name, field]) => <FormField name={name} field={field} required={request().schema.required?.includes(name) ?? false} disabled={busy()} value={content()[name]} onChange={(value) => setContent((previous) => {
          const next = { ...previous };
          if (value === undefined) delete next[name]; else next[name] = value;
          return next;
        })} />}</For>
      </>}</Match>
      <Match when={props.request.kind === "url" ? props.request : undefined}>{(request) => <>
        <p class="font-medium">{request().serverName}</p><p>{request().message}</p>
        <button type="button" class="break-all text-left underline" onClick={() => void openUrl(request().url)}>{request().url}</button>
      </>}</Match>
      <Match when={props.request.kind === "unsupported" ? props.request : undefined}>{(request) => <>
        <p class="font-medium">{request().serverName}</p><p>{request().message}</p><p role="alert" class="text-destructive">{request().error}</p>
      </>}</Match>
    </Switch>
    <Show when={error()}><p role="alert" class="text-destructive">{error()}</p></Show>
    <div class="flex flex-wrap gap-2">
      <Show when={props.request.kind !== "unsupported"}><Button type="submit" disabled={busy() || (props.request.kind === "url" && !opened())}>
        {props.request.kind === "permissions" ? "Allow for turn" : props.request.kind === "url" ? "Done" : "Submit"}
      </Button></Show>
      <Show when={props.request.kind === "permissions"}><Button type="button" variant="outline" disabled={busy()} onClick={() => void respond({ action: "accept", scope: "session" })}>Allow for session</Button></Show>
      <Button type="button" variant="ghost" disabled={busy()} onClick={() => void respond({ action: props.request.kind === "input" ? "cancel" : "decline" })}>{props.request.kind === "input" ? "Skip" : "Decline"}</Button>
    </div>
  </form>;
}
