#!/usr/bin/env node
// Discovers the best available Bedrock text-embedding model on this AWS account, verifies
// it is actually invokable with one real call, and records the winning id + output
// dimension as BEDROCK_EMBEDDING_MODEL_ID / EMBEDDING_DIM in .env.local. Mirrors the
// discover-then-probe pattern in find-model.mjs. Run with:
//   npm run find-embedding-model --workspace=agent
import { config as loadEnv } from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_LOCAL_PATH = path.join(REPO_ROOT, '.env.local');
loadEnv({ path: ENV_LOCAL_PATH });

const REGION = process.env.AWS_REGION;
if (!REGION) {
  console.error('AWS_REGION is not set in .env.local — cannot discover Bedrock models.');
  process.exit(1);
}

// Titan Text Embeddings v2 first (1024 dims, supports a `dimensions` param for
// 256/512/1024), then any other Titan embedding model, then Cohere embed as fallback.
const KNOWN_PRIORITY = [/titan-embed-text-v2/i, /titan-embed/i, /cohere\.embed/i];

function priorityRank(modelId) {
  const rank = KNOWN_PRIORITY.findIndex((re) => re.test(modelId));
  return rank === -1 ? KNOWN_PRIORITY.length : rank;
}

function isTitan(modelId) {
  return /titan-embed/i.test(modelId);
}

function isCohere(modelId) {
  return /cohere\.embed/i.test(modelId);
}

/** Builds the InvokeModel body for a probe call and returns how to read the embedding + dim back out. */
function buildProbeRequest(modelId) {
  if (isTitan(modelId)) {
    const dimensions = /v2/i.test(modelId) ? 1024 : undefined;
    const body = { inputText: 'cold brew sales', ...(dimensions ? { dimensions, normalize: true } : {}) };
    return {
      body,
      readEmbedding: (parsed) => parsed.embedding,
    };
  }
  if (isCohere(modelId)) {
    const body = { texts: ['cold brew sales'], input_type: 'search_document' };
    return {
      body,
      readEmbedding: (parsed) => parsed.embeddings?.[0],
    };
  }
  // Unknown embedding model family — try the Titan-shaped request as a best effort.
  return {
    body: { inputText: 'cold brew sales' },
    readEmbedding: (parsed) => parsed.embedding ?? parsed.embeddings?.[0],
  };
}

async function probeEmbed(runtimeClient, modelId) {
  const { body, readEmbedding } = buildProbeRequest(modelId);
  const response = await runtimeClient.send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    })
  );
  const parsed = JSON.parse(Buffer.from(response.body).toString('utf8'));
  const embedding = readEmbedding(parsed);
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('response did not contain an embedding array');
  }
  return embedding.length;
}

function upsertEnvVar(lines, key, value) {
  const withoutKey = lines.filter((line) => !line.startsWith(`${key}=`));
  withoutKey.push(`${key}=${value}`);
  return withoutKey;
}

async function main() {
  const bedrockClient = new BedrockClient({ region: REGION });
  const runtimeClient = new BedrockRuntimeClient({ region: REGION });

  const { modelSummaries = [] } = await bedrockClient.send(new ListFoundationModelsCommand({}));
  const candidates = modelSummaries
    .filter((m) => (m.outputModalities ?? []).includes('EMBEDDING'))
    .filter((m) => /amazon|cohere/i.test(m.providerName ?? ''))
    .sort((a, b) => priorityRank(a.modelId) - priorityRank(b.modelId));

  if (candidates.length === 0) {
    console.error('No embedding-capable models are visible on this account/region.');
    process.exit(1);
  }

  console.log(`Found ${candidates.length} candidate embedding model(s), trying in priority order:`);
  for (const c of candidates) console.log(`  - ${c.modelId}`);

  for (const candidate of candidates) {
    const modelId = candidate.modelId;
    try {
      const dim = await probeEmbed(runtimeClient, modelId);
      console.log(`\nSelected embedding model: ${modelId} (dim=${dim})`);
      const existing = existsSync(ENV_LOCAL_PATH) ? readFileSync(ENV_LOCAL_PATH, 'utf8') : '';
      let lines = existing.split('\n').filter((line) => line.length > 0);
      lines = upsertEnvVar(lines, 'BEDROCK_EMBEDDING_MODEL_ID', modelId);
      lines = upsertEnvVar(lines, 'EMBEDDING_DIM', String(dim));
      writeFileSync(ENV_LOCAL_PATH, lines.join('\n') + '\n');
      console.log(`Wrote BEDROCK_EMBEDDING_MODEL_ID=${modelId} and EMBEDDING_DIM=${dim} to .env.local`);
      return;
    } catch (err) {
      console.log(`  probe failed for ${modelId}: ${err?.message ?? err}`);
    }
  }

  console.error('\nNone of the candidate embedding models were invokable on this account.');
  process.exit(1);
}

main().catch((err) => {
  console.error('find-embedding-model failed:', err);
  process.exit(1);
});
