import winston from 'winston';

/**
 * Application logger using Winston
 * Outputs to console and log files with structured JSON format
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  // Vitest sets NODE_ENV=test; keep unit-test output clean.
  silent: process.env.NODE_ENV === 'test',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'code-review-system' },
  transports: [
    // Error logs
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error'
    }),
    // Combined logs
    new winston.transports.File({
      filename: 'logs/combined.log'
    })
  ]
});

// Console output for non-production
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ level, message, timestamp, ...meta }) => {
        const metaStr = Object.keys(meta).length > 1
          ? `\n${JSON.stringify(meta, null, 2)}`
          : '';
        return `${timestamp} [${level}]: ${message}${metaStr}`;
      })
    )
  }));
}

/**
 * Mute or restore console log output (file logs are unaffected), e.g. while a CLI spinner owns the terminal.
 */
export function setConsoleLogging(enabled: boolean): void {
  for (const transport of logger.transports) {
    if (transport instanceof winston.transports.Console) transport.silent = !enabled;
  }
}

/**
 * Log helper functions for common operations
 */
export const logReviewStart = (owner: string, repo: string, prNumber: number) => {
  logger.info('Starting code review', { owner, repo, prNumber });
};

export const logReviewComplete = (
  owner: string,
  repo: string,
  prNumber: number,
  score: number,
  duration: number
) => {
  logger.info('Code review completed', {
    owner,
    repo,
    prNumber,
    score,
    duration,
    status: 'success'
  });
};

export const logReviewError = (
  owner: string,
  repo: string,
  prNumber: number,
  error: Error
) => {
  logger.error('Code review failed', {
    owner,
    repo,
    prNumber,
    error: error.message,
    stack: error.stack,
    status: 'failed'
  });
};

export const logAgentStart = (agentName: string, scope: string) => {
  logger.info('Subagent starting', { agent: agentName, scope });
};

export const logAgentComplete = (agentName: string, scope: string, duration: number, success = true) => {
  logger.log(success ? 'info' : 'warn', 'Subagent completed', { agent: agentName, scope, duration, success });
};

