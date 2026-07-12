// Text embedding helper backed by Amazon Bedrock. Model + dimension are discovered once by
// scripts/find-embedding-model.mjs and recorded as BEDROCK_EMBEDDING_MODEL_ID / EMBEDDING_DIM
// in .env.local — this module just invokes whichever model id is configured, branching on
// its request/response shape (Titan vs Cohere) since Bedrock has no single embedding API.
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

// Constructed once at module load, same rationale as the Converse client in handler.mjs:
// reuse the connection across warm invocations instead of paying setup cost per call.
const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

function isTitanModel(modelId) {
  return /titan-embed/i.test(modelId ?? '');
}

function isCohereModel(modelId) {
  return /cohere\.embed/i.test(modelId ?? '');
}

function buildRequestBody(modelId, text) {
  if (isTitanModel(modelId)) {
    const dimensions = process.env.EMBEDDING_DIM ? Number(process.env.EMBEDDING_DIM) : undefined;
    return {
      inputText: text,
      ...(dimensions ? { dimensions, normalize: true } : {}),
    };
  }
  if (isCohereModel(modelId)) {
    return { texts: [text], input_type: 'search_document' };
  }
  // Fall back to the Titan-shaped request for any unrecognized embedding model id.
  return { inputText: text };
}

function readEmbedding(modelId, parsedBody) {
  if (isCohereModel(modelId)) {
    return parsedBody.embeddings?.[0];
  }
  return parsedBody.embedding ?? parsedBody.embeddings?.[0];
}

/**
 * Embeds a single piece of text into a dense vector using the configured Bedrock model.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('embedText requires a non-empty string');
  }

  const modelId = process.env.BEDROCK_EMBEDDING_MODEL_ID;
  if (!modelId) {
    throw new Error('BEDROCK_EMBEDDING_MODEL_ID is not configured');
  }

  const response = await client.send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(buildRequestBody(modelId, text)),
    })
  );

  const parsed = JSON.parse(Buffer.from(response.body).toString('utf8'));
  const embedding = readEmbedding(modelId, parsed);
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Bedrock embedding response did not contain an embedding array');
  }
  return embedding;
}
