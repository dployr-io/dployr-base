// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let activeLevel: number = LEVELS["info"];

export function setLogLevel(level: LogLevel) {
  activeLevel = LEVELS[level] ?? LEVELS["info"];
}

function fmt(data?: Record<string, any> | null): string {
  if (!data || typeof data !== "object" || Object.keys(data).length === 0) return "";
  try {
    return "  " + Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  } catch {
    return "";
  }
}

export class Logger {
  private readonly tag: string;

  constructor(context: string) {
    this.tag = context;
  }

  debug(msg: string, data?: any) {
    if (LEVELS.debug >= activeLevel) console.debug(`[DEBUG] [${this.tag}] ${msg}${fmt(data as Record<string, any>)}`);
  }

  info(msg: string, data?: any) {
    if (LEVELS.info >= activeLevel) console.log(`[INFO]  [${this.tag}] ${msg}${fmt(data as Record<string, any>)}`);
  }

  warn(msg: string, data?: any) {
    if (LEVELS.warn >= activeLevel) console.warn(`[WARN]  [${this.tag}] ${msg}${fmt(data as Record<string, any>)}`);
  }

  error(msg: string, data?: any) {
    if (LEVELS.error >= activeLevel) console.error(`[ERROR] [${this.tag}] ${msg}${fmt(data as Record<string, any>)}`);
  }
}
