import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    TestBed.configureTestingModule({
      providers: [ValidationClient, provideHttpClient(), provideHttpClientTesting()],
    });
    client = TestBed.inject(ValidationClient);
    http = TestBed.inject(HttpTestingController);
    client.state.set(structuredClone(snapshot));
  });

  afterEach(() => http.verify());

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
