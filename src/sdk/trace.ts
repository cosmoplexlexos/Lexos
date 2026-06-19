import { traceable } from 'langsmith/traceable';
import { config } from '../config';

// ──────────────────────────────────────────────────────────
// LangSmith tracing wrapper
//
// Usage in Phase 1+ (every enrich call is wrapped like this):
//
//   export const enrichExact = withTrace(
//     async (phrase, ctx) => { ... },
//     { name: 'enrich.exact', runType: 'retriever' }
//   );
//
// If LANGSMITH_API_KEY is not set the wrapper is a transparent
// passthrough — no overhead, no error, tracing just disabled.
// ──────────────────────────────────────────────────────────

export type RunType = 'chain' | 'llm' | 'tool' | 'retriever' | 'embedding';

export interface TraceOptions {
  name: string;
  runType?: RunType;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

/**
 * Wraps an async function with LangSmith tracing.
 * Passthrough when LANGSMITH_API_KEY is not set.
 */
export function withTrace<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends (...args: any[]) => Promise<any>
>(fn: T, options: TraceOptions): T {
  if (!config.langsmith.enabled) {
    return fn;
  }

  return traceable(fn, {
    name:         options.name,
    run_type:     options.runType ?? 'chain',
    project_name: config.langsmith.project,
    metadata:     options.metadata,
    tags:         options.tags,
  }) as T;
}

/**
 * Convenience wrapper specifically for enrich calls.
 * Attaches standard Lexos metadata so every trace carries context.
 */
export function withEnrichTrace<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends (...args: any[]) => Promise<any>
>(fn: T, stepName: string): T {
  return withTrace(fn, {
    name:    `lexos.enrich.${stepName}`,
    runType: 'retriever',
    tags:    ['enrich', stepName],
  });
}

/**
 * Convenience wrapper for generation pipeline calls.
 */
export function withGenerationTrace<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends (...args: any[]) => Promise<any>
>(fn: T, stepName: string): T {
  return withTrace(fn, {
    name:    `lexos.generation.${stepName}`,
    runType: 'llm',
    tags:    ['generation', stepName],
  });
}
