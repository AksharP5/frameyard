/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Hosted accounts and services are opt-in in this fork. */
export const localMode = import.meta.env.VITE_LOCAL_MODE !== "false";

export const hostedServiceUnavailable =
  "Hosted services are off in local mode. Ask your agent to render media, then import the result.";
