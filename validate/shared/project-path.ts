export function projectPath(cwd: string): string {
  return `${cwd.replace(/\/+$/, '').split('/').map(encodeURIComponent).join('/')}/`;
}
