#!/usr/bin/env node
// Discovers the best available Claude Sonnet model on this AWS account's Bedrock access,
// verifies it is actually invokable (some accounts only allow a model through a
// cross-region inference profile, not the plain model id), and records the winning id as
// BEDROCK_MODEL_ID in .env.local. Run with: npm run find-model --workspace=agent
import { config as loadEnv } from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_LOCAL_PATH = path.join(REPO_ROOT, '.env.local');
loadEnv({ path: ENV_LOCAL_PATH });

const REGION = process.env.AWS_REGION;
if (!REGION) {
  console.error('AWS_REGION is not set in .env.local — cannot discover Bedrock models.');
  process.exit(1);
}

// Newer/more capable Sonnet families first. Anything sonnet-flavored but unrecognized
// still gets tried, just last.
const KNOWN_PRIORITY = [
  /claude-sonnet-4-5/i,
  /claude-sonnet-4/i,
  /claude-3-7-sonnet/i,
  /claude-3-5-sonnet/i,
  /claude-3-sonnet/i,
];

function priorityRank(modelId) {
  const rank = KNOWN_PRIORITY.findIndex((re) => re.test(modelId));
  return rank === -1 ? KNOWN_PRIORITY.length : rank;
}

function dateSuffix(modelId) {
  const match = modelId.match(/(\d{8})/);
  return match ? Number(match[1]) : 0;
}

function compareCandidates(a, b) {
  const rankDiff = priorityRank(a.modelId) - priorityRank(b.modelId);
  if (rankDiff !== 0) return rankDiff;
  return dateSuffix(b.modelId) - dateSuffix(a.modelId); // newer date first
}

async function probeConverse(runtimeClient, modelId) {
  await runtimeClient.send(
    new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
      inferenceConfig: { maxTokens: 1 },
    })
  );
}

async function findInferenceProfileCandidatesFor(bedrockClient, modelId) {
  // Try the registered cross-region inference profile that wraps this model first, then
  // fall back to the common "us.<modelId>" cross-region profile naming convention — some
  // accounts expose the profile under that id without it showing up in ListInferenceProfiles.
  const { inferenceProfileSummaries = [] } = await bedrockClient.send(
    new ListInferenceProfilesCommand({})
  );
  const registered = inferenceProfileSummaries
    .filter((profile) => (profile.models ?? []).some((m) => (m.modelArn ?? '').includes(modelId)))
    .map((profile) => profile.inferenceProfileId);

  return [...new Set([...registered, `us.${modelId}`])];
}

function upsertEnvVar(key, value) {
  const existing = existsSync(ENV_LOCAL_PATH) ? readFileSync(ENV_LOCAL_PATH, 'utf8') : '';
  const lines = existing.split('\n').filter((line) => line.length > 0);
  const withoutKey = lines.filter((line) => !line.startsWith(`${key}=`));
  withoutKey.push(`${key}=${value}`);
  writeFileSync(ENV_LOCAL_PATH, withoutKey.join('\n') + '\n');
}

async function main() {
  const bedrockClient = new BedrockClient({ region: REGION });
  const runtimeClient = new BedrockRuntimeClient({ region: REGION });

  const { modelSummaries = [] } = await bedrockClient.send(new ListFoundationModelsCommand({}));
  const candidates = modelSummaries
    .filter(
      (m) =>
        /anthropic/i.test(m.providerName ?? '') &&
        /sonnet/i.test(m.modelId ?? m.modelName ?? '')
    )
    .sort(compareCandidates);

  if (candidates.length === 0) {
    console.error('No Anthropic Sonnet models are visible on this account/region.');
    process.exit(1);
  }

  console.log(`Found ${candidates.length} candidate Sonnet model(s), trying in priority order:`);
  for (const c of candidates) console.log(`  - ${c.modelId}`);

  for (const candidate of candidates) {
    const modelId = candidate.modelId;

    try {
      await probeConverse(runtimeClient, modelId);
      console.log(`\nSelected model: ${modelId} (invoked directly)`);
      upsertEnvVar('BEDROCK_MODEL_ID', modelId);
      console.log(`Wrote BEDROCK_MODEL_ID=${modelId} to .env.local`);
      return;
    } catch (directErr) {
      console.log(`  direct invoke failed for ${modelId}: ${directErr?.name ?? directErr}`);
    }

    const profileCandidates = await findInferenceProfileCandidatesFor(bedrockClient, modelId);
    for (const profileId of profileCandidates) {
      try {
        await probeConverse(runtimeClient, profileId);
        console.log(`\nSelected model: ${profileId} (via inference profile for ${modelId})`);
        upsertEnvVar('BEDROCK_MODEL_ID', profileId);
        console.log(`Wrote BEDROCK_MODEL_ID=${profileId} to .env.local`);
        return;
      } catch (profileErr) {
        console.log(`  inference profile invoke failed for ${profileId}: ${profileErr?.name ?? profileErr}`);
      }
    }
  }

  console.error('\nNone of the candidate Sonnet models were invokable on this account.');
  process.exit(1);
}

main().catch((err) => {
  console.error('find-model failed:', err);
  process.exit(1);
});
