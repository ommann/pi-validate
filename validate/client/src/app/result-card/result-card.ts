import { ChangeDetectionStrategy, Component, ElementRef, effect, input, viewChild } from '@angular/core';

import { AnsiOutput } from '@app/ansi-output';
import type { Policy, Result } from '@app/models';

@Component({
  selector: 'app-result-card',
  imports: [AnsiOutput],
  templateUrl: './result-card.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultCard {
  readonly result = input.required<Result>();
  readonly caller = input.required<'agent' | 'user'>();

  readonly card = viewChild.required<ElementRef<HTMLDetailsElement>>('card');

  private previousStatus?: Result['status'];

  constructor() {
    effect(() => {
      const status = this.result().status;
      const card = this.card().nativeElement;

      if (status === 'failed' && this.previousStatus !== 'failed') card.open = true;
      this.previousStatus = status;
    });
  }

  visibility(): Policy {
    return this.caller() === 'user' ? 'user' : this.result().policy;
  }

  description(): string {
    const result = this.result();

    return `${result.status}${result.exitCode === undefined ? '' : ` · exit ${result.exitCode}`}${result.reason ? ` · ${result.reason}` : ''}`;
  }
}
