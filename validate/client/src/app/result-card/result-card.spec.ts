import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResultCard } from './result-card';
import type { Result } from '@app/models';

describe('ResultCard durations', () => {
  afterEach(() => vi.restoreAllMocks());

  function render(result: Result) {
    const fixture = TestBed.createComponent(ResultCard);
    fixture.componentRef.setInput('caller', 'agent');
    fixture.componentRef.setInput('result', result);
    fixture.detectChanges();
    return fixture;
  }

  it('shows completed step time in the header and keeps it fixed', () => {
    const fixture = render({ name: 'test', policy: 'agent', status: 'passed', output: '',
      startedAt: '2026-01-01T12:00:00Z', finishedAt: '2026-01-01T12:00:01.250Z' });
    expect(fixture.nativeElement.querySelector('summary .result-duration')?.textContent).toBe('1250ms');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T12:05:00Z'));
    expect(fixture.componentInstance.duration()).toBe('1250ms');
  });

  it('updates elapsed time while running and uses seconds for long steps', () => {
    const result: Result = { name: 'test', policy: 'user', status: 'running', output: '',
      startedAt: '2026-01-01T12:00:00Z' };
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T12:00:01Z'));
    const fixture = render(result);
    expect(fixture.nativeElement.querySelector('.result-duration')?.textContent).toBe('1000ms');
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-01-01T12:02:00Z'));
    fixture.componentRef.setInput('result', { ...result });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.result-duration')?.textContent).toBe('120s');
  });

  it('omits duration for steps that never started', () => {
    const fixture = render({ name: 'test', policy: 'off', status: 'skipped', output: '' });
    expect(fixture.nativeElement.querySelector('.result-duration')).toBeNull();
  });

  it('shows zero and cancelled durations', () => {
    const fixture = render({ name: 'test', policy: 'agent', status: 'cancelled', output: '',
      startedAt: '2026-01-01T12:00:00Z', finishedAt: '2026-01-01T12:00:00Z' });
    expect(fixture.nativeElement.querySelector('.result-duration')?.textContent).toBe('0ms');
  });
});
