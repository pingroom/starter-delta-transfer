import { applyDelta } from './model.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportPatch } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE, id } from './mock.js';
const input = await readJson(new URL('../examples/delta.json', import.meta.url), 65536);
for (const choice of ['v1', 'empty', 'unknown']) {
  const directory = await mkdtemp(join(tmpdir(), 'delta-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    const pending = await step(options); assert.equal(pending.status, 'pending');
    api.answer(id(1), choice); const result = await step(options);
    if (choice === 'unknown') { assert.equal(result.analysis, null); await assert.rejects(exportPatch(directory, input)); }
    else { const exported = await exportPatch(directory, input); assert.equal(exported.evidence.baselineId, choice); assert.equal(applyDelta(exported.patch, input.baselines.find(b => b.id === choice).hex), input.targetHex.toLowerCase()); }
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 1);
    console.log(JSON.stringify({ choice, status: result.status, analysis: result.analysis }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
