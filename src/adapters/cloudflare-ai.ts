import { config } from '../config';

// ──────────────────────────────────────────────────────────
// Cloudflare Workers AI — embedding generation
//
// Model: @cf/baai/bge-m3 (1024 dimensions, multilingual)
// Endpoint: POST /accounts/{accountId}/ai/run/{model}
//
// Used by: /enrich (OOD gate + menu/classifier embeddings), the offline
// classifier trainer, and menu ingestion.
// ──────────────────────────────────────────────────────────

export const EMBED_MODEL_NAME    = '@cf/baai/bge-m3';
export const EMBED_MODEL_VERSION = '1.0';
export const EMBED_DIMENSIONS    = 1024;

interface CloudflareAiResponse {
  result:  { data: number[][] };
  success: boolean;
  errors:  Array<{ message: string }>;
}

/**
 * Generates a 1024-dimensional embedding for a single text string
 * using Cloudflare Workers AI (bge-m3, multilingual).
 *
 * Throws if Cloudflare credentials are missing or the API call fails.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const { accountId, apiToken, embedModel } = config.cloudflare;

  if (!accountId || !apiToken) {
    throw new Error(
      'Cloudflare credentials not configured. ' +
      'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .env before using semantic search.',
    );
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${embedModel}`;

  const response = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ text: [text] }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)');
    throw new Error(`Cloudflare AI HTTP ${response.status}: ${body}`);
  }

  const data = (await response.json()) as CloudflareAiResponse;

  if (!data.success) {
    const msg = data.errors?.map(e => e.message).join(', ') ?? 'unknown error';
    throw new Error(`Cloudflare AI returned failure: ${msg}`);
  }

  const embedding = data.result?.data?.[0];
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(
      `Cloudflare AI returned unexpected embedding shape ` +
      `(expected ${EMBED_DIMENSIONS} dims, got ${embedding?.length ?? 'none'})`,
    );
  }

  return embedding;
}

/**
 * Batched embedding generation — sends up to batchSize texts per API call.
 * Returns embeddings in the same order as the input texts.
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  batchSize = 10,
): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const { accountId, apiToken, embedModel } = config.cloudflare;

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${embedModel}`;

    const response = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ text: batch }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      throw new Error(`Cloudflare AI HTTP ${response.status}: ${body}`);
    }

    const data = (await response.json()) as CloudflareAiResponse;
    if (!data.success) {
      const msg = data.errors?.map(e => e.message).join(', ') ?? 'unknown error';
      throw new Error(`Cloudflare AI batch failed: ${msg}`);
    }

    results.push(...data.result.data);
  }

  return results;
}
