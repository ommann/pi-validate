import { Directive, ElementRef, inject, input, effect } from '@angular/core';

import { renderAnsi } from '@shared/ansi.js';

@Directive({ selector: 'pre[ansiOutput]' })
export class AnsiOutput {
  readonly ansiOutput = input.required<string>();

  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    effect(() => renderAnsi(this.element.nativeElement, this.ansiOutput()));
  }
}
