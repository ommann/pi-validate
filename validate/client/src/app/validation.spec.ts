import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationClient } from '@app/validation';
import type { Snapshot } from '@app/models';

const snapshot: Snapshot = {
  cwd: '/tmp/project', busy: false, steps: [], runs: [],
  plan: { groups: [['build']], policies: { build: 'agent' } },
};

describe('ValidationClient optimistic saves', () => {
  let client: ValidationClient;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [ValidationClient, provideHttpClient(), provideHttpClientTesting()],
    });
    client = TestBed.inject(ValidationClient);
    http = TestBed.inject(HttpTestingController);
    client.state.set(structuredClone(snapshot));
  });

  afterEach(() => {
    http.verify({ ignoreCancelled: true });
    vi.useRealTimers();
  });

  it('opens a project, detects applicability, and polls for updated runs', async () => {
    client.openProject('/tmp/project');
    expect(client.state()).toBeNull();

    http.expectOne('/tmp/project/api/state').flush(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/tmp/project/api/detect').flush(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.state()).toEqual(snapshot);

    await vi.advanceTimersByTimeAsync(500);
    http.expectOne('/tmp/project/api/state').flush({ ...snapshot, busy: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.state()?.busy).toBe(true);
    http.expectNone('/tmp/project/api/detect');
  });

  it('cancels old project requests and rejects stale updates after navigation', async () => {
    client.openProject('/tmp/old');
    const old = http.expectOne('/tmp/old/api/state');

    client.openProject('/tmp/new');
    expect(old.cancelled).toBe(true);
    const next = { ...snapshot, cwd: '/tmp/new' };
    http.expectOne('/tmp/new/api/state').flush(next);
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/tmp/new/api/detect').flush(next);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.state()?.cwd).toBe('/tmp/new');
    expect(client.error()).toBe('');
  });

  it('reports polling connection errors and recovers on the next poll', async () => {
    client.openProject('/tmp/project');
    http.expectOne('/tmp/project/api/state').error(new ProgressEvent('error'));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.error()).toContain('Cannot connect');

    await vi.advanceTimersByTimeAsync(500);
    http.expectOne('/tmp/project/api/state').flush(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/tmp/project/api/detect').flush(snapshot);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.state()).toEqual(snapshot);
    expect(client.error()).toBe('');
  });

  it('keeps action errors through successful polls and connection recovery until that action is retried', async () => {
    client.openProject('/tmp/project');
    http.expectOne('/tmp/project/api/state').flush(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/tmp/project/api/detect').flush(snapshot);
    await vi.advanceTimersByTimeAsync(0);

    const saved = client.save({ ...snapshot.plan, useNix: true });
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/tmp/project/api/plan').flush({ error: 'Cannot save' }, { status: 409, statusText: 'Conflict' });
    await saved;
    expect(client.error()).toContain('Cannot save');

    await vi.advanceTimersByTimeAsync(500);
    http.expectOne('/tmp/project/api/state').flush(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.error()).toContain('Cannot save');

    client.requestDetection();
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/tmp/project/api/detect').flush(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.error()).toContain('Cannot save');

    await vi.advanceTimersByTimeAsync(500);
    http.expectOne('/tmp/project/api/state').error(new ProgressEvent('error'));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.error()).toContain('Cannot connect');

    await vi.advanceTimersByTimeAsync(500);
    http.expectOne('/tmp/project/api/state').flush(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.error()).toContain('Cannot save');

    const retried = client.save(snapshot.plan);
    expect(client.error()).toBe('');
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/tmp/project/api/plan').flush(snapshot);
    await retried;
    expect(client.error()).toBe('');
  });

  it('runs as a user and stays pending until authoritative state is refreshed', async () => {
    const running = client.run();
    expect(client.pending()).toBe(true);
    const request = http.expectOne('api/run');
    expect(request.request.body).toEqual({ caller: 'user' });
    request.flush({ id: 'run' });
    await vi.advanceTimersByTimeAsync(0);

    expect(client.pending()).toBe(true);
    http.expectOne('api/state').flush({ ...snapshot, busy: false });
    await running;
    expect(client.pending()).toBe(false);
    expect(client.error()).toBe('');
  });

  it('reports run and refresh failures without leaving controls locked', async () => {
    const running = client.run();
    http.expectOne('api/run').flush({ error: 'Busy' }, { status: 409, statusText: 'Conflict' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.error()).toContain('Busy');

    http.expectOne('api/state').flush({}, { status: 500, statusText: 'Server error' });
    await running;
    expect(client.error()).toContain('HTTP 500');
    expect(client.pending()).toBe(false);
  });

  it('stops an active run and waits for the server cleanup response', async () => {
    client.state.set({ ...snapshot, busy: true, running: true });
    const stopped = client.stop();
    expect(client.stopping()).toBe(true);
    expect(client.running()).toBe(true);

    const request = http.expectOne('api/stop');
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('X-Validate')).toBe('1');
    await client.stop();
    http.expectNone('api/stop');

    request.flush({ ...snapshot, running: false, stopping: false });
    await stopped;
    expect(client.stopping()).toBe(false);
    expect(client.running()).toBe(false);
    expect(client.error()).toBe('');
  });

  it('reports stop failures without pretending the run ended', async () => {
    client.state.set({ ...snapshot, busy: true, running: true });
    const stopped = client.stop();
    http.expectOne('api/stop').flush({ error: 'Cannot stop' }, { status: 500, statusText: 'Server error' });
    await stopped;

    expect(client.error()).toContain('Cannot stop');
    expect(client.running()).toBe(true);
    expect(client.stopping()).toBe(false);

    const retried = client.stop();
    expect(client.error()).toBe('');
    http.expectOne('api/stop').flush({ ...snapshot, running: false });
    await retried;
    expect(client.error()).toBe('');
  });

  it('does not request cancellation when idle', async () => {
    await client.stop();
    http.expectNone('api/stop');
  });

  it('reports restart failures and restores the controls', async () => {
    const restarted = client.restart();
    expect(client.restarting()).toBe(true);
    expect(client.pending()).toBe(true);

    http.expectOne('/api/restart').flush({ error: 'A project is busy' }, { status: 409, statusText: 'Conflict' });
    await restarted;

    expect(client.error()).toContain('A project is busy');
    expect(client.restarting()).toBe(false);
    expect(client.pending()).toBe(false);
  });

  it('updates the plan immediately and accepts the confirmed state', async () => {
    const plan = { ...snapshot.plan, policies: { build: 'user' as const } };
    const saved = client.save(plan);
    expect(client.plan()).toEqual(plan);
    expect(client.pending()).toBe(true);

    expect(client.editingDisabled()).toBe(false);
    await Promise.resolve();
    http.expectOne('api/plan').flush({ ...snapshot, plan });
    await saved;
    expect(client.plan()).toEqual(plan);
    expect(client.pending()).toBe(false);
  });

  it('queues rapid edits without disabling controls or reverting newer input', async () => {
    const first = { ...snapshot.plan, configs: { build: { ratio: 0.1 } } };
    const second = { ...snapshot.plan, configs: { build: { ratio: 0.2 } } };
    const firstSave = client.save(first);
    const secondSave = client.save(second);
    expect(client.plan()).toEqual(second);
    expect(client.editingDisabled()).toBe(false);

    await Promise.resolve();
    const request = http.expectOne('api/plan');
    expect(request.request.body).toEqual(first);
    request.flush({ ...snapshot, plan: first, busy: true });
    await firstSave;
    expect(client.plan()).toEqual(second);
    expect(client.editingDisabled()).toBe(false);

    await Promise.resolve();
    const next = http.expectOne('api/plan');
    expect(next.request.body).toEqual(second);
    next.flush({ ...snapshot, plan: second });
    await secondSave;
    expect(client.plan()).toEqual(second);
    expect(client.pending()).toBe(false);
  });

  it('detects in the background and queues edits without disabling the form', async () => {
    client.requestDetection();
    expect(client.pending()).toBe(false);
    expect(client.editingDisabled()).toBe(false);
    await Promise.resolve();
    const detection = http.expectOne('api/detect');

    const plan = { ...snapshot.plan, useNix: true };
    const saved = client.save(plan);
    expect(client.editingDisabled()).toBe(false);
    expect(client.plan()).toEqual(plan);
    http.expectNone('api/plan');

    detection.flush(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.plan()).toEqual(plan);
    expect(client.editingDisabled()).toBe(false);
    http.expectOne('api/plan').flush({ ...snapshot, plan });
    await saved;
    expect(client.pending()).toBe(false);
  });

  it('rolls back a rejected edit and reports the error', async () => {
    const saved = client.save({ ...snapshot.plan, policies: { build: 'off' } });
    expect(client.plan()?.policies['build']).toBe('off');

    await Promise.resolve();
    http.expectOne('api/plan').flush({ error: 'Cannot save' }, { status: 409, statusText: 'Conflict' });
    await saved;
    expect(client.plan()).toEqual(snapshot.plan);
    expect(client.error()).toContain('Cannot save');
    expect(client.pending()).toBe(false);
  });
});
