export type ErrorSeverity = 'TRANSIENT' | 'FATAL';

export interface ClassifiedError {
  severity: ErrorSeverity;
  category: string;
  userMessage: string;
  remedySuggestion?: string;
}

export class ErrorClassifier {
  private static fatalPatterns = [
    { pattern: /ENOENT.*package\.json/i, category: 'MISSING_PROJECT_ROOT', remedy: 'Ensure workspace directory contains valid project files.' },
    { pattern: /EACCES|permission denied/i, category: 'SYSTEM_PERMISSION_DENIED', remedy: 'Check file system permissions or run with appropriate access.' },
    { pattern: /ECONNREFUSED|ENOTFOUND.*(api\.openai|api\.)/i, category: 'NETWORK_UNREACHABLE', remedy: 'Verify network connection and API endpoint availability.' },
    { pattern: /invalid_api_key|Incorrect API key|authentication.*failed/i, category: 'AUTH_FAILED', remedy: 'Provide a valid API key in environment variables.' },
    { pattern: /command not found: (git|docker|node|npm)/i, category: 'MISSING_SYSTEM_TOOL', remedy: 'Install required system binary on the host machine.' },
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
        };
      }
    }

    // Default to transient
    return {
      severity: 'TRANSIENT',
      category: 'RECOVERABLE_STEP_ERROR',
      userMessage: `Encountered step error: ${message}`,
      remedySuggestion: 'Agent can analyze the error and attempt self-healing within budget.',
    };
  }
}
