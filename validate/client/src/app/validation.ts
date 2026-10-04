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

  readonly pending = signal(false);
  readonly restarting = signal(false);
  readonly error = signal('');

  readonly disabled = computed(() => this.restarting() || !this.state() || this.pending() || !!this.state()?.busy);

  private readonly http = inject(HttpClient);
  private readonly serverControl = inject(ServerControl);
  private readonly cancel = new Subject<void>();

  private generation = 0;
  private base = '';

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

    this.base = projectPath(cwd);
    this.state.set(null);
    this.pending.set(false);
    this.restarting.set(false);
    this.error.set('');
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
    if (generation === this.generation && !this.restarting()) this.state.set(next);
  }

  private async action(operation: (generation: number) => Promise<unknown>): Promise<void> {
    if (this.disabled()) return;

    const generation = this.generation;
    this.pending.set(true);
    this.error.set('');

    try {
      await operation(generation);
    } catch (error) {
      if (generation === this.generation) this.error.set(String(error));
    } finally {
      if (generation === this.generation) {
        // Keep mutations serialized until the authoritative state is refreshed.
        try {
          this.accept(await this.api<Snapshot>('/api/state'), generation);
        } catch (error) {
          if (generation === this.generation) this.error.set(String(error));
        } finally {
          if (generation === this.generation) this.pending.set(false);
        }
      }
    }
  }

  save(plan: Plan): Promise<void> {
    return this.action(async generation => this.accept(await this.api<Snapshot>('/api/plan', plan), generation));
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

  run(): Promise<void> {
    return this.action(() => this.api('/api/run', { caller: 'user' }));
  }

  requestDetection(): void {
    this.detectionRequested = true;
    void this.checkAvailability();
  }

  private async checkAvailability(): Promise<void> {
    if (!this.detectionRequested || this.disabled()) return;

    this.detectionRequested = false;

    await this.action(async generation => this.accept(await this.api<Snapshot>('/api/detect', {}), generation));
  }

  private async poll(): Promise<void> {
    if (this.polling || this.restarting()) return;

    const generation = this.generation;
    this.polling = true;

    try {
      this.accept(await this.api<Snapshot>('/api/state'), generation);
      if (generation === this.generation) await this.checkAvailability();
    } catch (error) {
      if (generation === this.generation && !this.restarting()) this.error.set(String(error));
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
    this.error.set('');

    try {
      await firstValueFrom(this.serverControl.restart().pipe(takeUntil(this.cancel)));

      if (generation === this.generation) location.reload();
    } catch (error) {
      if (generation === this.generation) this.error.set(String(error));
    } finally {
      if (generation === this.generation) {
        this.restarting.set(false);
        this.pending.set(false);
        this.polling = false;
      }
    }
  }
}
