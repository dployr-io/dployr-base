// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { createConnection } from "net";

/**
 * Checks host reachability by opening a TCP connection to port 22.
 *
 * Any response — including ECONNREFUSED — proves the host is up and routing
 * packets. Only a timeout (host silently drops SYNs) means unreachable.
 */
export function tcpReachable(host: string, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: 22 });
    const done = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("error", (err: NodeJS.ErrnoException) => done(err.code === "ECONNREFUSED"));
    socket.on("timeout", () => done(false));
  });
}
