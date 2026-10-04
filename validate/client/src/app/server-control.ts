import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  catchError, EMPTY, exhaustMap, filter, Observable, switchMap,
  take, throwError, timeout, TimeoutError, timer,
} from 'rxjs';

import type { Health, RestartResponse } from '@shared/contracts';

@Injectable({ providedIn: 'root' })
export class ServerControl {
  private readonly http = inject(HttpClient);

  restart(): Observable<Health> {
    return this.http.post<RestartResponse>('/api/restart', {}, {
      headers: { 'Content-Type': 'application/json', 'X-Validate': '1' },
    }).pipe(
      switchMap(previous => this.waitForRestart(previous.instanceId)),
      timeout({ first: 10_000 }),
      catchError((error: unknown) => {
        const message = error instanceof HttpErrorResponse ? error.error?.error || error.message
          : error instanceof TimeoutError ? 'Server restart timed out. Reload the page to retry.'
          : String(error);

        return throwError(() => new Error(message, { cause: error }));
      }),
    );
  }

  private waitForRestart(previousId: string): Observable<Health> {
    return timer(200, 200).pipe(
      exhaustMap(() => this.http.get<Health>('/api/health').pipe(
        timeout(1000),
        catchError(() => EMPTY),
      )),
      filter(health => health.service === 'validate' && health.version === 1
        && !!health.instanceId && health.instanceId !== previousId),
      take(1),
    );
  }
}
