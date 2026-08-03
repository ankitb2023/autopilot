import { Router } from 'express';

import { getHealth, getReadiness } from '../controllers/health.controller';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.get('/', getHealth);
/** Kubernetes-style alias, so a future platform migration needs no config change. */
router.get('/live', getHealth);
router.get('/ready', asyncHandler(getReadiness));

export const healthRouter = router;
