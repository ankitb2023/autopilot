import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { corsOrigins, isProduction } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { apiRateLimiter } from './middleware/rateLimiter';
import { requestContext } from './middleware/requestContext';
import { requestLogger } from './middleware/requestLogger';
import { rootRouter } from './routes';

/**
 * Builds the Express application.
 *
 * Kept separate from `server.ts` so the app can be constructed without binding a
 * port — which is what makes it testable with Supertest, and what will let a
 * future WebSocket server (Phase 9) attach to the same HTTP server.
 *
 * Middleware order is deliberate and load-bearing:
 *
 *   1. trust proxy    — Render terminates TLS, so req.ip must come from XFF
 *   2. requestContext — must be first so *everything* after it is correlated
 *   3. helmet / cors  — reject unwanted traffic before spending work on it
 *   4. body parsing   — with a size cap, before any handler reads the body
 *   5. requestLogger  — after the ID exists, before routing
 *   6. routes
 *   7. notFound → errorHandler — always last
 */
export function createApp(): Express {
  const app = express();

  // Render/Neon sit behind a proxy. Without this, rate limiting and access logs
  // see the proxy's IP for every caller. `1` = trust exactly one hop; a blanket
  // `true` would let clients spoof their IP via a forged X-Forwarded-For.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestContext());

  app.use(
    helmet({
      // No cookies, no browser-rendered HTML — this is a JSON API.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: corsOrigins,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Api-Key'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 86_400,
    }),
  );

  app.use(compression());

  // 100kb is generous for our JSON payloads and small enough that a hostile body
  // cannot exhaust memory. Raised deliberately if resume upload ever posts here
  // (more likely: that becomes multipart on its own route).
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.use(requestLogger());

  app.use('/api', apiRateLimiter());
  app.use(rootRouter);

  // Root convenience response — cheap, and stops "is it even deployed?" doubts.
  app.get('/', (_req, res) => {
    res.json({ name: 'AutoPilot', status: 'ok', docs: '/health' });
  });

  app.use(notFoundHandler());
  app.use(errorHandler());

  if (!isProduction) {
    app.set('json spaces', 2);
  }

  return app;
}
