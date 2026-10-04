import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerControl } from '@app/server-control';

const health = (instanceId: string) => ({ service: 'validate', version: 1, instanceId });

describe('ServerControl', () => {
  let http: HttpTestingController;
  let control: ServerControl;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });

    http = TestBed.inject(HttpTestingController);
    control = TestBed.inject(ServerControl);
  });

  afterEach(() => {
    http.verify({ ignoreCancelled: true });
    vi.useRealTimers();
  });

  it('waits for the new server, tolerating the old instance and connection failures', () => {
    const ready = vi.fn();
    control.restart().subscribe(ready);

    const restart = http.expectOne('/api/restart');
    expect(restart.request.method).toBe('POST');
    expect(restart.request.headers.get('X-Validate')).toBe('1');
    restart.flush({ restarting: true, instanceId: 'old' });

    vi.advanceTimersByTime(200);
    http.expectOne('/api/health').flush(health('old'));
    expect(ready).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    http.expectOne('/api/health').error(new ProgressEvent('error'));
    expect(ready).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    http.expectOne('/api/health').flush(health('new'));
    expect(ready).toHaveBeenCalledExactlyOnceWith(health('new'));

    vi.advanceTimersByTime(1000);
    http.expectNone('/api/health');
  });

  it('reports a busy-server rejection without polling', () => {
    const failed = vi.fn();
    control.restart().subscribe({ error: failed });
    http.expectOne('/api/restart').flush({ error: 'A project is busy' }, { status: 409, statusText: 'Conflict' });

    expect(failed.mock.calls[0][0].message).toBe('A project is busy');
    vi.advanceTimersByTime(1000);
    http.expectNone('/api/health');
  });

  it('bounds the entire restart operation to ten seconds', () => {
    const failed = vi.fn();
    control.restart().subscribe({ error: failed });
    http.expectOne('/api/restart').flush({ restarting: true, instanceId: 'old' });

    vi.advanceTimersByTime(10_000);

    expect(failed.mock.calls[0][0].message).toBe('Server restart timed out. Reload the page to retry.');
  });
});
