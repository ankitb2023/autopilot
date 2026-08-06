import type { Request, Response } from 'express';

import { logger } from '../config/logger';

/**
 * GET /api/diag/egress
 *
 * Reports the public IP this host appears as to the outside world.
 *
 * Why this matters: Naukri binds a session to the IP that created it — the access
 * token even carries an `ipAdress` claim. If our outbound IP changes between runs,
 * the session is invalidated and the automation needs a manual OTP again. Render's
 * free tier makes no guarantee of a stable outbound IP, so this is the way to find
 * out whether IP drift is what keeps killing the session.
 *
 * Two independent services are queried because a single one can be down or lie, and
 * a disagreement between them is itself informative (proxying, IPv6 vs IPv4).
 */
const IP_SERVICES = [
  { name: 'ipify', url: 'https://api.ipify.org?format=json', field: 'ip' },
  { name: 'ipinfo', url: 'https://ipinfo.io/json', field: 'ip' },
] as const;

export async function egressIp(_req: Request, res: Response): Promise<void> {
  const results = await Promise.all(
    IP_SERVICES.map(async (service) => {
      try {
        const response = await globalThis.fetch(service.url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        const body = (await response.json()) as Record<string, unknown>;
        const value = body[service.field];
        return { source: service.name, ip: typeof value === 'string' ? value : null };
      } catch (error) {
        return { source: service.name, ip: null, error: (error as Error).message };
      }
    }),
  );

  const observed = [...new Set(results.map((r) => r.ip).filter((ip): ip is string => ip !== null))];

  logger.info('egress ip probe', { observed });

  res.json({
    egressIp: observed[0] ?? null,
    agree: observed.length === 1,
    results,
    // The IP the Naukri session was created at, for comparison.
    hint: 'Compare this across runs. If it changes, session death is IP drift and this host needs a static outbound IP.',
  });
}
