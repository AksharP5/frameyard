/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { assetName, type Asset } from "@diffusionstudio/assets";
import { getAssetFile } from "@diffusionstudio/runtime";
import { Dialog, DialogContent, DialogPortal, DialogTitle } from "../ui/dialog";

function usePreviewSource(asset: () => Asset) {
  const [url, setUrl] = createSignal<string>();
  const [error, setError] = createSignal<string>();

  createEffect(() => {
    const current = asset();
    current.stat?.mtime;
    let disposed = false;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setError(undefined);

    onCleanup(() => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });

    void getAssetFile(current).then(file => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(file);
      setUrl(objectUrl);
    }).catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    });
  });

  return { url, error, setError };
}

export function AssetImagePreview(props: { asset: Asset; onClose(): void; onRestoreFocus(): void }) {
  const { url, error, setError } = usePreviewSource(() => props.asset);
  // Restore focus after the dialog's focus trap has been disposed.
  onCleanup(() => queueMicrotask(() => props.onRestoreFocus()));

  return (
    <Dialog open onOpenChange={open => { if (!open) props.onClose(); }}>
      <DialogPortal>
        <DialogContent
          class="flex max-h-[90vh] w-fit max-w-[90vw] flex-col gap-3 p-4 sm:max-w-[90vw]"
          onKeyDown={event => event.stopPropagation()}
          onCloseAutoFocus={event => event.preventDefault()}
        >
          <DialogTitle class="pr-8 truncate">{assetName(props.asset)}</DialogTitle>
          <Show when={!error()} fallback={<p role="alert" class="text-sm text-destructive">{error()}</p>}>
            <Show when={url()} fallback={<p role="status" class="text-sm text-muted-foreground">Loading image…</p>}>
              {source => <img
                src={source()}
                alt={assetName(props.asset)}
                draggable={false}
                class="min-h-0 max-h-[calc(90vh-5rem)] max-w-full object-contain"
                onError={() => setError("Could not display this image.")}
              />}
            </Show>
          </Show>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

/** Mounted only for the hovered, visible asset, so idle tiles hold no video buffers. */
export function AssetVideoPreview(props: { asset: Asset }) {
  const { url, error, setError } = usePreviewSource(() => props.asset);
  let video: HTMLVideoElement | undefined;

  onCleanup(() => {
    video?.pause();
    video?.removeAttribute("src");
    video?.load();
  });

  return (
    <Show when={!error()} fallback={<span role="status" class="absolute inset-x-1 bottom-1 z-10 bg-overlay px-1 text-xxs text-primary-foreground" title={error()}>Preview unavailable</span>}>
      <Show when={url()}>
        {source => <video
          ref={video}
          src={source()}
          aria-label={`Preview ${assetName(props.asset)}`}
          class="pointer-events-none absolute inset-0 size-full object-cover"
          muted
          autoplay
          loop
          playsinline
          onError={() => setError("Could not play this video.")}
        />}
      </Show>
    </Show>
  );
}
