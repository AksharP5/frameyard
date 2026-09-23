import { MAIN_CHANNELS } from '@desktop/main-channels';
import { mainBridge } from '@/lib/ipc';
import { ElectronFileHandle } from '@/lib/electron-file-handle';
import type { OriginalMediaProvider } from '@diffusionstudio/runtime';

export function createOriginalMediaProvider(dir: string): OriginalMediaProvider {
  return {
    async openVideo(asset, stream) {
      const { id, frameRate } = await mainBridge.call(MAIN_CHANNELS.MEDIA_ORIGINAL_VIDEO_OPEN, { dir, source: asset.source, stream });
      return {
        frameRate,
        read: (frame) => mainBridge.call(MAIN_CHANNELS.MEDIA_ORIGINAL_VIDEO_READ, { id, frame }),
        close: () => mainBridge.call(MAIN_CHANNELS.MEDIA_ORIGINAL_VIDEO_CLOSE, { id }),
      };
    },
    async audioFile(asset, stream) {
      const path = await mainBridge.call(MAIN_CHANNELS.MEDIA_PREPARE_ORIGINAL_AUDIO, { dir, source: asset.source, stream });
      return new ElectronFileHandle(path).getFile();
    },
  };
}
