import { resolve, join } from "node:path";
import { stat, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Context, Step } from "./step.ts";

import type { Plan, Detection, Run, Snapshot } from "../shared/contracts.ts";

export type { Policy, Plan, Detection, Result, Run } from "../shared/contracts.ts";
export type AgentReport = { exitCode: number; cancelled?: boolean; failures: { name: string; output: string; exitCode: number }[] };

const now = () => new Date().toISOString();

export async function loadSteps(directory = join(import.meta.dir, "steps")): Promise<Step[]> {
  const files = await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: directory }));
  files.sort();

  const steps: Step[] = [];

  for (const file of files) {
    const { default: step } = await import(pathToFileURL(join(directory, file)).href);
    if (!step || typeof step.name !== "string" || typeof step.detect !== "function" || typeof step.run !== "function") {
      throw new Error(`Invalid step module: ${file}`);
    }

    if (steps.some(existing => existing.name === step.name)) throw new Error(`Duplicate step: ${step.name}`);
    steps.push(step);
  }

  return steps;
}

export function checkPlan(value: unknown, steps: Step[]): Plan {
  const plan = value as Plan;

  if (!plan || !Array.isArray(plan.groups) || !plan.policies || typeof plan.policies !== "object" || Array.isArray(plan.policies)) {
    throw new Error("Plan must contain groups and policies");
  }

  if (plan.useNix !== undefined && typeof plan.useNix !== "boolean") throw new Error("useNix must be a boolean");

  const names = new Set(steps.map(step => step.name));
  const removed = plan.removed ?? [];
  if (!Array.isArray(removed) || removed.some(name => !names.has(name)) || new Set(removed).size !== removed.length) {
    throw new Error("Removed steps must be unique known step names");
  }

  const seen = new Set<string>();
  for (const group of plan.groups) {
    if (!Array.isArray(group) || group.length === 0) throw new Error("Groups must be non-empty arrays");
    for (const name of group) {
      if (!names.has(name)) throw new Error(`Unknown step: ${name}`);
      if (removed.includes(name)) throw new Error(`Removed step is still in a group: ${name}`);
      if (seen.has(name)) throw new Error(`Repeated step: ${name}`);
      seen.add(name);
    }
  }

  for (const [name, policy] of Object.entries(plan.policies)) {
    if (!names.has(name)) throw new Error(`Unknown step: ${name}`);
    if (!["agent", "user", "off"].includes(policy)) throw new Error(`Invalid policy: ${policy}`);
  }

  const rawConfigs = plan.configs ?? {};
  if (!rawConfigs || typeof rawConfigs !== "object" || Array.isArray(rawConfigs)) throw new Error("configs must be an object");

  const configs: Record<string, Record<string, unknown>> = {};

  for (const step of steps) {
    const parameters = step.parameters ?? {};
    const raw = rawConfigs[step.name] ?? {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Config for ${step.name} must be an object`);

    const config: Record<string, unknown> = {};
    for (const [key, parameter] of Object.entries(parameters)) {
      const value = (raw as Record<string, unknown>)[key] ?? parameter.default;
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${step.name}.${key} must be a number`);
      if (parameter.min !== undefined && value < parameter.min) throw new Error(`${step.name}.${key} is below minimum`);
      if (parameter.max !== undefined && value > parameter.max) throw new Error(`${step.name}.${key} is above maximum`);
      config[key] = value;
    }

    if (Object.keys(config).length) configs[step.name] = config;
  }

  return {
    groups: [...plan.groups.map(group => [...group]), ...steps.filter(step => !seen.has(step.name) && !removed.includes(step.name)).map(step => [step.name])],
    policies: Object.fromEntries(steps.map(step => [step.name, plan.policies[step.name] ?? "agent"])),
    removed: [...removed],
    useNix: plan.useNix ?? false,
    configs,
  };
}

export function agentReport(run: Run): AgentReport {
  const failures = run.results.filter(result => result.policy === "agent" && result.status === "failed")
    .map(result => ({ name: result.name, output: result.output, exitCode: result.exitCode ?? 1 }));

  return { exitCode: run.cancelled ? 130 : failures[0]?.exitCode ?? 0, failures, ...(run.cancelled ? { cancelled: true } : {}) };
}

export class Validation {
  readonly cwd: string;
  readonly steps: Step[];
  plan: Plan;
  detections: Record<string, Detection> = {};
  runs: Run[] = [];
  busy = false;
  private configFile?: string;
  private controller?: AbortController;
  private runDone?: Promise<void>;

  private constructor(cwd: string, steps: Step[], plan: Plan, configFile?: string) {
    this.cwd = cwd;
    this.steps = steps;
    this.plan = plan;
    this.configFile = configFile;
  }

  static async create(cwd: string, options: { steps?: Step[]; persist?: boolean } = {}) {
    cwd = resolve(cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a directory: ${cwd}`);

    const steps = options.steps ?? await loadSteps();
    const configFile = options.persist === false ? undefined : join(cwd, ".validate.json");
    let plan = checkPlan({ groups: [], policies: {} }, steps);
    if (configFile && await Bun.file(configFile).exists()) {
      plan = checkPlan(await Bun.file(configFile).json(), steps);
    }

    return new Validation(cwd, steps, plan, configFile);
  }

  snapshot(): Snapshot {
    return { cwd: this.cwd, busy: this.busy, running: !!this.controller, stopping: this.controller?.signal.aborted ?? false, plan: this.plan, steps: this.steps.map(step => ({ name: step.name, parameters: step.parameters ?? {}, detection: this.detections[step.name] ?? null })), runs: this.runs };
  }

  async configure(value: unknown) {
    if (this.busy) throw new Error("Validation is busy");

    const plan = checkPlan(value, this.steps);
    this.busy = true;
    try {
      if (this.configFile) {
        await Bun.write(this.configFile + ".tmp", JSON.stringify(plan, null, 2) + "\n");
        await rename(this.configFile + ".tmp", this.configFile);
      }

      this.plan = plan;
    } finally { this.busy = false; }
  }

  private async context(): Promise<Context> {
    const file = Bun.file(join(this.cwd, "package.json"));
    const pkg = await file.exists() ? await file.json() : {};

    return { cwd: this.cwd, scripts: pkg?.scripts ?? {} };
  }

  private async detectWith(context: Context) {
    for (const step of this.steps) {
      context.signal?.throwIfAborted();

      try {
        this.detections[step.name] = { applicable: await step.detect({ ...context, config: this.plan.configs?.[step.name] ?? {} }), checkedAt: now() };
      } catch (error) {
        this.detections[step.name] = { applicable: false, error: String(error), checkedAt: now() };
      }
    }
  }

  async detect() {
    if (this.busy) throw new Error("Validation is busy");
    this.busy = true;
    try { await this.detectWith(await this.context()); }
    finally { this.busy = false; }

    return this.detections;
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.runDone;
  }

  async runForAgent(): Promise<AgentReport> {
    const ready = Promise.withResolvers<AgentReport>();
    // The full run keeps ownership of the busy flag, cancellation, and UI results.
    void this.execute("agent", run => ready.resolve(agentReport(run)))
      .then(run => ready.resolve(agentReport(run)), ready.reject);
    return ready.promise;
  }

  async run(caller: "agent" | "user" = "agent"): Promise<Run> {
    return this.execute(caller);
  }

  private async execute(caller: "agent" | "user", agentReady?: (run: Run) => void): Promise<Run> {
    if (this.busy) throw new Error("Validation is busy");
    this.busy = true;
    const controller = new AbortController();
    const { signal } = controller;
    const done = Promise.withResolvers<void>();
    this.controller = controller;
    this.runDone = done.promise;

    const plan = structuredClone(this.plan);
    const run: Run = {
      id: crypto.randomUUID(), caller, startedAt: now(), plan,
      results: plan.groups.flat().map(name => ({ name, policy: plan.policies[name]!, status: "pending", output: "" })),
    };

    try {
      const context = { ...await this.context(), signal };
      signal.throwIfAborted();
      await this.detectWith(context);
      signal.throwIfAborted();

      for (const result of run.results) {
        const detection = this.detections[result.name]!;

        if (result.policy === "off" || (!detection.applicable && !detection.error)) {
          result.status = "skipped";
          result.reason = result.policy === "off" ? "Disabled" : "Not applicable";
        }
      }

      this.runs.push(run);

      const notifyAgent = () => {
        if (caller === "agent" && !signal.aborted && run.results.every(result => result.policy !== "agent"
          || !["pending", "running"].includes(result.status))) {
          run.agentFinishedAt ??= now();
          agentReady?.(run);
        }
      };
      notifyAgent();

      let blocked = false;
      for (const group of plan.groups) {
        const executions = group.map(async name => {
          const result = run.results.find(result => result.name === name)!;
          const detection = this.detections[name]!;

          if (result.status === "skipped") return;

          if (signal.aborted) {
            result.status = "cancelled";
            return;
          }

          if (blocked) {
            result.status = "skipped";
            result.reason = "Earlier agent-visible failure";
            return;
          }

          result.status = "running";
          result.startedAt = now();

          try {
            if (detection.error) throw new Error(detection.error);
            const step = this.steps.find(step => step.name === name)!;
            result.exitCode = await step.run({ ...context, useNix: plan.useNix, config: plan.configs?.[name] ?? {}, output: (_stream, text) => { result.output += text; } });
            result.status = signal.aborted ? "cancelled" : result.exitCode === 0 ? "passed" : "failed";
            if (signal.aborted) result.exitCode = undefined;
          } catch (error) {
            if (!signal.aborted) result.output += `${String(error)}\n`;
            result.status = signal.aborted ? "cancelled" : "failed";
            result.exitCode = signal.aborted ? undefined : 1;
          } finally { result.finishedAt = now(); }
        });

        const agentCompletion = Promise.all(executions.filter((_execution, index) => plan.policies[group[index]!] === "agent"))
          .then(() => {
            // Settle later agent checks as soon as this section's agent results are known.
            // User-facing checks still finish before the next section starts.
            if (caller === "agent" && run.results.some(result => result.policy === "agent" && result.status === "failed")) {
              blocked = true;
              for (const result of run.results) {
                if (result.policy === "agent" && result.status === "pending") {
                  result.status = "skipped";
                  result.reason = "Earlier agent-visible failure";
                }
              }
            }
            notifyAgent();
          });
        await Promise.all([...executions, agentCompletion]);
      }
    } catch (error) {
      for (const result of run.results) {
        if (result.status !== "pending") continue;
        result.status = result.policy === "off" ? "skipped" : signal.aborted ? "cancelled" : "failed";
        result.reason = result.policy === "off" ? "Disabled" : undefined;
        result.exitCode = result.policy === "off" || signal.aborted ? undefined : 1;
        if (result.policy !== "off" && !signal.aborted) result.output = `${String(error)}\n`;
      }
    } finally {
      if (!this.runs.includes(run)) this.runs.push(run);
      if (signal.aborted) run.cancelled = true;
      run.finishedAt = now();
      if (caller === "agent") run.agentFinishedAt ??= run.finishedAt;
      this.busy = false;
      this.controller = undefined;
      this.runDone = undefined;
      done.resolve();
    }

    return run;
  }
}
