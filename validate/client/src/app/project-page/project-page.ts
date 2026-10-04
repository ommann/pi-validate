import { ChangeDetectionStrategy, Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { format, formatDistanceStrict, isSameDay, isSameYear } from 'date-fns';
import { CdkDrag, CdkDragHandle, CdkDropList, CdkDropListGroup, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import type { CdkDragDrop } from '@angular/cdk/drag-drop';

import { activeGroups, editPlan } from '@shared/plan.js';
import { ValidationClient } from '@app/validation';
import type { Parameter, Policy, Run } from '@app/models';
import { ResultCard } from '@app/result-card/result-card';

@Component({
  selector: 'app-project-page',
  imports: [DatePipe, ResultCard, CdkDrag, CdkDragHandle, CdkDropList, CdkDropListGroup],
  providers: [ValidationClient],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './project-page.html',
})
export class ProjectPage {
  readonly cwd = input.required<string>();
  readonly client = inject(ValidationClient);
  readonly search = signal('');

  readonly expandedHistory = signal(false);
  readonly expandedDurations = signal<ReadonlySet<string>>(new Set());
  readonly selectedId = signal('');
  readonly followLatest = signal(true);

  readonly openSteps = new Set<string>();
  readonly policies: readonly Policy[] = ['agent', 'user', 'off'];

  readonly groups = linkedSignal(() => {
    const plan = this.client.plan();
    const groups = plan ? activeGroups(plan) : [];

    return [...groups, []];
  });

  readonly available = computed(() => {
    const state = this.client.state();
    const query = this.search().trim().toLowerCase();

    return state?.steps.filter(step => state.plan.removed?.includes(step.name) && step.name.toLowerCase().includes(query)) ?? [];
  });

  readonly selectedRun = computed(() => this.client.state()?.runs.find(run => run.id === this.selectedId()));
  readonly runResults = computed(() => this.selectedRun()?.results.filter(result =>
    result.status === 'running' || result.status === 'passed' || result.status === 'failed'
    || (result.status === 'cancelled' && !!result.startedAt),
  ) ?? []);

  readonly visibleRuns = computed(() => {
    const runs = this.client.state()?.runs ?? [];
    const recent = runs.slice(-5);

    return this.expandedHistory() ? runs : runs.filter(run => recent.includes(run) || run.id === this.selectedId());
  });

  constructor() {
    effect(() => {
      const cwd = this.cwd();

      this.search.set('');

      this.expandedHistory.set(false);
      this.expandedDurations.set(new Set());
      this.selectedId.set('');
      this.followLatest.set(true);

      this.openSteps.clear();

      untracked(() => this.client.openProject(cwd));
    });

    effect(() => {
      const state = this.client.state();
      if (!state) return;

      if (this.followLatest() || !state.runs.some(run => run.id === this.selectedId())) {
        this.selectedId.set(state.runs.at(-1)?.id ?? '');
      }
    });
  }

  enableStep(name: string, policy: Policy): void {
    const plan = this.client.plan();
    if (!plan) { return; }

    void this.client.save(editPlan(editPlan(plan, name, 'add'), name, policy));
  }

  useNix(value: boolean): void {
    const plan = this.client.state()?.plan;

    if (plan) void this.client.save({ ...plan, useNix: value });
  }

  parameters(name: string): [string, Parameter][] {
    return Object.entries(this.client.state()?.steps.find(step => step.name === name)?.parameters ?? {});
  }

  config(name: string, key: string, parameter: Parameter): number {
    return Number(this.client.state()?.plan.configs?.[name]?.[key] ?? parameter.default);
  }

  unavailable(name: string): boolean {
    const detection = this.client.state()?.steps.find(step => step.name === name)?.detection;

    return detection?.applicable === false && !detection.error;
  }

  detection(name: string): string {
    const detection = this.client.state()?.steps.find(step => step.name === name)?.detection;

    return !detection ? 'Not checked' : detection.error ? `Error: ${detection.error}` : detection.applicable ? 'Applicable' : 'Not applicable';
  }

  selectRun(run: Run): void {
    this.selectedId.set(run.id);
    this.followLatest.set(run.id === this.client.state()?.runs.at(-1)?.id);
  }

  count(run: Run, status: string): number {
    return run.results.filter(result => result.status === status).length;
  }

  runTime(timestamp: string): string {
    const date = new Date(timestamp);
    const now = new Date(Date.now());
    const age = Math.max(0, now.getTime() - date.getTime());

    if (age < 1000) return 'just now';
    if (age < 3_600_000) {
      return formatDistanceStrict(date, now, {
        addSuffix: true,
        unit: age < 60_000 ? 'second' : 'minute',
        roundingMethod: 'floor',
      });
    }

    return format(date, isSameDay(date, now) ? 'HH:mm' : isSameYear(date, now) ? 'MMM d, HH:mm' : 'MMM d yyyy, HH:mm');
  }

  formatDuration(milliseconds: number): string {
    return milliseconds < 100_000 ? `${milliseconds}ms` : `${Math.round(milliseconds / 1000)}s`;
  }

  duration(run: Run): number {
    const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();

    return Math.max(0, end - Date.parse(run.startedAt));
  }

  toggleDuration(id: string): void {
    this.expandedDurations.update(current => {
      const next = new Set(current);

      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });
  }

  durationDetails(run: Run) {
    const now = Date.now();

    return run.plan.groups.map((group, index) => {
      const results = run.results.filter(result => group.includes(result.name));
      const started = results.filter(result => result.startedAt);
      const steps = group.map(name => {
        const result = results.find(result => result.name === name);
        const end = result?.finishedAt ? Date.parse(result.finishedAt) : now;
        const duration = result?.startedAt ? Math.max(0, end - Date.parse(result.startedAt)) : 0;

        return { name, duration, status: result?.status ?? 'pending' };
      });
      const start = started.length ? Math.min(...started.map(result => Date.parse(result.startedAt!))) : now;
      const end = started.length ? Math.max(...started.map(result => result.finishedAt ? Date.parse(result.finishedAt) : now)) : now;

      return {
        label: `Steps ${index + 1}`,
        duration: Math.max(0, end - start),
        running: started.some(result => !result.finishedAt),
        steps,
      };
    });
  }

  run(): void {
    this.followLatest.set(true);
    void this.client.run();
  }

  stepKey(event: KeyboardEvent, name: string): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

    event.preventDefault();
    this.client.changePlan(name, event.ctrlKey ? (event.key === 'ArrowUp' ? 'join' : 'separate') : (event.key === 'ArrowUp' ? 'up' : 'down'));
  }

  readonly sectionSort = (index: number): boolean => index < this.groups().length - 1;

  sectionKey(event: KeyboardEvent, index: number): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

    event.preventDefault();
    void this.moveSection(index, index + (event.key === 'ArrowUp' ? -1 : 1));
  }

  async dropSection(event: CdkDragDrop<string[][], string[][], string[]>): Promise<void> {
    if (!event.isPointerOverContainer || event.previousContainer !== event.container) return;

    await this.moveSection(event.previousIndex, event.currentIndex);
  }

  private async moveSection(from: number, to: number): Promise<void> {
    const plan = this.client.plan();
    if (!plan || this.client.editingDisabled()) return;

    const groups = this.groups().filter(group => group.length).map(group => [...group]);
    if (from === to || from < 0 || to < 0 || from >= groups.length || to >= groups.length) return;

    const cwd = this.cwd();
    moveItemInArray(groups, from, to);
    await this.client.save({ ...plan, groups });

    if (cwd === this.cwd()) {
      const saved = this.client.plan();

      this.groups.set([...(saved ? activeGroups(saved) : []), []]);
    }
  }

  async drop(event: CdkDragDrop<string[], string[], string>): Promise<void> {
    if (!event.isPointerOverContainer || this.client.editingDisabled()) { return; }

    const plan = this.client.plan();
    if (!plan) return;

    const cwd = this.cwd();

    if (event.previousContainer === event.container) {
      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
    } else {
      transferArrayItem(event.previousContainer.data, event.container.data, event.previousIndex, event.currentIndex);
    }

    // The final empty list is a creation target, not a saved execution section.
    const groups = this.groups().filter(group => group.length).map(group => [...group]);

    await this.client.save({ ...plan, groups });

    // Restore the trailing creation target even when the saved plan is unchanged.
    if (cwd === this.cwd()) {
      const saved = this.client.plan();

      this.groups.set([...(saved ? activeGroups(saved) : []), []]);
    }
  }

  toggleStep(name: string, open: boolean): void {
    if (open) this.openSteps.add(name);
    else this.openSteps.delete(name);
  }

  checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  numberValue(event: Event): number {
    return Number(this.value(event));
  }

  summaryClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('button')) event.preventDefault();
  }
}
