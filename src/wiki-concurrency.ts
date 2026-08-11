import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { EngineInvocationError } from './engine.js';

const WIKI_INITIAL_CONCURRENCY = 20;
const WIKI_MAX_CONCURRENCY = 60;
const WIKI_RESOURCE_LIMIT = 0.8;
const WIKI_WORKER_MEMORY_MB = 128;

function numericEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

function availableMemoryRatio(): number {
  if (process.platform === 'darwin') {
    try {
      const result = spawnSync('/usr/bin/memory_pressure', ['-Q'], {
        encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = String(result.stdout ?? '').match(/free percentage:\s*(\d+(?:\.\d+)?)%/i);
      if (match) return Math.max(0, Math.min(1, Number(match[1]) / 100));
    } catch { /* fall through */ }
  }
  return Math.max(0, Math.min(1, os.freemem() / Math.max(1, os.totalmem())));
}

export interface WikiConcurrencyPlan {
  initial: number;
  cap: number;
  configuredInitial: number;
  configuredMax: number;
  serviceCap: number;
  workerMemoryMb: number;
  memoryUsedPct: number;
  resourceLimitPct: number;
  cpuCount: number;
}

export function getWikiConcurrencyPlan(input: {
  totalMemory?: number;
  availableMemoryRatio?: number;
  cpuCount?: number;
} = {}): WikiConcurrencyPlan {
  const totalMemory = Number(input.totalMemory ?? os.totalmem());
  const freeRatio = Number(input.availableMemoryRatio ?? availableMemoryRatio());
  const cpuCount = Number(input.cpuCount ?? os.cpus().length);
  const workerMemoryMb = numericEnv('FT_WIKI_WORKER_MEMORY_MB', WIKI_WORKER_MEMORY_MB, 64, 512);
  const configuredInitial = numericEnv('FT_WIKI_INITIAL_CONCURRENCY', WIKI_INITIAL_CONCURRENCY, 1, WIKI_MAX_CONCURRENCY);
  const configuredMax = numericEnv('FT_WIKI_MAX_CONCURRENCY', WIKI_MAX_CONCURRENCY, 1, WIKI_MAX_CONCURRENCY);
  const serviceCap = numericEnv('FT_WIKI_SERVICE_MAX_CONCURRENCY', WIKI_MAX_CONCURRENCY, 1, WIKI_MAX_CONCURRENCY);
  const memoryHeadroom = Math.max(0, (freeRatio - (1 - WIKI_RESOURCE_LIMIT)) * totalMemory);
  const memoryCap = Math.max(1, Math.floor(memoryHeadroom / (workerMemoryMb * 1024 * 1024)));
  const cpuCap = Math.max(1, Math.floor(cpuCount * 6));
  const cap = Math.max(1, Math.min(configuredMax, serviceCap, memoryCap, cpuCap));
  return {
    initial: Math.min(configuredInitial, cap),
    cap,
    configuredInitial,
    configuredMax,
    serviceCap,
    workerMemoryMb,
    memoryUsedPct: (1 - freeRatio) * 100,
    resourceLimitPct: WIKI_RESOURCE_LIMIT * 100,
    cpuCount,
  };
}

export interface CpuSnapshot { idle: number; total: number }

export function wikiCpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

export function wikiCpuUsedPct(previous: CpuSnapshot, current: CpuSnapshot): number {
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - ((current.idle - previous.idle) / totalDelta))));
}

export function sampleWikiResources(previousCpu: CpuSnapshot): {
  cpu: CpuSnapshot;
  cpuUsedPct: number;
  memoryUsedPct: number;
  freeRatio: number;
} {
  const freeRatio = availableMemoryRatio();
  const cpu = wikiCpuSnapshot();
  return {
    cpu,
    cpuUsedPct: wikiCpuUsedPct(previousCpu, cpu),
    memoryUsedPct: (1 - freeRatio) * 100,
    freeRatio,
  };
}

export function getWikiConcurrencyCap(input: {
  plan: WikiConcurrencyPlan;
  activeWorkers: number;
  freeRatio: number;
  totalMemory?: number;
}): number {
  const totalMemory = input.totalMemory ?? os.totalmem();
  const memoryHeadroom = Math.max(0, (input.freeRatio - (1 - WIKI_RESOURCE_LIMIT)) * totalMemory);
  const additionalWorkers = Math.floor(memoryHeadroom / (input.plan.workerMemoryMb * 1024 * 1024));
  return Math.max(1, Math.min(
    input.plan.configuredMax,
    input.plan.serviceCap,
    input.plan.cpuCount * 6,
    input.activeWorkers + Math.max(0, additionalWorkers),
  ));
}

export function getWikiConcurrencyUpdate(input: {
  targetConcurrency: number;
  activeWorkers: number;
  concurrencyCap: number;
  cpuUsedPct: number;
  memoryUsedPct: number;
  resourceLimitPct: number;
  cooldownActive: boolean;
  healthyCompletions: number;
  avgHealthyPageSec: number;
}): { targetConcurrency: number; phase: 'resource guard' | 'auto-tuning' | ''; overResourceLimit: boolean } {
  const current = Math.max(1, Math.floor(input.targetConcurrency));
  const cap = Math.max(1, Math.floor(input.concurrencyCap));
  const overResourceLimit = input.cpuUsedPct >= input.resourceLimitPct
    || input.memoryUsedPct >= input.resourceLimitPct;
  if (overResourceLimit) {
    return {
      targetConcurrency: Math.max(1, Math.min(current, cap, Math.floor(Math.max(1, input.activeWorkers) * 0.8))),
      phase: 'resource guard',
      overResourceLimit,
    };
  }
  if (current > cap) {
    return { targetConcurrency: cap, phase: 'resource guard', overResourceLimit };
  }
  const completionsRequired = Math.max(5, Math.ceil(current / 2));
  const healthy = input.healthyCompletions >= completionsRequired
    && input.avgHealthyPageSec > 0
    && input.avgHealthyPageSec <= 300;
  if (!input.cooldownActive && healthy && input.cpuUsedPct < 70 && input.memoryUsedPct < 75 && current < cap) {
    return { targetConcurrency: Math.min(cap, current + 2), phase: 'auto-tuning', overResourceLimit };
  }
  return { targetConcurrency: current, phase: '', overResourceLimit };
}

export type WikiFailureReason = 'timeout' | 'throttle' | 'auth' | 'engine' | 'storage' | 'interrupted' | 'unexpected';

export function classifyWikiFailure(error: unknown, interrupted = false): WikiFailureReason {
  if (interrupted) return 'interrupted';
  const message = error instanceof Error ? error.message : String(error);
  const stderr = error instanceof EngineInvocationError ? error.stderr : '';
  const detail = `${message}\n${stderr}`;
  if (/(?:429|rate.?limit|too many requests|capacity|overloaded)/i.test(detail)) return 'throttle';
  if (/auth|login|unauthor|invalid.*token|expired.*token/i.test(detail)) return 'auth';
  if (error instanceof EngineInvocationError) {
    if (error.reason === 'timeout') return 'timeout';
    return 'engine';
  }
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? '').toUpperCase()
    : '';
  if (['EACCES', 'EDQUOT', 'EIO', 'ENOSPC', 'EPERM', 'EROFS'].includes(code)) return 'storage';
  if (/permission denied|no space left|quota exceeded|read-only|disk|fsync/i.test(message)) return 'storage';
  if (/timed out|timeout/i.test(message)) return 'timeout';
  return 'unexpected';
}

export function reduceWikiConcurrency(target: number, reason: WikiFailureReason): number {
  const current = Math.max(1, Math.floor(target));
  if (reason === 'timeout') return Math.max(1, Math.floor(current * 0.5));
  if (reason === 'throttle' || reason === 'engine') return Math.max(1, Math.floor(current * 0.75));
  return current;
}

export function wikiNumericEnv(name: string, fallback: number, min: number, max: number): number {
  return numericEnv(name, fallback, min, max);
}
