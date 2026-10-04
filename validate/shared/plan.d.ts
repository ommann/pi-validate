import type { Plan, Policy } from './contracts';

type Operation = Policy | 'add' | 'remove' | 'up' | 'down' | 'join' | 'separate';

export function activeGroups(plan: Plan): string[][];
export function editPlan(original: Plan, name: string, operation: Operation): Plan;
export function dropStep(original: Plan, name: string, targetIndex: number, between?: boolean): Plan;
