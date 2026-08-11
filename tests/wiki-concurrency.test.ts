import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineInvocationError } from '../src/engine.js';
import { createWikiProgressRenderer } from '../src/cli.js';
import type { CompileResult, WikiProgress } from '../src/md.js';
import {
  classifyWikiFailure,
  getWikiConcurrencyPlan,
  getWikiConcurrencyUpdate,
  reduceWikiConcurrency,
} from '../src/wiki-concurrency.js';

test('wiki plan starts at 20 when a 16 GiB machine has sufficient headroom', () => {
  const plan = getWikiConcurrencyPlan({
    totalMemory: 16 * 1024 ** 3,
    availableMemoryRatio: 0.4,
    cpuCount: 10,
  });
  assert.equal(plan.initial, 20);
  assert.equal(plan.cap, 25);
  assert.equal(plan.resourceLimitPct, 80);
});

test('wiki plan lowers launch concurrency when memory is already above the guard', () => {
  const plan = getWikiConcurrencyPlan({
    totalMemory: 16 * 1024 ** 3,
    availableMemoryRatio: 0.1,
    cpuCount: 10,
  });
  assert.equal(plan.initial, 1);
  assert.equal(plan.cap, 1);
});

test('wiki controller grows only after a healthy completion window', () => {
  const idle = getWikiConcurrencyUpdate({
    targetConcurrency: 20, activeWorkers: 20, concurrencyCap: 30,
    cpuUsedPct: 40, memoryUsedPct: 50, resourceLimitPct: 80,
    cooldownActive: false, healthyCompletions: 9, avgHealthyPageSec: 30,
  });
  assert.equal(idle.targetConcurrency, 20);

  const healthy = getWikiConcurrencyUpdate({
    targetConcurrency: 20, activeWorkers: 20, concurrencyCap: 30,
    cpuUsedPct: 40, memoryUsedPct: 50, resourceLimitPct: 80,
    cooldownActive: false, healthyCompletions: 10, avgHealthyPageSec: 30,
  });
  assert.equal(healthy.targetConcurrency, 22);
  assert.equal(healthy.phase, 'auto-tuning');
});

test('wiki controller reduces workers at the 80% resource guard', () => {
  const update = getWikiConcurrencyUpdate({
    targetConcurrency: 30, activeWorkers: 30, concurrencyCap: 40,
    cpuUsedPct: 82, memoryUsedPct: 60, resourceLimitPct: 80,
    cooldownActive: false, healthyCompletions: 30, avgHealthyPageSec: 10,
  });
  assert.equal(update.targetConcurrency, 24);
  assert.equal(update.phase, 'resource guard');
});

test('wiki failures distinguish throttling, auth, timeout, and storage', () => {
  const timeout = new EngineInvocationError({
    engine: 'codex', bin: 'codex', stderr: '', killed: true,
    code: null, signal: 'SIGTERM', reason: 'timeout', message: 'codex timed out',
  });
  assert.equal(classifyWikiFailure(timeout), 'timeout');
  assert.equal(classifyWikiFailure(new Error('HTTP 429 rate limit')), 'throttle');
  assert.equal(classifyWikiFailure(new Error('authentication token expired')), 'auth');
  assert.equal(classifyWikiFailure(Object.assign(new Error('write failed'), { code: 'ENOSPC' })), 'storage');
  assert.equal(classifyWikiFailure(new Error('anything'), true), 'interrupted');
});

test('wiki service backpressure is multiplicative and bounded at one worker', () => {
  assert.equal(reduceWikiConcurrency(20, 'timeout'), 10);
  assert.equal(reduceWikiConcurrency(20, 'throttle'), 15);
  assert.equal(reduceWikiConcurrency(1, 'timeout'), 1);
  assert.equal(reduceWikiConcurrency(20, 'storage'), 20);
});

test('wiki progress uses the domain classifier five-line TTY layout and plain redirected logs', () => {
  const progress: WikiProgress = {
    engine: 'codex/gpt-5.6-sol/effort=ultra/fast', done: 40, total: 200,
    created: 35, updated: 5, failed: 0, retries: 1,
    activeWorkers: 20, targetConcurrency: 20, concurrencyCap: 25, peakConcurrency: 20,
    elapsedSec: 120, etaSec: 480, pagesPerMin: 20,
    cpuUsedPct: 45, memoryUsedPct: 63, resourceLimitPct: 80,
    phase: 'running', currentPage: 'domains/ai',
    failureCounts: { timeout: 1, throttle: 0, auth: 0, engine: 0, storage: 0, unexpected: 0 },
  };
  const result: CompileResult = {
    engine: 'codex', pagesCreated: 195, pagesUpdated: 5, pagesSkipped: 0,
    pagesFailed: 0, totalPages: 200, elapsed: 600, aborted: false,
    interrupted: false, retries: 1, initialConcurrency: 20, finalConcurrency: 22,
    peakConcurrency: 22, concurrencyCap: 25, maxCpuUsedPct: 70,
    maxMemoryUsedPct: 68, resourceLimitPct: 80, failureCounts: progress.failureCounts,
  };

  const tty = { isTTY: true, columns: 120, output: '', write(value: string) { this.output += value; } };
  const rich = createWikiProgressRenderer(tty);
  rich.update(progress);
  assert.match(tty.output, /Field Theory · Wiki compilation/);
  assert.match(tty.output, /workers 20\/20≤25 peak 20/);
  assert.match(tty.output, /RAM 63%\/80%/);
  assert.match(tty.output, /\u001b\[/);
  assert.ok(tty.output.split('\n').length >= 6, 'TTY render should contain five progress lines');
  rich.finish(result);

  const log = { isTTY: false, output: '', write(value: string) { this.output += value; } };
  const plain = createWikiProgressRenderer(log);
  plain.update(progress);
  assert.match(log.output, /Wiki 40\/200 \(20\.0%\)/);
  assert.doesNotMatch(log.output, /\u001b\[/);
  plain.finish(result);
});
