import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { firstValueFrom, interval, Subject, takeUntil, tap } from 'rxjs';

import { projectPath } from '@shared/project-path';
import { editPlan } from '@shared/plan.js';
import type { Operation, Plan, Snapshot } from '@app/models';
import { ServerControl } from '@app/server-control';

// Provided by the routed page, never shared between project tabs or page instances.
@Injectable()
export class ValidationClient {
  readonly state = signal<Snapshot | null>(null);

  // Keep drag-list data stable when a poll returns an unchanged plan.
  readonly plan = computed(() => this.state()?.plan, {
    equal: (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
  });

  private readonly starting = signal(false);
  readonly stopping = signal(false);
  readonly running = computed(() => this.starting() || !!this.state()?.running
    || !!this.state()?.runs.some(run => !run.finishedAt));

  readonly pending = signal(false);
  readonly saving = signal(false);
  private readonly detecting = signal(false);
  readonly restarting = signal(false);
  private readonly connectionError = signal('');
  private readonly actionError = signal<{ source: 'run' | 'save' | 'stop' | 'detect' | 'restart'; message: string } | null>(null);
  readonly error = computed(() => this.connectionError() || this.actionError()?.message || '');

  readonly editingDisabled = computed(() => this.restarting() || !this.state()
    || !!this.state()?.runs.some(run => !run.finishedAt)
    || (!this.saving() && this.pending()));
  readonly disabled = computed(() => this.editingDisabled() || this.pending() || this.detecting());

  private readonly http = inject(HttpClient);
  private readonly serverControl = inject(ServerControl);
  private readonly cancel = new Subject<void>();

  private generation = 0;
  private base = '';

  private optimisticPlan?: Plan;
  private confirmedPlan?: Plan;
  private saveQueue: Promise<void> = Promise.resolve();
  private saveRevision = 0;
  private polling = false;
  private detectionRequested = true;

  constructor() {
    toSignal(interval(500).pipe(tap(() => {
      if (this.base) void this.poll();
    })));

    inject(DestroyRef).onDestroy(() => {
      this.generation++;
      this.cancel.next();
      this.cancel.complete();
    });
  }

  openProject(cwd: string): void {
    this.generation++;
    this.cancel.next();

    this.optimisticPlan = undefined;
    this.confirmedPlan = undefined;
    this.saveQueue = Promise.resolve();
    this.saveRevision++;
    this.saving.set(false);
    this.detecting.set(false);
    this.base = projectPath(cwd);
    this.state.set(null);
    this.pending.set(false);
    this.starting.set(false);
    this.stopping.set(false);
    this.restarting.set(false);
    this.connectionError.set('');
    this.actionError.set(null);
    this.polling = false;
    this.detectionRequested = true;

    void this.poll();
  }

  private async api<T>(path: string, body?: unknown): Promise<T> {
    const url = this.base + path.replace(/^\//, '');
    const request = body === undefined ? this.http.get<T>(url) : this.http.post<T>(url, body, {
      headers: { 'Content-Type': 'application/json', 'X-Validate': '1' },
    });

    try {
      return await firstValueFrom(request.pipe(takeUntil(this.cancel)));
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        const message = error.error?.error || (error.status ? `HTTP ${error.status}` : 'Cannot connect to the validation server.');

        throw new Error(message, { cause: error });
      }

      throw error;
    }
  }

  private accept(next: Snapshot, generation: number): void {
    if (generation === this.generation && !this.restarting()) {
      this.state.set(this.optimisticPlan ? { ...next, plan: this.optimisticPlan } : next);
    }
  }

  private clearActionError(source: 'run' | 'save' | 'stop' | 'detect' | 'restart'): void {
    if (this.actionError()?.source === source) this.actionError.set(null);
  }

  private async action(operation: (generation: number) => Promise<unknown>): Promise<void> {
    if (this.disabled()) return;

    const generation = this.generation;
    this.pending.set(true);
    this.clearActionError('run');

    try {
      await operation(generation);
    } catch (error) {
      if (generation === this.generation) this.actionError.set({ source: 'run', message: String(error) });
    } finally {
      if (generation === this.generation) {
        // Keep mutations serialized until the authoritative state is refreshed.
        try {
          this.accept(await this.api<Snapshot>('/api/state'), generation);
          if (generation === this.generation) this.connectionError.set('');
        } catch (error) {
          if (generation === this.generation) this.connectionError.set(String(error));
        } finally {
          if (generation === this.generation) this.pending.set(false);
        }
      }
    }
  }

  save(plan: Plan): Promise<void> {
    if (this.editingDisabled()) { return Promise.resolve(); }

    const generation = this.generation;
    const revision = ++this.saveRevision;
    if (!this.saving()) { this.confirmedPlan = this.state()!.plan; }
    this.optimisticPlan = plan;
    this.saving.set(true);
    this.pending.set(true);
    this.clearActionError('save');
    this.state.update(state => state ? { ...state, plan } : state);

    this.saveQueue = this.saveQueue.then(async () => {
      if (generation !== this.generation) { return; }

      this.clearActionError('save');
      try {
        const next = await this.api<Snapshot>('/api/plan', plan);
        if (generation === this.generation) {
          this.confirmedPlan = next.plan;
          if (revision === this.saveRevision) { this.optimisticPlan = undefined; }
          this.accept(next, generation);
        }
      } catch (error) {
        if (generation === this.generation) {
          this.actionError.set({ source: 'save', message: String(error) });
          if (revision === this.saveRevision) {
            this.optimisticPlan = undefined;
            this.state.update(state => state ? { ...state, plan: this.confirmedPlan! } : state);
          }
        }
      } finally {
        if (generation === this.generation && revision === this.saveRevision) {
          this.saving.set(false);
          this.pending.set(false);
        }
      }
    });
    return this.saveQueue;
  }

  changePlan(name: string, operation: Operation): void {
    const state = this.state();

    if (state) void this.save(editPlan(state.plan, name, operation));
  }

  changeConfig(name: string, key: string, value: number): void {
    const plan = this.state()?.plan;

    if (plan) void this.save({
      ...plan,
      configs: { ...plan.configs, [name]: { ...plan.configs?.[name], [key]: value } },
    });
  }

  async run(): Promise<void> {
    if (this.disabled()) return;

    const generation = this.generation;
    this.starting.set(true);
    try {
      await this.action(() => this.api('/api/run', { caller: 'user' }));
    } finally {
      if (generation === this.generation) this.starting.set(false);
    }
  }

  async stop(): Promise<void> {
    if (!this.running() || this.stopping() || this.state()?.stopping) return;

    const generation = this.generation;
    this.stopping.set(true);
    this.clearActionError('stop');
    try {
      this.accept(await this.api<Snapshot>('/api/stop', {}), generation);
    } catch (error) {
      if (generation === this.generation) this.actionError.set({ source: 'stop', message: String(error) });
    } finally {
      if (generation === this.generation) this.stopping.set(false);
    }
  }

  requestDetection(): void {
    this.detectionRequested = true;
    void this.checkAvailability();
  }

  private async checkAvailability(): Promise<void> {
    if (!this.detectionRequested || this.disabled()) { return; }

    const generation = this.generation;
    this.detectionRequested = false;
    this.detecting.set(true);
    this.clearActionError('detect');

    // Detection and saves share a queue, not a form-wide loading state.
    this.saveQueue = this.saveQueue.then(async () => {
      if (generation !== this.generation) { return; }

      try {
        this.accept(await this.api<Snapshot>('/api/detect', {}), generation);
      } catch (error) {
        if (generation === this.generation) { this.actionError.set({ source: 'detect', message: String(error) }); }
      } finally {
        if (generation === this.generation) { this.detecting.set(false); }
      }
    });
    await this.saveQueue;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.restarting()) return;

    const generation = this.generation;
    this.polling = true;

    try {
      this.accept(await this.api<Snapshot>('/api/state'), generation);
      if (generation === this.generation && !this.restarting()) {
        this.connectionError.set('');
        await this.checkAvailability();
      }
    } catch (error) {
      if (generation === this.generation && !this.restarting()) this.connectionError.set(String(error));
    } finally {
      if (generation === this.generation) this.polling = false;
    }
  }

  async restart(): Promise<void> {
    if (this.disabled()) return;

    const generation = ++this.generation;
    this.cancel.next();
    this.restarting.set(true);
    this.pending.set(true);
    this.clearActionError('restart');

    try {
      await firstValueFrom(this.serverControl.restart().pipe(takeUntil(this.cancel)));

      if (generation === this.generation) location.reload();
    } catch (error) {
      if (generation === this.generation) this.actionError.set({ source: 'restart', message: String(error) });
    } finally {
      if (generation === this.generation) {
        this.restarting.set(false);
        this.pending.set(false);
        this.polling = false;
      }
    }
  }
}
