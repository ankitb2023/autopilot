import { Router } from 'express';

import { automationRouter } from './automation.routes';
import { healthRouter } from './health.routes';

/**
 * Single mounting point for the HTTP surface.
 *
 * `app.ts` mounts exactly one router, so adding a feature area (execution
 * history in Phase 4, auth in a later phase) is one line here rather than a
 * growing pile of `app.use` calls whose order becomes load-bearing.
 */
const router = Router();

router.use('/health', healthRouter);
router.use('/api', automationRouter);

export const rootRouter = router;
