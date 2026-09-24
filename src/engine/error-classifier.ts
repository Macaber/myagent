export type ErrorSeverity = 'TRANSIENT' | 'FATAL';

export interface ClassifiedError {
  severity: ErrorSeverity;
  category: string;
  userMessage: string;
  remedySuggestion?: string;
  /** Hint for future callers: whether a retry makes sense at all. */
  retryable?: boolean;
  /** Suggested backoff before retry (ms). Only meaningful when retryable. */
  backoffMs?: number;
  /** True when the fix is context compaction rather than retry. */
  needsCompaction?: boolean;
}

export class ErrorClassifier {
  private static fatalPatterns = [
    { pattern: /ENOENT.*package\.json/i, category: 'MISSING_PROJECT_ROOT', remedy: 'Ensure workspace directory contains valid project files.' },
    { pattern: /EACCES|permission denied/i, category: 'SYSTEM_PERMISSION_DENIED', remedy: 'Check file system permissions or run with appropriate access.' },
    { pattern: /ECONNREFUSED|ENOTFOUND.*(api\.openai|api\.)/i, category: 'NETWORK_UNREACHABLE', remedy: 'Verify network connection and API endpoint availability.' },
    { pattern: /invalid_api_key|Incorrect API key|authentication.*failed|\[401\]/i, category: 'AUTH_FAILED', remedy: 'Provide a valid API key in environment variables.' },
    { pattern: /model_not_found|model .* does not exist|\[404\]/i, category: 'MODEL_NOT_FOUND', remedy: 'Check OPENAI_MODEL — the configured model id does not exist on this endpoint.' },
    { pattern: /command not found: (git|docker|node|npm)/i, category: 'MISSING_SYSTEM_TOOL', remedy: 'Install required system binary on the host machine.' },
  ];

  private static transientPatterns = [
    { pattern: /\[429\]|rate.?limit|429 Too Many/i, category: 'RATE_LIMITED', remedy: 'Back off and retry with exponential delay honoring Retry-After.', backoffMs: 5000 },
    { pattern: /\[50[0234]\]|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up|network.*timeout/i, category: 'PROVIDER_UNAVAILABLE', remedy: 'Retry with exponential backoff; fail over if persistent.', backoffMs: 2000 },
    { pattern: /context_length_exceeded|maximum context|context window|too many tokens/i, category: 'CONTEXT_OVERFLOW', remedy: 'Compact context before retrying; do not blind-retry the same payload.', backoffMs: 0 },
    { pattern: /aborted|AbortError|cancelled/i, category: 'ABORTED', remedy: 'Request was cancelled; do not retry automatically.', backoffMs: 0 },
  ];

  public static classify(error: Error | string): ClassifiedError {
    const message = typeof error === 'string' ? error : error.message;

    for (const item of this.fatalPatterns) {
      if (item.pattern.test(message)) {
        return {
          severity: 'FATAL',
          category: item.category,
          userMessage: `Fatal error encountered: ${message}`,
          remedySuggestion: item.remedy,
          retryable: false,
        };
      }
    }

    for (const item of this.transientPatterns) {
      if (item.pattern.test(message)) {
        return {
          severity: 'TRANSIENT',
          category: item.category,
          userMessage: `Encountered step error: ${message}`,
          remedySuggestion: item.remedy,
          retryable: item.category !== 'ABORTED',
          backoffMs: item.backoffMs,
          needsCompaction: item.category === 'CONTEXT_OVERFLOW',
        };
      }
    }

    // Default to transient
    return {
      severity: 'TRANSIENT',
      category: 'RECOVERABLE_STEP_ERROR',
      userMessage: `Encountered step error: ${message}`,
      remedySuggestion: 'Agent can analyze the error and attempt self-healing within budget.',
      retryable: true,
    };
  }
}
