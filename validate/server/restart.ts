import { spawn } from "node:child_process";
import { join } from "node:path";

// Called only after the old server has released its port.
export function relaunchServer(cwd: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dir, "server.ts"), cwd], {
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
