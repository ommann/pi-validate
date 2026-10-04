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
    expect(compiled.querySelector<HTMLInputElement>('#project')?.value).toBe(cwd);
    expect(ValidationClient.prototype.openProject).toHaveBeenCalledWith(cwd);
    expect(compiled.querySelector('#summary')?.textContent).toBe('No runs yet.');
    expect(compiled.querySelector<HTMLButtonElement>('#run')?.disabled).toBe(false);
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
