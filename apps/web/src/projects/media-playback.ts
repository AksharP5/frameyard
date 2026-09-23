import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { toast } from "somoto";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";
import { ElectronFileHandle } from "@/lib/electron-file-handle";

const notices = new Map<string, { id: string | number; name: string }>();
const keyOf = (dir: string, source: string, scale = 1) => JSON.stringify([dir, source, scale]);
mainBridge.handle(MAIN_CHANNELS.MEDIA_PLAYBACK_PROGRESS, ({ dir, source, progress, scale }) => {
  const notice = notices.get(keyOf(dir, source, scale));
  if (notice) toast(`Preparing video · ${Math.round(progress * 100)}%`, { id: notice.id, description: notice.name, duration: Infinity });
});

/** Each project owns its read cache. Original reads and saved source paths stay unchanged. */
export function createMediaReader(dir: string, read: (source: string) => Promise<File>, previewScale: () => 1 | 0.5 | 0.25 = () => 1) {
  const files = new Map<string, { version: string; promise: Promise<File> }>();
  return async (source: string): Promise<File> => {
    const file = await read(source);
    const scale = previewScale();
    const version = `${file.size}:${file.lastModified}:${scale}`;
    const existing = files.get(source);
    if (existing?.version === version) return existing.promise;
    const pending = prepare(source, file, scale).catch((error) => {
      if (files.get(source)?.promise === pending) files.delete(source);
      throw error;
    });
    files.set(source, { version, promise: pending });
    return pending;
  };

  async function prepare(source: string, file: File, scale: 1 | 0.5 | 0.25): Promise<File> {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file, { useStreamReader: false }) });
    try {
      const video = await input.getPrimaryVideoTrack();
      if (!video || scale === 1 && await video.canDecode()) return file;
    } finally { input.dispose(); }

    const key = keyOf(dir, source, scale);
    const id = toast("Preparing video for playback", { description: file.name, duration: Infinity });
    notices.set(key, { id, name: file.name });
    try {
      const path = await mainBridge.call(MAIN_CHANNELS.MEDIA_PREPARE_PLAYBACK, { dir, source, scale });
      const copy = await new ElectronFileHandle(path).getFile();
      toast.success("Video ready", { id, description: file.name, duration: 4000 });
      return copy;
    } catch (error) {
      toast.error("Could not prepare video", { id, description: error instanceof Error ? error.message : String(error), duration: 10000 });
      throw error;
    } finally { if (notices.get(key)?.id === id) notices.delete(key); }
  }
}
