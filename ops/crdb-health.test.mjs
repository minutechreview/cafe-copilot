import test from 'node:test';
import assert from 'node:assert/strict';
import { CCLOUD_ARGS, checkClusterHealth, classifyCluster, parseClusterInfo } from './crdb-health.mjs';

test('uses noun-verb ccloud syntax and stable JSON output', () => {
  assert.deepEqual(CCLOUD_ARGS('demo'), ['cluster', 'info', 'demo', '--json']);
});

test('parses and classifies a created cluster', () => {
  const cluster = parseClusterInfo(JSON.stringify({ name: 'demo', id: 'abc', state: 'CLUSTER_STATE_CREATED', plan_type: 'PLAN_SERVERLESS' }));
  assert.deepEqual(classifyCluster(cluster), {
    healthy: true,
    health: 'healthy',
    cluster: { id: 'abc', name: 'demo', state: 'CLUSTER_STATE_CREATED', plan: 'PLAN_SERVERLESS', cloud: null, version: null },
  });
});

test('supports injected execution without ccloud or credentials', () => {
  const run = (command, args) => {
    assert.equal(command, 'ccloud');
    assert.deepEqual(args, ['cluster', 'info', 'demo', '--json']);
    return { status: 0, stdout: '{"cluster":{"name":"demo","state":"CLUSTER_STATE_CREATING"}}', stderr: '' };
  };
  const result = checkClusterHealth('demo', run);
  assert.equal(result.health, 'degraded');
  assert.equal(result.healthy, false);
});

test('rejects invalid JSON', () => {
  assert.throws(() => parseClusterInfo('not json'), /invalid JSON/);
});
