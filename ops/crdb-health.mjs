#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CCLOUD_ARGS = cluster => ['cluster', 'info', cluster, '--json'];

export function classifyCluster(cluster) {
  const state = String(cluster.state ?? cluster.status ?? 'UNKNOWN').toUpperCase();
  const health = state === 'CLUSTER_STATE_CREATED' || state === 'CREATED' || state === 'RUNNING'
    ? 'healthy'
    : state.includes('CREATING') || state.includes('UPDATING') || state.includes('PAUSED')
      ? 'degraded'
      : 'unhealthy';

  return {
    healthy: health === 'healthy',
    health,
    cluster: {
      id: cluster.id ?? null,
      name: cluster.name ?? null,
      state,
      plan: cluster.plan_type ?? cluster.planType ?? cluster.plan ?? null,
      cloud: cluster.cloud_provider ?? cluster.cloudProvider ?? cluster.cloud ?? null,
      version: cluster.cockroach_version ?? cluster.cockroachVersion ?? cluster.version ?? null,
    },
  };
}

export function parseClusterInfo(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`ccloud returned invalid JSON: ${error.message}`);
  }
  const cluster = Array.isArray(value) ? value[0] : value.cluster ?? value;
  if (!cluster || typeof cluster !== 'object' || Array.isArray(cluster)) {
    throw new Error('ccloud JSON did not contain a cluster object');
  }
  return cluster;
}

export function checkClusterHealth(cluster, run = spawnSync) {
  const result = run('ccloud', CCLOUD_ARGS(cluster), { encoding: 'utf8' });
  if (result.error) throw new Error(`unable to run ccloud: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`ccloud exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return { checked_at: new Date().toISOString(), ...classifyCluster(parseClusterInfo(result.stdout)) };
}

function readClusterArg(argv) {
  const index = argv.indexOf('--cluster');
  const cluster = index >= 0 ? argv[index + 1] : undefined;
  if (!cluster || cluster.startsWith('--')) {
    throw new Error('usage: node ops/crdb-health.mjs --cluster <name-or-id>');
  }
  return cluster;
}

function main() {
  try {
    const report = checkClusterHealth(readClusterArg(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.healthy ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ healthy: false, health: 'unknown', error: error.message })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
