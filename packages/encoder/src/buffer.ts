/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BufferTarget, StreamTarget, Target } from 'mediabunny';

import type { ContainerFormat, WritableFileTarget } from './types';
import type { StreamTargetChunk } from 'mediabunny';

export class TargetBuffer {
  public target: Target;
  public fastStart: false | 'in-memory';
  public handle: FileSystemFileHandle | WritableFileTarget | undefined;
  private writer: WritableStreamDefaultWriter<StreamTargetChunk> | undefined;

  public constructor(
    target: StreamTarget | BufferTarget,
    fastStart: false | 'in-memory',
    handle: FileSystemFileHandle | WritableFileTarget | undefined,
    writer?: WritableStreamDefaultWriter<StreamTargetChunk>,
  ) {
    this.target = target;
    this.fastStart = fastStart;
    this.handle = handle;
    this.writer = writer;
  }

  public static async create(
    handle?: FileSystemFileHandle | WritableFileTarget
  ): Promise<TargetBuffer> {
    if (handle) {
      const fileStream = await handle.createWritable();
      const writer = fileStream.getWriter();
      // Mediabunny closes its stream on cancel as well as finalize. Only a
      // successful encode may close the real file stream and commit its bytes.
      const stream = new WritableStream<StreamTargetChunk>({
        write: (chunk) => writer.write(chunk),
      });
      return new TargetBuffer(new StreamTarget(stream, { chunked: true }), false, handle, writer);
    }

    return new TargetBuffer(new BufferTarget(), 'in-memory', undefined);
  }

  public async close(format: ContainerFormat = 'mp4'): Promise<Blob | undefined> {
    if (this.writer) {
      await this.writer.close();
      this.writer.releaseLock();
      this.writer = undefined;
    }
    if (this.fastStart === 'in-memory' && this.target instanceof BufferTarget) {
      if (!this.target.buffer) return;
      return new Blob([this.target.buffer], { type: mimeTypes[format] });
    }

    return undefined;
  }

  public async abort(): Promise<void> {
    const writer = this.writer;
    if (!writer) return;
    this.writer = undefined;
    try { await writer.abort(); }
    finally { writer.releaseLock(); }
  }
}

const mimeTypes: Record<ContainerFormat, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  mov: 'video/quicktime',
};
