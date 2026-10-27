import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluate} from '../../evals/assert.mjs';
import {observe as good} from '../../references/good.mjs';
import {observe as broken} from '../../references/broken.mjs';

const workload = JSON.parse(readFileSync(new URL('../../fixtures/workload.json', import.meta.url), 'utf8'));
const requirements = () => ({maxRequestsPerSecond: 50, cacheTtlMs: 30000, forbiddenLogFragments: ['clinicalPayload', 'diagnosis', 'glucose']});
const call = (customerCode, atMs) => ({customerCode, atMs});
const observation = (upstreamCalls, extra = {}) => ({
  requests: upstreamCalls.map((c) => ({...c})),
  upstreamCalls,
  responses: upstreamCalls.map((c) => ({customerCode: c.customerCode, status: 'pending'})),
  logs: ['request batch completed'],
  requirements: requirements(),
  ...extra,
});

function assertShape(result) {
  assert.deepEqual(Object.keys(result).sort(), ['pass', 'violations']);
  assert.equal(typeof result.pass, 'boolean');
  assert.ok(Array.isArray(result.violations));
  if (result.pass) assert.equal(result.violations.length, 0);
  else assert.ok(result.violations.length > 0 && result.violations.every((v) => typeof v === 'string' && v.length > 0));
}
const passes = (obs) => { const r = evaluate(obs); assertShape(r); assert.equal(r.pass, true, r.violations.join('\n')); };
const fails = (obs, id) => {
  const r = evaluate(obs);
  assertShape(r);
  assert.equal(r.pass, false);
  if (id) assert.ok(r.violations.some((v) => v.startsWith(id)), `expected ${id}, got ${r.violations.join(' | ')}`);
};

// References on the repeatable workload.
test('good reference passes on the workload', () => passes(good(workload)));
test('broken reference (cache removed) fails with CACHE-1 and RATE-1', () => {
  fails(broken(workload), 'CACHE-1');
  fails(broken(workload), 'RATE-1');
});
test('evaluate does not modify the observation', () => {
  const obs = broken(workload);
  obs.upstreamCalls.reverse();
  const before = JSON.stringify(obs);
  evaluate(obs);
  assert.equal(JSON.stringify(obs), before);
});

// Valid refactors.
test('valid refactor: different harmless log text and extra fields', () => {
  const obs = good(workload);
  passes({...obs, logs: ['all requests completed successfully with version 2', 'cache hit ratio 0.98'], meta: {impl: 'v2'}});
});
test('valid refactor: refresh exactly at the TTL boundary', () => {
  passes(observation([call('CUS-1', 0), call('CUS-1', 30000), call('CUS-1', 60000)]));
});
test('valid refactor: separate cache entries per customer', () => {
  passes(observation(Array.from({length: 40}, (_, i) => call(`CUS-${i}`, i * 5))));
});
test('valid refactor: upstream calls recorded out of order', () => {
  passes(observation([call('CUS-1', 30000), call('CUS-2', 10), call('CUS-1', 0)]));
});
test('rate limit: exactly 50 upstream calls in one second pass', () => {
  passes(observation(Array.from({length: 50}, (_, i) => call(`CUS-${i}`, i * 19))));
});
test('rate limit counts upstream calls, not requests', () => {
  const obs = good(workload);
  assert.equal(obs.requests.length, 60);
  passes(obs);
});

// Failure variants.
test('missing cache: second call for the same customer inside the TTL fails', () => {
  fails(observation([call('CUS-1', 0), call('CUS-1', 29999)]), 'CACHE-1');
});
test('rate-limit breach: 51 calls in one second fail even with a cache per customer', () => {
  fails(observation(Array.from({length: 51}, (_, i) => call(`CUS-${i}`, i * 19))), 'RATE-1');
});
test('rate-limit breach in a rolling window that is not aligned to whole seconds', () => {
  const calls = Array.from({length: 51}, (_, i) => call(`CUS-${i}`, 700 + i * 10));
  fails(observation(calls), 'RATE-1');
});
test('clinical payload in a log line fails', () => {
  fails(observation([call('CUS-1', 0)], {logs: ['ok', 'customer CUS-1 glucose=7.2 mmol/L']}), 'PRIVACY-1');
  fails(observation([call('CUS-1', 0)], {logs: ['dump {"clinicalPayload":{}}']}), 'PRIVACY-1');
  fails(observation([call('CUS-1', 0)], {logs: ['Diagnosis: example']}), 'PRIVACY-1');
});

// Malformed or insufficient evidence.
test('malformed observations fail with a violation', () => {
  for (const bad of [undefined, null, {}, [], 'x', {...good(workload), requirements: undefined},
    {...good(workload), upstreamCalls: 'none'}, {...good(workload), requests: []},
    {...good(workload), logs: [42]}, {...good(workload), upstreamCalls: [{customerCode: 'CUS-1'}]},
    {...good(workload), requirements: {maxRequestsPerSecond: 50, cacheTtlMs: 30000}}]) {
    fails(bad, 'MALFORMED');
  }
});
