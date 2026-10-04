// Browser-safe JSON contracts shared by the Bun service and Angular client.
export type Health = {
  service: 'validate';
  version: 1;
  instanceId: string;
};

export type RestartResponse = {
  restarting: true;
  instanceId: string;
};

export type Policy = 'agent' | 'user' | 'off';

export type Plan = {
  groups: string[][];
  policies: Record<string, Policy>;
  removed?: string[];
  useNix?: boolean;
  configs?: Record<string, Record<string, unknown>>;
};

export type Detection = {
  applicable: boolean;
  error?: string;
  checkedAt: string;
};

export type Result = {
  name: string;
  policy: Policy;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled';
  output: string;
  reason?: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
};

export type Run = {
  id: string;
  caller: 'agent' | 'user';
  cancelled?: boolean;
  startedAt: string;
  finishedAt?: string;
  plan: Plan;
  results: Result[];
};

export type NumberParameter = {
  type: 'number';
  label: string;
  default: number;
  min?: number;
  max?: number;
  step?: number;
};

export type StepSummary = {
  name: string;
  parameters: Record<string, NumberParameter>;
  detection: Detection | null;
};

export type Snapshot = {
  cwd: string;
  busy: boolean;
  running?: boolean;
  stopping?: boolean;
  plan: Plan;
  steps: StepSummary[];
  runs: Run[];
};
