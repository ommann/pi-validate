export interface AnsiPart {
  text: string;
  style: Partial<CSSStyleDeclaration>;
}

export function ansiParts(text: string): AnsiPart[];
export function renderAnsi(element: HTMLElement, text: string): void;
