import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import type { CodexCapabilities } from "@desktop/codex-capabilities";

/** Share one catalog between the skill suggestions and the capabilities picker. */
export function createCodexCapabilities(directory: Accessor<string | null | undefined>, enabled: Accessor<boolean> = () => true) {
  const [result, setResult] = createSignal<CodexCapabilities>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  let revision = 0;
  let pending: Promise<void> | undefined;

  createEffect(() => {
    directory();
    enabled();
    revision++;
    pending = undefined;
    setResult(undefined);
    setError("");
    setLoading(false);
  });
  onCleanup(() => { revision++; });

  const load = (refresh = false): Promise<void> => {
    const dir = directory();
    if (!enabled() || !dir || (result() && !refresh)) return Promise.resolve();
    if (pending) return pending;
    const current = ++revision;
    setLoading(true);
    setError("");
    pending = mainBridge.call(MAIN_CHANNELS.CODEX_REQUEST, { method: "capabilities", input: { dir } }).then((response) => {
      if (current === revision && response.method === "capabilities") setResult(response.result);
    }).catch((cause: unknown) => {
      if (current === revision) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (current !== revision) return;
      pending = undefined;
      setLoading(false);
    });
    return pending;
  };

  return { result, loading, error, load, directory, enabled };
}

export type SkillCatalog = ReturnType<typeof createCodexCapabilities>;
