import { Router } from 'express';

import { listProviders, updateProfile } from '../controllers/automation.controller';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { updateProfileBodySchema } from '../validation/automation.schema';

const router = Router();

/**
 * POST /api/profile/update
 *
 * Provider-agnostic by contract: `{ "provider": "naukri" }` today,
 * `{ "provider": "linkedin" }` once that worker is registered — same route, same
 * controller, same validation.
 */
router.post(
  '/profile/update',
  validate({ body: updateProfileBodySchema }),
  asyncHandler(updateProfile),
);

/** GET /api/providers — capability discovery for the dashboard and mobile app. */
router.get('/providers', listProviders);

export const automationRouter = router;
