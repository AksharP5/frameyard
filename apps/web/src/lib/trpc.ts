/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createTRPCClient, httpBatchLink, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { supabase } from "./supabase";
import { showUpgradeDialog } from "@/components/upgrade-dialog";
import { hostedServiceUnavailable, localMode } from "./local-mode";

import type { AppRouter } from "@diffusionstudio/api-contract";

const hostedServiceLink: TRPCLink<AppRouter> = () => ({ next, op }) =>
  observable((observer) => {
    if (localMode) {
      observer.error(TRPCClientError.from(new Error(hostedServiceUnavailable)));
      return;
    }
    const sub = next(op).subscribe({
      next: (value) => observer.next(value),
      error: (err) => {
        if (err instanceof TRPCClientError && err.data?.code === "PAYMENT_REQUIRED") {
          showUpgradeDialog();
        }
        observer.error(err);
      },
      complete: () => observer.complete(),
    });
    return () => sub.unsubscribe();
  });

export const trpc = createTRPCClient<AppRouter>({
  links: [
    hostedServiceLink,
    httpBatchLink({
      url: `${import.meta.env.VITE_API_URL ?? ""}/api/trpc`,
      async headers() {
        const session = await supabase?.auth.getSession();
        const token = session?.data.session?.access_token;
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});
