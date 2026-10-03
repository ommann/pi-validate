// Shared by the Bun service, CLI, and Node-compatible Pi client.
export function projectPath(cwd: string): string {
  return `/projects${cwd.split("/").map(encodeURIComponent).join("/")}/`;
}
