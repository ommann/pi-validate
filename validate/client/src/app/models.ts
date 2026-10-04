import type { Policy } from '@shared/contracts';

export type {
  Plan, Policy, Run, Result, Snapshot,
  NumberParameter as Parameter, StepSummary as Step,
} from '@shared/contracts';

export type Operation = Policy | 'add' | 'remove' | 'up' | 'down' | 'join' | 'separate';
