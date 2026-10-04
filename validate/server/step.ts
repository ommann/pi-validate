import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export type Context = {
  cwd: string;
  scripts: Record<string, unknown>;
  useNix?: boolean;
  signal?: AbortSignal;
  config?: Record<string, unknown>;
  output?: (stream: "stdout" | "stderr", text: string) => void;
};

import type { NumberParameter } from "../shared/contracts.ts";

export type { NumberParameter } from "../shared/contracts.ts";

export type Step = {
  name: string;
  parameters?: Record<string, NumberParameter>;
  detect(context: Context): boolean | Promise<boolean>;
  run(context: Context): Promise<number>;
};

export function executionCommand(context: Context, command: string[]): string[] {
  return context.useNix ? ["nix", "develop", "--command", ...command] : [...command];
}

// Read both streams concurrently and wait for EOF as well as process exit.
export async function runCommand(context: Context, command: string[]): Promise<number> {
  context.signal?.throwIfAborted();
  command = executionCommand(context, command);
  if (!Bun.which(command[0]!, { cwd: context.cwd })) {
    throw new Error(`Executable not found: ${command[0]}`);
  }
  const proc = spawn(command[0]!, command.slice(1), {
    cwd: context.cwd,
    env: {
      ...process.env,
      TERM: process.env.TERM || "xterm-256color",
      FORCE_COLOR: process.env.FORCE_COLOR ?? (process.env.NO_COLOR === undefined ? "1" : "0"),
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", code => resolve(code ?? 1));
  });
  let cleanup: Promise<void> | undefined;

  function kill(signal: NodeJS.Signals) {
    if (!proc.pid) return;

    try {
      if (process.platform === "win32") proc.kill(signal);
      else process.kill(-proc.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") proc.kill(signal);
    }
  }

  const abort = () => {
    cleanup ??= (async () => {
      kill("SIGTERM");
      await delay(1000);
      kill("SIGKILL");
    })();
  };
  context.signal?.addEventListener("abort", abort, { once: true });
  if (context.signal?.aborted) abort();

  const captured: string[] = [];
  async function drain(stream: AsyncIterable<Uint8Array>, channel: "stdout" | "stderr") {
    const decoder = new TextDecoder();
    for await (const bytes of stream) {
      const text = decoder.decode(bytes, { stream: true });
      captured.push(text);
      context.output?.(channel, text);
    }
    const tail = decoder.decode();
    if (tail) {
      captured.push(tail);
      context.output?.(channel, tail);
    }
  }
  let code: number;
  try {
    [code] = await Promise.all([
      exited,
      drain(proc.stdout!, "stdout"),
      drain(proc.stderr!, "stderr"),
    ]);
  } finally {
    await cleanup;
    context.signal?.removeEventListener("abort", abort);
  }

  context.signal?.throwIfAborted();
  // Standalone use keeps the original quiet-success behavior.
  if (!context.output && code !== 0) {
    process.stderr.write(`Failed: ${command.join(" ")}\n${captured.join("")}`);
  }
  return code;
}
