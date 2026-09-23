import { For, Show } from "solid-js";
import { CHAT_IMAGE_TYPES, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES, MAX_CHAT_IMAGES_BYTES, codexImagesSchema, type CodexImage } from "@desktop/codex-image-contracts";
import { Button } from "@/components/ui/button";

export async function readChatImages(files: File[]): Promise<CodexImage[]> {
  if (files.length > MAX_CHAT_IMAGES) throw new Error("Attach up to 4 images");
  if (files.some((file) => !CHAT_IMAGE_TYPES.some((type) => file.type === type))) throw new Error("Attach a PNG, JPEG, WebP, or GIF image");
  if (files.some((file) => file.size === 0)) throw new Error("This image is empty");
  if (files.some((file) => file.size > MAX_CHAT_IMAGE_BYTES)) throw new Error("Each image must be 10 MiB or smaller");
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_CHAT_IMAGES_BYTES) throw new Error("Images must total 20 MiB or less");
  const images = await Promise.all(files.map((file) => new Promise<CodexImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve({ name: file.name || "Image", url: reader.result })
      : reject(new Error(`Could not read ${file.name}`));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled`));
    reader.readAsDataURL(file);
  })));
  return codexImagesSchema.parse(images);
}

export function ChatImages(props: {
  images: CodexImage[];
  onAdd: (files: File[]) => void;
  onRemove: (image: CodexImage) => void;
  disabled: boolean;
  showButton?: boolean;
  inputRef?(element: HTMLInputElement): void;
}) {
  let input: HTMLInputElement | undefined;
  return <div class="flex flex-wrap items-center gap-2" classList={{ hidden: props.showButton === false && !props.images.length }}>
    <input ref={(element) => { input = element; props.inputRef?.(element); }} type="file" class="hidden" aria-label="Attach images" accept={CHAT_IMAGE_TYPES.join(",")} multiple disabled={props.disabled || props.images.length >= MAX_CHAT_IMAGES}
      onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        if (files.length) props.onAdd(files);
      }} />
    <Show when={props.showButton !== false}><Button type="button" variant="ghost" disabled={props.disabled || props.images.length >= MAX_CHAT_IMAGES} onClick={() => input?.click()}>Attach images</Button></Show>
    <For each={props.images}>{(image) => <div class="relative">
      <img src={image.url} alt={image.name} title={image.name} class="h-14 w-14 rounded border border-border object-contain" />
      <button type="button" aria-label={`Remove ${image.name}`} title={`Remove ${image.name}`} disabled={props.disabled}
        class="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded bg-background text-xs text-foreground shadow disabled:opacity-50"
        onClick={() => props.onRemove(image)}>×</button>
    </div>}</For>
  </div>;
}
