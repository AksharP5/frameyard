import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAPI_WIRE } from '@diffusionstudio/dapi';
import type { DapiCall } from '@diffusionstudio/dapi';
import type { Handlers, ToolContext } from './handler';
import type { EditorSession } from './session';

const listeners = new Map<string, (data: unknown) => void>();
const send = vi.fn();

async function bridge() {
  vi.resetModules();
  vi.stubGlobal('window', { desktop: { on: (channel: string, listener: (data: unknown) => void) => listeners.set(channel, listener), send } });
  return (await import('./bridge')).toolBridge;
}
const call: DapiCall = { id: 'capture', tool: 'context', args: {}, awaitCleanup: true };
const context = (signal: AbortSignal): ToolContext => ({ signal, session: () => null, requireSession: () => { throw new Error('No project'); }, app: { openProject: async () => { throw new Error('Not used'); }, user: () => null, requireUser: () => { throw new Error('Not used'); } } });

describe('tool cancellation acknowledgement', () => {
  beforeEach(() => { listeners.clear(); send.mockClear(); });
  afterEach(() => vi.unstubAllGlobals());

  it('acknowledges a canceled dispatched operation only after its cleanup completes', async () => {
    const instance = await bridge();
    let finish: (() => void) | undefined;
    const cleaned = new Promise<void>((resolve) => { finish = resolve; });
    const handler = vi.fn(async (_args: unknown, ctx: ToolContext) => {
      expect(ctx.awaitTracking).toBe(true);
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
      await cleaned;
      throw new Error('Canceled after cleanup');
    });
    instance.register({ context: handler } as unknown as Handlers, context);
    listeners.get(DAPI_WIRE.CALL)!(call);
    listeners.get(DAPI_WIRE.CANCEL)!({ id: call.id });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    finish!();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(DAPI_WIRE.REPLY, expect.objectContaining({ id: call.id, ok: false })));
  });

  it('acknowledges bootstrap cancellation without dispatching the held call', async () => {
    const instance = await bridge();
    listeners.get(DAPI_WIRE.CALL)!(call);
    listeners.get(DAPI_WIRE.CANCEL)!({ id: call.id });
    const handler = vi.fn();
    instance.register({ context: handler } as unknown as Handlers, context);
    expect(handler).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(DAPI_WIRE.REPLY, expect.objectContaining({ id: call.id, ok: false }));
  });
});


it('rejects a scoped tool when the renderer belongs to another project', async () => {
  listeners.clear(); send.mockClear();
  const instance = await bridge();
  const handler = vi.fn();
  const session = { project: { dir: () => '/projects/other' } } as EditorSession;
  instance.register({ context: handler } as unknown as Handlers, signal => ({ ...context(signal), session: () => session }));
  listeners.get(DAPI_WIRE.CALL)!({ ...call, args: { project: '/projects/expected' } });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith(DAPI_WIRE.REPLY, expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'no-project' }) })));
  expect(handler).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
