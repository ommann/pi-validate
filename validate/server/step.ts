export type Context = {
  cwd: string;
  scripts: Record<string, unknown>;
  useNix?: boolean;
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
  command = executionCommand(context, command);
  if (!Bun.which(command[0]!, { cwd: context.cwd })) {
    throw new Error(`Executable not found: ${command[0]}`);
  }
  const proc = Bun.spawn(command, {
    cwd: context.cwd,
    env: {
      ...process.env,
      TERM: process.env.TERM || "xterm-256color",
      FORCE_COLOR: process.env.FORCE_COLOR ?? (process.env.NO_COLOR === undefined ? "1" : "0"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const captured: string[] = [];
  async function drain(stream: ReadableStream<Uint8Array>, channel: "stdout" | "stderr") {
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
  const [code] = await Promise.all([
    proc.exited,
    drain(proc.stdout, "stdout"),
    drain(proc.stderr, "stderr"),
  ]);
  // Standalone use keeps the original quiet-success behavior.
  if (!context.output && code !== 0) {
    process.stderr.write(`Failed: ${command.join(" ")}\n${captured.join("")}`);
  }
  return code;
}
