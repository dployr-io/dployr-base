// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { setCookie } from "hono/cookie";

export function extractRequestMeta(req: Request) {
  const headers = req.headers;
  const ip = headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0].trim() ?? undefined;
  const userAgent = headers.get("user-agent") ?? undefined;
  const country = headers.get("cf-ipcountry") ?? undefined;
  return { ip, userAgent, country };
}

export function setSessionCookie(c: any, sessionId: string) {
  const url = new URL(c.req.url);
  const isDployrHost = url.hostname === "dployr.io" || url.hostname.endsWith(".dployr.io");
  setCookie(c, "session", sessionId, {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
    ...(isDployrHost ? { domain: ".dployr.io" } : {}),
  });
}
