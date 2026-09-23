import { z } from "zod";

export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_IMAGES_BYTES = 20 * 1024 * 1024;
export const CHAT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const maxUrlLength = 4 * Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) + 32;

function decodedBytes(url: string): number {
  const length = url.length - url.indexOf(",") - 1;
  const padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
  return length / 4 * 3 - padding;
}

const imageSchema = z.object({
  name: z.string().trim().min(1).max(255),
  url: z.string().max(maxUrlLength).superRefine((url, context) => {
    if (url.length > maxUrlLength) return;
    const comma = url.indexOf(",");
    const header = url.slice(0, comma);
    const base64 = url.slice(comma + 1);
    if (!/^data:image\/(png|jpeg|webp|gif);base64$/.test(header) || !base64.length || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      context.addIssue({ code: "custom", message: "Attach a PNG, JPEG, WebP, or GIF image" });
      return;
    }
    if (decodedBytes(url) > MAX_CHAT_IMAGE_BYTES) context.addIssue({ code: "custom", message: "Each image must be 10 MiB or smaller" });
  }),
}).strict();

export const codexImagesSchema = z.array(imageSchema).max(MAX_CHAT_IMAGES, "Attach up to 4 images").superRefine((images, context) => {
  if (images.reduce((sum, image) => sum + decodedBytes(image.url), 0) > MAX_CHAT_IMAGES_BYTES) {
    context.addIssue({ code: "custom", message: "Images must total 20 MiB or less" });
  }
});
export type CodexImage = z.infer<typeof imageSchema>;
