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

  it('uses only Run and Stop labels and disables Stop during cleanup', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl(projectPath('/tmp/project'));
    await fixture.whenStable();

    const page = fixture.debugElement.query(By.directive(ProjectPage)).componentInstance as ProjectPage;
    const button = fixture.nativeElement.querySelector('#run') as HTMLButtonElement;
    expect(button.textContent).toBe('Run');

    page.client.state.update(state => state ? { ...state, busy: true, running: true } : state);
    await fixture.whenStable();
    expect(button.textContent).toBe('Stop');
    expect(button.disabled).toBe(false);

    const stop = vi.spyOn(page.client, 'stop').mockResolvedValue();
    button.click();
    expect(stop).toHaveBeenCalledOnce();

    page.client.stopping.set(true);
    await fixture.whenStable();
    expect(button.textContent).toBe('Stop');
    expect(button.disabled).toBe(true);

    page.client.stopping.set(false);
    page.client.state.update(state => state ? { ...state, busy: false, running: false } : state);
    await fixture.whenStable();
    expect(button.textContent).toBe('Run');
    expect(button.disabled).toBe(false);
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
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
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

  it('humanizes recent run times and switches older runs to clock time', async () => {
    const now = new Date(2026, 5, 2, 12, 0, 0).getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl(projectPath('/tmp/project'));
    await fixture.whenStable();

    const page = fixture.debugElement.query(By.directive(ProjectPage)).componentInstance as ProjectPage;
    const ago = (milliseconds: number) => new Date(now - milliseconds).toISOString();

    expect(page.runTime(ago(0))).toBe('just now');
    expect(page.runTime(ago(45_000))).toBe('45 seconds ago');
    expect(page.runTime(ago(60_000))).toBe('1 minute ago');
    expect(page.runTime(ago(59 * 60_000))).toBe('59 minutes ago');
    expect(page.runTime(ago(60 * 60_000))).toBe('11:00');
    expect(page.runTime(new Date(2026, 5, 1, 12).toISOString())).toBe('Jun 1, 12:00');
    expect(page.runTime(new Date(2025, 5, 1, 12).toISOString())).toBe('Jun 1 2025, 12:00');

    const plan = { groups: [], policies: {} };
    page.client.state.set({
      cwd: '/tmp/project', busy: false, plan, steps: [],
      runs: [{ id: 'recent', caller: 'agent', plan, results: [], startedAt: ago(45_000), finishedAt: ago(40_000) }],
    });
    await fixture.whenStable();

    const timestamp = fixture.nativeElement.querySelector('#history .run-row > span');
    expect(timestamp.textContent).toBe('45 seconds ago');
    expect(timestamp.getAttribute('title')).toBeTruthy();

    vi.mocked(Date.now).mockReturnValue(now + 15_000);
    page.client.state.update(state => state ? { ...state } : state);
    await fixture.whenStable();

    expect(timestamp.textContent).toBe('1 minute ago');
  });

  it('orders history downwards with the latest run closest to the results', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl(projectPath('/tmp/project'));
    await fixture.whenStable();

    const page = fixture.debugElement.query(By.directive(ProjectPage)).componentInstance as ProjectPage;
    const plan = { groups: [], policies: {} };
    const runs = Array.from({ length: 7 }, (_, index) => ({
      id: `run-${index}`, caller: 'user' as const, plan, results: [],
      startedAt: `2026-01-01T12:00:0${index}Z`, finishedAt: `2026-01-01T12:00:0${index}Z`,
    }));

    page.client.state.set({ cwd: '/tmp/project', busy: false, plan, steps: [], runs });
    await fixture.whenStable();

    expect(page.visibleRuns().map(run => run.id)).toEqual(['run-2', 'run-3', 'run-4', 'run-5', 'run-6']);
    page.selectRun(runs[0]);
    expect(page.visibleRuns().map(run => run.id)).toEqual(['run-0', 'run-2', 'run-3', 'run-4', 'run-5', 'run-6']);

    page.expandedHistory.set(true);
    expect(page.visibleRuns().map(run => run.id)).toEqual(runs.map(run => run.id));
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
    expect(page.formatDuration(99_999)).toBe('99999ms');
    expect(page.formatDuration(100_000)).toBe('100s');
    expect(page.formatDuration(123_456)).toBe('123s');
    expect(compiled.querySelector('.run-duration > span')?.textContent).toBe('60000ms');
    expect(compiled.querySelector('.run-duration')?.getAttribute('aria-label')).toBe('Elapsed time: 60000 milliseconds');
    expect(count?.textContent).toBe('1/2');
    expect(count?.getAttribute('aria-label')).toBe('1 passed, 1 failed, 2 skipped');
    expect(compiled.querySelectorAll('#results app-result-card')).toHaveLength(2);
    expect(compiled.querySelector('#results')?.textContent).not.toContain('never-applicable');
    expect(compiled.querySelector<HTMLParagraphElement>('#summary')?.hidden).toBe(true);
  });

  it('expands and collapses section timings from the milliseconds button', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T12:00:04Z'));

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl(projectPath('/tmp/project'));
    await fixture.whenStable();

    const page = fixture.debugElement.query(By.directive(ProjectPage)).componentInstance as ProjectPage;
    const plan = { groups: [['build', 'lint'], ['test'], ['disabled'], ['pending']], policies: {} };

    page.client.state.set({
      cwd: '/tmp/project', busy: true, plan, steps: [],
      runs: [{
        id: 'sections', caller: 'agent', plan, startedAt: '2026-01-01T12:00:00Z',
        results: [
          { name: 'build', policy: 'agent', status: 'passed', output: '', startedAt: '2026-01-01T12:00:00Z', finishedAt: '2026-01-01T12:00:01Z' },
          { name: 'lint', policy: 'agent', status: 'passed', output: '', startedAt: '2026-01-01T12:00:00.100Z', finishedAt: '2026-01-01T12:00:02Z' },
          { name: 'test', policy: 'agent', status: 'running', output: '', startedAt: '2026-01-01T12:00:02Z' },
          { name: 'disabled', policy: 'off', status: 'skipped', output: '' },
          { name: 'pending', policy: 'agent', status: 'pending', output: '' },
        ],
      }],
    });
    await fixture.whenStable();

    const compiled = fixture.nativeElement as HTMLElement;
    const toggle = compiled.querySelector<HTMLButtonElement>('.run-duration')!;
    const sections = compiled.querySelector<HTMLElement>('.run-sections')!;

    expect(toggle.hasAttribute('title')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(sections.hidden).toBe(true);

    toggle.click();
    await fixture.whenStable();

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(sections.hidden).toBe(false);
    expect(sections.firstElementChild?.className).toBe('run-audience-timings');
    expect(Array.from(sections.querySelectorAll('.run-audience-timings .policy-pill'), pill => pill.textContent)).toEqual(['Agent', 'User']);
    expect(Array.from(sections.querySelectorAll('summary'), child => child.textContent)).toEqual([
      'Steps 12000ms',
      'Steps 22000ms',
      'Steps 30ms',
      'Steps 40ms',
    ]);

    const section = sections.querySelector<HTMLDetailsElement>('.section-timing')!;
    expect(section.open).toBe(false);
    section.querySelector('summary')!.click();
    expect(section.open).toBe(true);
    expect(Array.from(section.querySelectorAll('.step-timing'), row =>
      Array.from(row.children, child => child.textContent),
    )).toEqual([
      ['build', '1000ms', ''],
      ['lint', '1900ms', ''],
    ]);
    section.querySelector('summary')!.click();
    expect(section.open).toBe(false);

    toggle.click();
    await fixture.whenStable();

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(sections.hidden).toBe(true);
  });

  it('shows elapsed milliseconds for an ongoing run', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T12:00:01Z'));

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl(projectPath('/tmp/project'));
    await fixture.whenStable();

    const page = fixture.debugElement.query(By.directive(ProjectPage)).componentInstance as ProjectPage;
    const plan = { groups: [], policies: {} };

    page.client.state.set({
      cwd: '/tmp/project', busy: true, plan, steps: [],
      runs: [{ id: 'running', caller: 'agent', plan, startedAt: '2026-01-01T12:00:00Z', results: [] }],
    });
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.run-duration > span')?.textContent).toBe('1000ms');
    const audienceTimes = () => Array.from(fixture.nativeElement.querySelectorAll('.run-audience-timings > span'),
      span => (span as HTMLElement).textContent?.trim());
    expect(audienceTimes()).toEqual(['1000ms … Agent', '1000ms … User']);

    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-01-01T12:00:02Z'));
    page.client.state.update(state => state ? { ...state, runs: state.runs.map(run => ({ ...run, agentFinishedAt: '2026-01-01T12:00:00.500Z' })) } : state);
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.run-duration > span')?.textContent).toBe('2000ms');
    expect(audienceTimes()).toEqual(['500ms Agent', '2000ms … User']);

    page.client.state.update(state => state ? { ...state, runs: state.runs.map(run => ({ ...run, finishedAt: '2026-01-01T12:00:03Z' })) } : state);
    await fixture.whenStable();
    expect(audienceTimes()).toEqual(['500ms Agent', '3000ms User']);
    expect(fixture.nativeElement.querySelector('.run-duration > span')?.textContent).toBe('3000ms');

    const agentOnly = fixture.nativeElement.querySelector('#show-agent-duration') as HTMLInputElement;
    expect(agentOnly.checked).toBe(false);
    agentOnly.click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.run-duration > span')?.textContent).toBe('500ms');
    expect(fixture.nativeElement.querySelector('.run-duration')?.getAttribute('aria-label')).toBe('Agent elapsed time: 500 milliseconds');
    expect(audienceTimes()).toEqual(['500ms Agent', '3000ms User']);

    agentOnly.click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.run-duration > span')?.textContent).toBe('3000ms');
  });

  it('moves whole sections independently of their nested step lists', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await TestBed.inject(Router).navigateByUrl(projectPath('/tmp/project'));
    await fixture.whenStable();

    const page = fixture.debugElement.query(By.directive(ProjectPage)).componentInstance as ProjectPage;
    const plan = {
      groups: [['build', 'lint'], ['test'], ['new-rule']],
      policies: { build: 'agent', lint: 'agent', test: 'agent', 'new-rule': 'user' },
      configs: { 'new-rule': { threshold: 80 } }, useNix: true,
    } as const;
    page.client.state.set({
      cwd: '/tmp/project', busy: false, steps: [], runs: [],
      plan: { ...plan, groups: [['build', 'lint'], ['test'], ['new-rule']] },
    });
    await fixture.whenStable();

    const outer = fixture.debugElement.query(By.css('#steps')).injector.get(CdkDropList<string[][]>);
    const sections = fixture.debugElement.queryAll(By.css('.step-group'))
      .map(element => element.injector.get(CdkDrag<string[]>));
    const inner = fixture.debugElement.queryAll(By.css('.step-list'))
      .map(element => element.injector.get(CdkDropList<string[]>));
    const save = vi.spyOn(page.client, 'save').mockImplementation(async next => {
      page.client.state.update(state => state ? { ...state, plan: next } : state);
    });

    expect(outer.getSortedItems()).toEqual(sections);
    expect(inner[0].getSortedItems().map(drag => drag.data)).toEqual(['build', 'lint']);
    expect(sections.at(-1)?.disabled).toBe(true);
    expect(page.sectionSort(2)).toBe(true);
    expect(page.sectionSort(3)).toBe(false);

    const dropped = {
      item: sections[2], previousContainer: outer, container: outer,
      previousIndex: 2, currentIndex: 1, isPointerOverContainer: true,
      distance: { x: 0, y: -30 }, dropPoint: { x: 0, y: 30 }, event: new MouseEvent('mouseup'),
    };

    outer.dropped.emit({ ...dropped, isPointerOverContainer: false });
    expect(save).not.toHaveBeenCalled();
    page.client.pending.set(true);
    outer.dropped.emit(dropped);
    expect(save).not.toHaveBeenCalled();
    page.client.pending.set(false);

    outer.dropped.emit(dropped);
    await fixture.whenStable();
    expect(save).toHaveBeenCalledWith({ ...plan, groups: [['build', 'lint'], ['new-rule'], ['test']] });
    expect(page.groups()).toEqual([['build', 'lint'], ['new-rule'], ['test'], []]);

    const handle = fixture.nativeElement.querySelectorAll('.section-handle')[1] as HTMLButtonElement;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await fixture.whenStable();
    expect(page.groups()).toEqual([['new-rule'], ['build', 'lint'], ['test'], []]);

    save.mockClear();
    page.sectionKey(new KeyboardEvent('keydown', { key: 'ArrowUp' }), 0);
    page.sectionKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }), 2);
    await fixture.whenStable();
    expect(save).not.toHaveBeenCalled();
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

    const lists = fixture.debugElement.queryAll(By.css('.step-list'))
      .map(element => element.injector.get(CdkDropList<string[]>));
    const drags = fixture.debugElement.queryAll(By.css('.step-details'))
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
    expect(fixture.debugElement.queryAll(By.directive(CdkDragHandle))).toHaveLength(4);
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
    const updatedLists = fixture.debugElement.queryAll(By.css('.step-list'))
      .map(element => element.injector.get(CdkDropList<string[]>));

    expect(updatedLists.map(list => list.data)).toEqual([...groups, []]);
    expect(compiled.querySelectorAll('.phantom-section')).toHaveLength(1);
  });
});
