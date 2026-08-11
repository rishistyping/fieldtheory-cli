import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileMd } from '../src/md.js';
import { openBookmarksDb } from '../src/bookmarks-db.js';
import { saveDb } from '../src/db.js';

test('wiki compilation runs independent pages concurrently and persists each result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-wiki-concurrency-'));
  const dataDir = path.join(root, 'data');
  const libraryDir = path.join(root, 'library');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const fakeCodex = path.join(binDir, 'codex');
  fs.writeFileSync(fakeCodex, [
    '#!/bin/sh',
    'sleep 0.15',
    "printf '%s\\n' '---' 'tags: [ft/category]' 'source_count: 5' 'source_type: bookmarks' 'last_updated: 2026-08-11' '---' '' '# Concurrent wiki page'",
  ].join('\n'), { mode: 0o700 });

  const previous = new Map<string, string | undefined>();
  const setEnv = (name: string, value: string) => {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  };
  setEnv('FT_DATA_DIR', dataDir);
  setEnv('FT_LIBRARY_DIR', libraryDir);
  setEnv('FT_WIKI_INITIAL_CONCURRENCY', '4');
  setEnv('FT_WIKI_MAX_CONCURRENCY', '4');
  setEnv('FT_WIKI_SERVICE_MAX_CONCURRENCY', '4');
  setEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH ?? ''}`);

  try {
    const db = await openBookmarksDb();
    try {
      db.run(`CREATE TABLE bookmarks (
        id TEXT PRIMARY KEY, tweet_id TEXT NOT NULL, url TEXT NOT NULL, text TEXT NOT NULL,
        author_handle TEXT, author_name TEXT, posted_at TEXT, bookmarked_at TEXT, synced_at TEXT NOT NULL,
        categories TEXT, primary_category TEXT, domains TEXT, primary_domain TEXT,
        github_urls TEXT, links_json TEXT
      )`);
      for (let group = 0; group < 8; group++) {
        for (let item = 0; item < 5; item++) {
          const id = `${group}-${item}`;
          const category = `category-${group}`;
          db.run(
            `INSERT INTO bookmarks (id, tweet_id, url, text, author_handle, synced_at, categories, primary_category)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, id, `https://example.com/${id}`, `Bookmark ${id}`, `author-${id}`, new Date().toISOString(), category, category],
          );
        }
      }
      saveDb(db, path.join(dataDir, 'bookmarks.db'));
    } finally {
      db.close();
    }

    const startedAt = Date.now();
    const result = await compileMd({ engineOverride: 'codex', onProgress: () => {} });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.pagesCreated, 8);
    assert.equal(result.pagesFailed, 0);
    assert.equal(result.peakConcurrency, 4);
    assert.ok(elapsedMs < 1_200, `eight 150ms calls should run concurrently; elapsed=${elapsedMs}ms`);
    assert.equal(fs.readdirSync(path.join(libraryDir, 'categories')).filter(name => name.endsWith('.md')).length, 8);
    const state = JSON.parse(fs.readFileSync(path.join(libraryDir, 'md-state.json'), 'utf8'));
    assert.equal(Object.keys(state.groupCounts).length, 8);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
