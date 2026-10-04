import { ChangeDetectionStrategy, Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CdkDrag, CdkDragHandle, CdkDropList, CdkDropListGroup, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import type { CdkDragDrop } from '@angular/cdk/drag-drop';

import { activeGroups } from '@shared/plan.js';
import { projectPath } from '@shared/project-path';
import { ValidationClient } from '@app/validation';
import type { Parameter, Policy, Run } from '@app/models';
import { ResultCard } from '@app/result-card/result-card';

@Component({
  selector: 'app-project-page',
  imports: [FormsModule, ResultCard, CdkDrag, CdkDragHandle, CdkDropList, CdkDropListGroup],
  providers: [ValidationClient],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './project-page.html',
})
export class ProjectPage {
  readonly cwd = input.required<string>();
  readonly client = inject(ValidationClient);
  private readonly router = inject(Router);

  readonly project = signal('');
  readonly search = signal('');

  readonly expandedHistory = signal(false);
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

  readonly visibleRuns = computed(() => {
    const runs = [...(this.client.state()?.runs ?? [])].reverse();
    const visible = this.expandedHistory() ? runs : runs.slice(0, 5);
    const selected = runs.find(run => run.id === this.selectedId());

    if (selected && !visible.includes(selected)) visible.push(selected);

    return visible;
  });

  constructor() {
    effect(() => {
      const cwd = this.cwd();

      this.project.set(cwd);
      this.search.set('');

      this.expandedHistory.set(false);
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

  openProject(): void {
    const cwd = this.project().trim();

    if (!cwd.startsWith('/')) {
      this.client.error.set('Use an absolute project path.');
      return;
    }

    this.router.navigateByUrl(projectPath(cwd.replace(/\/+$/, '') || '/'))
      .catch(error => this.client.error.set(String(error)));
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

  startedAt(run: Run): string {
    return new Date(run.startedAt).toLocaleString();
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

  async drop(event: CdkDragDrop<string[], string[], string>): Promise<void> {
    if (!event.isPointerOverContainer || this.client.disabled()) return;

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
