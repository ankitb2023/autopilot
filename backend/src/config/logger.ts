import winston from 'winston';

import { env, isProduction } from './env';

/**
 * Logging: JSON to stdout in production (Render ingests it directly),
 * human-readable in development. No log files — the platform owns log shipping,
 * and execution history is a database concern.
 *
 * Correlation is handled by passing a child logger down through the execution
 * context, which stamps every line with executionId + provider. No async-context
 * machinery needed.
 */
export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: isProduction
    ? winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      )
    : winston.format.combine(
        winston.format.colorize({ level: true }),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
          const extra = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          return `${String(timestamp)} ${level} ${String(message)}${extra}${
            typeof stack === 'string' ? `\n${stack}` : ''
          }`;
        }),
      ),
  transports: [new winston.transports.Console()],
});

export type Logger = winston.Logger;
