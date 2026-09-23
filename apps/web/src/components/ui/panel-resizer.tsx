/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSignal, onCleanup, type JSX } from 'solid-js';
import { cx } from '@/lib/cva';

type PanelResizerProps = {
  edge: 'left' | 'right' | 'bottom';
  label: string;
  value: number;
  min: number;
  max: number;
  onChange(value: number): void;
  class?: string;
};

export function PanelResizer(props: PanelResizerProps) {
  const [resizing, setResizing] = createSignal(false);
  const horizontal = () => props.edge === 'bottom';
  const direction = () => props.edge === 'left' ? 1 : -1;
  const change = (value: number) => props.onChange(Math.round(Math.max(props.min, Math.min(props.max, value))));
  let endDrag = () => {};

  const startDrag: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    endDrag();
    const handle = event.currentTarget;
    const start = horizontal() ? event.clientY : event.clientX;
    const value = props.value;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      const position = horizontal() ? next.clientY : next.clientX;
      change(value + (position - start) * direction());
    };

    endDrag = () => {
      setResizing(false);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', endDrag);
      handle.removeEventListener('pointercancel', endDrag);
      handle.removeEventListener('lostpointercapture', endDrag);
      window.removeEventListener('blur', endDrag);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      endDrag = () => {};
    };
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('lostpointercapture', endDrag);
    window.addEventListener('blur', endDrag);
    setResizing(true);
  };

  const handleKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    const backward = horizontal() ? 'ArrowUp' : 'ArrowLeft';
    const forward = horizontal() ? 'ArrowDown' : 'ArrowRight';
    if (!['Home', 'End', backward, forward].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') return change(props.min);
    if (event.key === 'End') return change(props.max);
    change(props.value + (event.key === forward ? 1 : -1) * direction() * (event.shiftKey ? 40 : 10));
  };

  onCleanup(() => endDrag());

  return (
    <div class={cx('relative bg-border-strong', props.class)}>
      <div
        role="separator"
        aria-label={props.label}
        aria-orientation={horizontal() ? 'horizontal' : 'vertical'}
        aria-valuenow={Math.round(props.value)}
        aria-valuemin={props.min}
        aria-valuemax={Math.round(props.max)}
        tabIndex={0}
        class="absolute z-40 group touch-none outline-none"
        classList={{
          'left-0 right-0 -top-[3px] h-[7px] cursor-ns-resize': horizontal(),
          'top-0 bottom-0 -left-[3px] w-[7px] cursor-ew-resize': !horizontal(),
        }}
        style="-webkit-app-region: no-drag;"
        onPointerDown={startDrag}
        onKeyDown={handleKeyDown}
      >
        <div
          class="absolute transition-colors group-hover:bg-primary group-focus-visible:bg-primary"
          classList={{
            'bg-primary': resizing(),
            'left-0 right-0 top-[3px] h-px': horizontal(),
            'top-0 bottom-0 left-[3px] w-px': !horizontal(),
          }}
        />
      </div>
    </div>
  );
}
