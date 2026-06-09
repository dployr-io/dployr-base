// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { createWriteStream, mkdirSync } from "fs";
import { dirname } from "path";
import type { WriteStream } from "fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let activeLevel: number = LEVELS["info"];
let fileStream: WriteStream | null = null;

export function setLogLevel(level: LogLevel) {
  activeLevel = LEVELS[level] ?? LEVELS["info"];
}

export function initFileLogging(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  fileStream = createWriteStream(path, { flags: "a" });
}

function write(line: string) {
  fileStream?.write(line + "\n");
}

function fmt(data?: any): string {
  if (data == null) return "";
  if (data instanceof Error) {
    return `  error=${JSON.stringify(data.message)}${data.stack ? ` stack=${JSON.stringify(data.stack.split("\n").slice(0, 3).join(" | "))}` : ""}`;
  }
  if (typeof data !== "object" || Object.keys(data).length === 0) return "";
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
    if (LEVELS.debug < activeLevel) return;
    const line = `[DEBUG] [${this.tag}] ${msg}${fmt(data)}`;
    console.debug(line);
    write(line);
  }

  info(msg: string, data?: any) {
    if (LEVELS.info < activeLevel) return;
    const line = `[INFO]  [${this.tag}] ${msg}${fmt(data)}`;
    console.log(line);
    write(line);
  }

  warn(msg: string, data?: any) {
    if (LEVELS.warn < activeLevel) return;
    const line = `[WARN]  [${this.tag}] ${msg}${fmt(data)}`;
    console.warn(line);
    write(line);
  }

  error(msg: string, data?: any) {
    if (LEVELS.error < activeLevel) return;
    const line = `[ERROR] [${this.tag}] ${msg}${fmt(data)}`;
    console.error(line);
    write(line);
  }
}
