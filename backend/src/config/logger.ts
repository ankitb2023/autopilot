import winston from 'winston';

import { getContext } from '../core/context';
import { env, isProduction } from './env';

/**
 * Logging strategy.
 *
 * - Production: single-line JSON on stdout. Render, Loki, Datadog and friends
 *   all ingest that without an agent, and Phase 6's dashboard can parse it.
 * - Development: colourised human-readable output.
 *
 * We deliberately do NOT write log files. Containers are ephemeral; the platform
 * owns log shipping. Execution *history* is a database concern (Phase 4), not a
 * logfile concern.
 */

/** Injects the ambient requestId / executionId into every record. */
const correlationFormat = winston.format((info) => {
  const context = getContext();
  if (context) {
    info.requestId = context.requestId;
    if (context.executionId) info.executionId = context.executionId;
  }
  return info;
});

const developmentFormat = winston.format.combine(
  winston.format.colorize({ level: true }),
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.printf((info) => {
    const { timestamp, level, message, stack, requestId, executionId, ...rest } = info;

    const tags = [requestId, executionId].filter(Boolean).join(' ');
    const meta = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
    const suffix = typeof stack === 'string' ? `\n${stack}` : '';

    return `${String(timestamp)} ${level}${tags ? ` [${tags}]` : ''} ${String(message)}${meta}${suffix}`;
  }),
);

const productionFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  defaultMeta: { service: 'autopilot-backend' },
  format: winston.format.combine(
    correlationFormat(),
    winston.format.errors({ stack: true }),
    isProduction ? productionFormat : developmentFormat,
  ),
  transports: [
    new winston.transports.Console({
      // Never let a logging failure take down an automation run.
      handleExceptions: false,
      handleRejections: false,
    }),
  ],
  exitOnError: false,
});

export type Logger = winston.Logger;

/**
 * Creates a child logger with permanent metadata — used to stamp every line
 * emitted by a worker with its provider and action.
 */
export function createChildLogger(meta: Record<string, unknown>): Logger {
  return logger.child(meta);
}
