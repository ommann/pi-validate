import type { Routes, UrlMatcher } from '@angular/router';
import { UrlSegment } from '@angular/router';
import { ProjectPage } from '@app/project-page/project-page';

// Folder paths have arbitrary depth. Angular decodes each segment once.
const projectMatcher: UrlMatcher = segments => {
  if (segments[0]?.path === 'api' || segments[0]?.path === 'client') return null;

  const cwd = ('/' + segments.map(segment => segment.path).join('/')).replace(/\/+$/, '') || '/';
  return { consumed: segments, posParams: { cwd: new UrlSegment(cwd, {}) } };
};

export const routes: Routes = [
  { matcher: projectMatcher, component: ProjectPage },
];
