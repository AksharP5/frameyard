/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Show } from "solid-js";

export type SearchInputProps = {
  placeholder: string;
  value: string;
  onValue: (value: string) => void;
};

export function SearchInput(props: SearchInputProps) {
  let input: HTMLInputElement | undefined;
  const clear = () => { props.onValue(""); input?.focus(); };
  return (
    <div class="mx-2 relative flex h-11 shrink-0 items-center border-b border-border">
      <Icon name="search" class="text-muted-foreground" />
      <input
        ref={input}
        type="text"
        value={props.value}
        onInput={(e) => props.onValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && props.value) { e.preventDefault(); clear(); }
          e.stopPropagation();
        }}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        autocomplete="off"
        class="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
      />
      <Show when={props.value}><Button variant="ghost" size="icon-square" aria-label="Clear search" title="Clear search (Escape)" onClick={clear}><Icon name="clear-input" class="size-4 text-muted-foreground" /></Button></Show>
    </div>
  );
}
