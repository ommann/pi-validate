import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { By } from '@angular/platform-browser';
import { CdkDrag, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@app/app';
import { appConfig } from '@app/app.config';
import { ValidationClient } from '@app/validation';
import { ProjectPage } from '@app/project-page/project-page';
import { projectPath } from '@shared/project-path';

// Routing/rendering specs use an idle project, without starting network polling.
describe('App', () => {
  beforeEach(async () => {
    vi.spyOn(ValidationClient.prototype, 'openProject').mockImplementation(function (this: ValidationClient, cwd: string) {
      this.state.set({ cwd, busy: false, plan: { groups: [], policies: {} }, steps: [], runs: [] });
    });
    await TestBed.configureTestingModule({
      imports: [App],
      providers: appConfig.providers,
    }).compileComponents();
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates the app shell with a router outlet', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect(fixture.componentInstance).toBeTruthy();
    expect(fixture.nativeElement.querySelector('router-outlet')).not.toBeNull();
  });

  it('renders the Validate UI for an encoded project URL', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const cwd = '/tmp/a space # % ü';
    await TestBed.inject(Router).navigateByUrl(projectPath(cwd));
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toBe('Validate');
    expect(compiled.querySelector('#project-form')).toBeNull();
    expect(ValidationClient.prototype.openProject).toHaveBeenCalledWith(cwd);
    expect(compiled.querySelector('#summary')?.textContent).toBe('No runs yet.');
    expect(compiled.querySelector<HTMLButtonElement>('#run')?.disabled).toBe(false);
  });

  it('filters disabled steps in rows matching the enabled steps', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl(projectPath('/tmp/project'));
    await fixture.whenStable();

    const page = fixture.debugElement.query(By.directive(ProjectPage)).componentInstance as ProjectPage;
    page.client.state.set({
      cwd: '/tmp/project', busy: false, runs: [],
      plan: { groups: [], policies: {}, removed: ['build', 'lint'] },
      steps: [
        { name: 'build', parameters: {}, detection: null },
        { name: 'lint', parameters: {}, detection: null },
      ],
    });
    await fixture.whenStable();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('#catalog summary')?.textContent).toBe('Disabled steps');
    expect(compiled.querySelector<HTMLDetailsElement>('#catalog')?.open).toBe(false);
    expect(compiled.querySelectorAll('#available-steps .run-row.step-row')).toHaveLength(2);

    const detect = vi.spyOn(page.client, 'requestDetection').mockImplementation(() => {});
    const catalog = compiled.querySelector<HTMLDetailsElement>('#catalog')!;
    for (const open of [true, false, true]) {
      catalog.open = open;
      await new Promise(resolve => setTimeout(resolve, 0));
      await fixture.whenStable();
      expect(page.client.pending()).toBe(false);
      expect(page.client.editingDisabled()).toBe(false);
    }
    expect(detect).toHaveBeenCalledTimes(2);

    const filter = compiled.querySelector<HTMLInputElement>('#step-search')!;
    filter.value = 'lint';
    filter.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(compiled.querySelectorAll('#available-steps .run-row')).toHaveLength(1);
    expect(compiled.querySelector('#available-steps .run-row')?.textContent).toContain('lint');

    const save = vi.spyOn(page.client, 'save').mockResolvedValue();
    const buttons = compiled.querySelectorAll<HTMLButtonElement>('#available-steps button');
    expect(Array.from(buttons, button => button.textContent)).toEqual(['Agent', 'User', 'Off', '×']);
    expect(buttons[3].disabled).toBe(true);
    buttons[1].click();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      groups: [['lint']], policies: { lint: 'user' }, removed: ['build'],
    }));
  });

  it('keeps the parameter input mounted and enabled during optimistic saves', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl(projectPath('/tmp/project'));
    await fixture.whenStable();

    const page = fixture.debugElement.query(By.directive(ProjectPage)).componentInstance as ProjectPage;
    page.client.state.set({
      cwd: '/tmp/project', busy: false, runs: [],
      plan: { groups: [['build']], policies: { build: 'agent' } },
      steps: [{ name: 'build', detection: null, parameters: {
        ratio: { type: 'number', label: 'Minimum empty line ratio', default: 0.1, step: 0.1 },
      } }],
    });
    await fixture.whenStable();

    const compiled = fixture.nativeElement as HTMLElement;
    const input = compiled.querySelector<HTMLInputElement>('.step-parameter input')!;
    page.client.saving.set(true);
    page.client.pending.set(true);
    page.client.state.update(state => state ? {
      ...state, busy: true, plan: { ...state.plan, configs: { build: { ratio: 0.2 } } },
    } : state);
    await fixture.whenStable();

    expect(compiled.querySelector('.step-parameter input')).toBe(input);
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('0.2');
    expect(compiled.querySelector('#run')?.textContent).toBe('Run');
  });

  it('never renders pending or skipped steps and preserves cards once execution starts', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl(projectPath('/tmp/project'));
    await fixture.whenStable();

    const page = fixture.debugElement.query(By.directive(ProjectPage)).componentInstance as ProjectPage;
    const plan = { groups: [['never-applicable', 'build']], policies: { 'never-applicable': 'agent', build: 'agent' } } as const;
    page.client.state.set({
      cwd: '/tmp/project', busy: true, steps: [],
      plan: { ...plan, groups: [['never-applicable', 'build']] },
      runs: [{
        id: 'test-run', caller: 'user', startedAt: '2026-01-01T12:00:00Z',
        plan: { ...plan, groups: [['never-applicable', 'build']] },
        results: [
          { name: 'never-applicable', policy: 'agent', status: 'pending', output: '' },
          { name: 'build', policy: 'agent', status: 'pending', output: '' },
        ],
      }],
    });
    await fixture.whenStable();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelectorAll('#results app-result-card')).toHaveLength(0);

    page.client.state.update(state => state ? {
      ...state, runs: state.runs.map(run => ({ ...run, results: run.results.map(result => ({
        ...result, status: result.name === 'never-applicable' ? 'skipped' : 'running',
      })) })),
    } : state);
    await fixture.whenStable();
    const card = compiled.querySelector('#results app-result-card');
    expect(compiled.querySelectorAll('#results app-result-card')).toHaveLength(1);
    expect(card?.textContent).toContain('build');
    expect(compiled.querySelector('#results')?.textContent).not.toContain('never-applicable');

    page.client.state.update(state => state ? {
      ...state, runs: state.runs.map(run => ({ ...run, results: run.results.map(result =>
        result.name === 'build' ? { ...result, status: 'passed', output: 'Done' } : result,
      ) })),
    } : state);
    await fixture.whenStable();
    expect(compiled.querySelector('#results app-result-card')).toBe(card);
    expect(card?.textContent).toContain('Done');
  });

  it('shows passed/total in the run row without a verbose summary', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl(projectPath('/tmp/project'));
    await fixture.whenStable();

    const page = fixture.debugElement.query(By.directive(ProjectPage)).componentInstance as ProjectPage;
    const plan = { groups: [], policies: {} };
    page.client.state.set({
      cwd: '/tmp/project', busy: false, plan, steps: [],
      runs: [{
        id: 'test-run', caller: 'user', plan,
        startedAt: '2026-01-01T12:00:00Z', finishedAt: '2026-01-01T12:01:00Z',
        results: [
          { name: 'build', policy: 'agent', status: 'passed', output: '' },
          { name: 'lint', policy: 'agent', status: 'failed', output: '' },
          { name: 'test', policy: 'off', status: 'skipped', output: '' },
          { name: 'never-applicable', policy: 'agent', status: 'skipped', reason: 'Not applicable', output: '' },
        ],
      }],
    });
    await fixture.whenStable();

    const compiled = fixture.nativeElement as HTMLElement;
    const count = compiled.querySelector('#history .run-row span:nth-child(3)');
    expect(count?.textContent).toBe('1/2');
    expect(count?.getAttribute('aria-label')).toBe('1 passed, 1 failed, 2 skipped');
    expect(compiled.querySelectorAll('#results app-result-card')).toHaveLength(2);
    expect(compiled.querySelector('#results')?.textContent).not.toContain('never-applicable');
    expect(compiled.querySelector<HTMLParagraphElement>('#summary')?.hidden).toBe(true);
  });

  it.each([
    { source: 0, target: 1, groups: [['lint', 'build']] },
    { source: 0, target: 2, groups: [['lint'], ['build']] },
    { source: 1, target: 2, groups: [['build'], ['lint']] },
  ])('moves row $source into section $target with ordinary CDK lists', async ({ source, target, groups }) => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl(projectPath('/tmp/project'));
    await fixture.whenStable();

    const page = fixture.debugElement.query(By.directive(ProjectPage)).componentInstance as ProjectPage;
    const plan = { groups: [['build'], ['lint']], policies: { build: 'agent', lint: 'agent' } } as const;
    page.client.state.set({
      cwd: '/tmp/project', busy: false, steps: [], runs: [],
      plan: { ...plan, groups: [['build'], ['lint']] },
    });
    await fixture.whenStable();

    const compiled = fixture.nativeElement as HTMLElement;

    const lists = fixture.debugElement.queryAll(By.directive(CdkDropList))
      .map(element => element.injector.get(CdkDropList<string[]>));
    const drags = fixture.debugElement.queryAll(By.directive(CdkDrag))
      .map(element => element.injector.get(CdkDrag<string>));
    const save = vi.spyOn(page.client, 'save').mockImplementation(async next => {
      page.client.state.update(state => state ? { ...state, plan: next } : state);
    });

    expect(lists.map(list => list.data)).toEqual([['build'], ['lint'], []]);
    expect(compiled.querySelector('[role="separator"]')).toBeNull();
    expect(compiled.querySelector('#new-section')).toBeNull();
    expect(compiled.querySelector('.empty-section')).toBeNull();
    expect(compiled.querySelector('.phantom-section')?.childElementCount).toBe(0);
    expect(compiled.querySelector('[title]')).toBeNull();
    expect(drags.map(drag => drag.data)).toEqual(['build', 'lint']);
    expect(fixture.debugElement.queryAll(By.directive(CdkDragHandle))).toHaveLength(2);
    expect(lists[0].getSortedItems()).toContain(drags[0]);
    expect(lists.every(list => !list.sortingDisabled)).toBe(true);

    // A poll with unchanged configuration must not replace the arrays CDK is dragging.
    const beforePoll = lists[0].data;
    page.client.state.update(state => state ? { ...state, plan: structuredClone(state.plan) } : state);
    await fixture.whenStable();
    expect(lists[0].data).toBe(beforePoll);

    const dropped = {
      item: drags[source], previousContainer: lists[source], container: lists[target],
      previousIndex: 0, currentIndex: lists[target].data.length, isPointerOverContainer: true,
      distance: { x: 0, y: 30 }, dropPoint: { x: 0, y: 30 }, event: new MouseEvent('mouseup'),
    };

    lists[target].dropped.emit({ ...dropped, isPointerOverContainer: false });
    expect(save).not.toHaveBeenCalled();

    page.client.pending.set(true);
    await fixture.whenStable();
    expect(drags.every(drag => drag.disabled)).toBe(true);
    expect(lists.every(list => list.disabled)).toBe(true);

    lists[target].dropped.emit(dropped);
    expect(save).not.toHaveBeenCalled();

    page.client.pending.set(false);
    lists[target].dropped.emit(dropped);
    await fixture.whenStable();

    expect(save).toHaveBeenCalledWith({ ...plan, groups });
    expect(page.client.state()?.plan.groups).toEqual(groups);
    const updatedLists = fixture.debugElement.queryAll(By.directive(CdkDropList))
      .map(element => element.injector.get(CdkDropList<string[]>));

    expect(updatedLists.map(list => list.data)).toEqual([...groups, []]);
    expect(compiled.querySelectorAll('.phantom-section')).toHaveLength(1);
  });
});
