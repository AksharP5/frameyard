import { expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: { generate: { mutate: vi.fn() } } }));

import { api } from './api';
import { runJob } from './jobs';

it('does not start a provider job when the request was already canceled', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Canceled before submission'));
  const update = vi.fn();

  await expect(runJob({ model: 'gpt-image-2.5-sunburst', prompt: 'A square' }, update, controller.signal)).rejects.toThrow('Canceled before submission');
  expect(api.generate.mutate).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
