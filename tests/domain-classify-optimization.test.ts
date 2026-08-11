import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getDomainConcurrencyPlan,
  inferCategoryDomain,
  parseCompactDomainResponse,
  type DomainProgress,
} from '../src/bookmark-classify-llm.js';
import { createDomainProgressRenderer } from '../src/cli.js';

test('domain concurrency keeps the 20-worker floor and can grow to its cap', () => {
  const previousWorker = process.env.FT_DOMAIN_WORKER_MEMORY_MB;
  const previousMax = process.env.FT_DOMAIN_MAX_CONCURRENCY;
  const previousService = process.env.FT_DOMAIN_SERVICE_MAX_CONCURRENCY;
  process.env.FT_DOMAIN_WORKER_MEMORY_MB = '64';
  process.env.FT_DOMAIN_MAX_CONCURRENCY = '40';
  process.env.FT_DOMAIN_SERVICE_MAX_CONCURRENCY = '40';
  try {
    const plan = getDomainConcurrencyPlan({
      totalMemory: 16 * 1024 ** 3,
      availableMemoryRatio: 0.4,
      cpuCount: 10,
    });
    assert.equal(plan.minimumConcurrency, 20);
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
  }
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
    successBatches: 1, nextBatchSize: 200, cpuUsedPct: 65, memoryUsedPct: 63,
    maxCpuUsedPct: 65, maxMemoryUsedPct: 63, throttleEvents: 0,
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

  const log = { isTTY: false, output: '', write(value: string) { this.output += value; } };
  const plain = createDomainProgressRenderer(log);
  plain.update(progress);
  assert.match(log.output, /Domains 200\/1,000/);
  assert.doesNotMatch(log.output, /\u001b\[/);
});
