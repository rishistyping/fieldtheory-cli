import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDomainFailure,
  getDomainConcurrencyUpdate,
  getDomainConcurrencyPlan,
  inferCategoryDomain,
  parseCompactDomainResponse,
  reduceDomainConcurrencyForFailure,
  type DomainProgress,
} from '../src/bookmark-classify-llm.js';
import { createDomainProgressRenderer } from '../src/cli.js';

test('domain concurrency prefers 20 workers but keeps safety limits authoritative', () => {
  const previousWorker = process.env.FT_DOMAIN_WORKER_MEMORY_MB;
  const previousMax = process.env.FT_DOMAIN_MAX_CONCURRENCY;
  const previousService = process.env.FT_DOMAIN_SERVICE_MAX_CONCURRENCY;
  const previousInitial = process.env.FT_DOMAIN_INITIAL_CONCURRENCY;
  process.env.FT_DOMAIN_WORKER_MEMORY_MB = '64';
  process.env.FT_DOMAIN_MAX_CONCURRENCY = '40';
  process.env.FT_DOMAIN_SERVICE_MAX_CONCURRENCY = '40';
  process.env.FT_DOMAIN_INITIAL_CONCURRENCY = '20';
  try {
    const plan = getDomainConcurrencyPlan({
      totalMemory: 16 * 1024 ** 3,
      availableMemoryRatio: 0.4,
      cpuCount: 10,
    });
    assert.equal(plan.minimumConcurrency, 1);
    assert.equal(plan.preferredConcurrency, 20);
    assert.equal(plan.initial, 20);
    assert.equal(plan.cap, 40);
    assert.equal(plan.resourceLimitPct, 80);
  } finally {
    if (previousWorker === undefined) delete process.env.FT_DOMAIN_WORKER_MEMORY_MB;
    else process.env.FT_DOMAIN_WORKER_MEMORY_MB = previousWorker;
    if (previousMax === undefined) delete process.env.FT_DOMAIN_MAX_CONCURRENCY;
    else process.env.FT_DOMAIN_MAX_CONCURRENCY = previousMax;
    if (previousService === undefined) delete process.env.FT_DOMAIN_SERVICE_MAX_CONCURRENCY;
    else process.env.FT_DOMAIN_SERVICE_MAX_CONCURRENCY = previousService;
    if (previousInitial === undefined) delete process.env.FT_DOMAIN_INITIAL_CONCURRENCY;
    else process.env.FT_DOMAIN_INITIAL_CONCURRENCY = previousInitial;
  }
});

test('domain concurrency launches below 20 when memory cannot safely support it', () => {
  const previousWorker = process.env.FT_DOMAIN_WORKER_MEMORY_MB;
  const previousMax = process.env.FT_DOMAIN_MAX_CONCURRENCY;
  const previousService = process.env.FT_DOMAIN_SERVICE_MAX_CONCURRENCY;
  const previousInitial = process.env.FT_DOMAIN_INITIAL_CONCURRENCY;
  process.env.FT_DOMAIN_WORKER_MEMORY_MB = '64';
  process.env.FT_DOMAIN_MAX_CONCURRENCY = '60';
  process.env.FT_DOMAIN_SERVICE_MAX_CONCURRENCY = '60';
  process.env.FT_DOMAIN_INITIAL_CONCURRENCY = '20';
  try {
    const plan = getDomainConcurrencyPlan({
      totalMemory: 16 * 1024 ** 3,
      availableMemoryRatio: 0.21,
      cpuCount: 10,
    });
    assert.equal(plan.preferredConcurrency, 20);
    assert.equal(plan.initial, 2);
    assert.equal(plan.cap, 2);
  } finally {
    if (previousWorker === undefined) delete process.env.FT_DOMAIN_WORKER_MEMORY_MB;
    else process.env.FT_DOMAIN_WORKER_MEMORY_MB = previousWorker;
    if (previousMax === undefined) delete process.env.FT_DOMAIN_MAX_CONCURRENCY;
    else process.env.FT_DOMAIN_MAX_CONCURRENCY = previousMax;
    if (previousService === undefined) delete process.env.FT_DOMAIN_SERVICE_MAX_CONCURRENCY;
    else process.env.FT_DOMAIN_SERVICE_MAX_CONCURRENCY = previousService;
    if (previousInitial === undefined) delete process.env.FT_DOMAIN_INITIAL_CONCURRENCY;
    else process.env.FT_DOMAIN_INITIAL_CONCURRENCY = previousInitial;
  }
});

test('domain controller reduces on resource pressure and grows only after a healthy service window', () => {
  const guarded = getDomainConcurrencyUpdate({
    targetConcurrency: 20, activeWorkers: 20, concurrencyCap: 60,
    cpuUsedPct: 85, memoryUsedPct: 60, resourceLimitPct: 80,
    cooldownActive: false, healthyCompletions: 40, avgHealthyBatchSec: 20,
  });
  assert.deepEqual(guarded, {
    targetConcurrency: 16,
    phase: 'resource guard',
    overResourceLimit: true,
  });

  const waiting = getDomainConcurrencyUpdate({
    targetConcurrency: 20, activeWorkers: 20, concurrencyCap: 60,
    cpuUsedPct: 40, memoryUsedPct: 60, resourceLimitPct: 80,
    cooldownActive: false, healthyCompletions: 19, avgHealthyBatchSec: 20,
  });
  assert.equal(waiting.targetConcurrency, 20);
  assert.equal(waiting.phase, '');

  const growing = getDomainConcurrencyUpdate({
    targetConcurrency: 20, activeWorkers: 20, concurrencyCap: 60,
    cpuUsedPct: 40, memoryUsedPct: 60, resourceLimitPct: 80,
    cooldownActive: false, healthyCompletions: 20, avgHealthyBatchSec: 20,
  });
  assert.equal(growing.targetConcurrency, 21);
  assert.equal(growing.phase, 'auto-tuning');
});

test('domain failure classifier recognizes backend congestion', () => {
  assert.equal(classifyDomainFailure(new Error('codex timed out after 180s')), 'timeout');
  assert.equal(classifyDomainFailure(new Error('HTTP 429: too many requests')), 'throttle');
  assert.equal(classifyDomainFailure(new Error('Domain response contained no usable results')), 'invalid-response');
  assert.equal(classifyDomainFailure(Object.assign(new Error('permission denied'), { code: 'EACCES' })), 'storage');
  assert.equal(classifyDomainFailure(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })), 'storage');
  assert.equal(classifyDomainFailure(Object.assign(new Error('read-only filesystem'), { code: 'EROFS' })), 'storage');
  assert.equal(reduceDomainConcurrencyForFailure(20, 'timeout'), 10);
  assert.equal(reduceDomainConcurrencyForFailure(20, 'throttle'), 15);
  assert.equal(reduceDomainConcurrencyForFailure(20, 'storage'), 20);
});

test('domain parser maps compact indices and rejects duplicate entries', () => {
  const batch = [
    { id: 'a', text: 'model', authorHandle: null, categories: 'article' },
    { id: 'b', text: 'robot', authorHandle: null, categories: 'article' },
  ];
  assert.deepEqual(
    parseCompactDomainResponse('{"r":[{"i":0,"d":["ai"]},{"i":1,"d":["robotics"]},{"i":1,"d":["ai"]}]}', batch),
    [
      { id: 'a', categories: ['ai'], primary: 'ai' },
      { id: 'b', categories: ['robotics'], primary: 'robotics' },
    ],
  );
});

test('known subject category prefill is conservative', () => {
  assert.equal(inferCategoryDomain('opinion,ai'), 'ai');
  assert.equal(inferCategoryDomain('ai,finance'), null);
  assert.equal(inferCategoryDomain('opinion'), null);
});

test('domain progress renderer is rich on TTY and ANSI-free when redirected', () => {
  const progress: DomainProgress = {
    done: 200, total: 1000, classified: 200, failed: 0, prefilled: 0,
    engine: 'codex/gpt-5.6-sol/effort=ultra/fast', concurrency: 20,
    concurrencyCap: 28, peakConcurrency: 20, activeWorkers: 20,
    queuedBatches: 4, elapsedSec: 10, etaSec: 40, itemsPerMin: 1200,
    successBatches: 1, nextBatchSize: 100, cpuUsedPct: 65, memoryUsedPct: 63,
    maxCpuUsedPct: 65, maxMemoryUsedPct: 63, throttleEvents: 0,
    failureCounts: { timeout: 0, throttle: 0, 'invalid-response': 0, engine: 0, storage: 0, unexpected: 0 },
    resourceLimitPct: 80, batchIndex: 1, batchSizeUsed: 200,
    batchClassified: 200, batchFailed: 0, batchSec: 8, lastError: '',
    ok: true, phase: 'completed', attempt: 1,
  };
  const tty = { isTTY: true, columns: 120, output: '', write(value: string) { this.output += value; } };
  const rich = createDomainProgressRenderer(tty);
  rich.update(progress);
  assert.match(tty.output, /workers 20\/20≤28/);
  assert.match(tty.output, /RAM 63%\/80%/);
  assert.match(tty.output, /\u001b\[/);

  rich.update({
    ...progress,
    phase: 'retrying',
    lastError: 'codex timed out after 180s',
    failureCounts: { ...progress.failureCounts, timeout: 1 },
  });
  const beforeGuard = tty.output.length;
  rich.update({
    ...progress,
    phase: 'resource guard',
    lastError: '',
    failureCounts: { ...progress.failureCounts, timeout: 1 },
  });
  assert.match(tty.output.slice(beforeGuard), /codex timed out after 180s/);
  assert.match(tty.output.slice(beforeGuard), /timeouts 1/);

  const log = { isTTY: false, output: '', write(value: string) { this.output += value; } };
  const plain = createDomainProgressRenderer(log);
  plain.update(progress);
  assert.match(log.output, /Domains 200\/1,000/);
  assert.doesNotMatch(log.output, /\u001b\[/);
});
