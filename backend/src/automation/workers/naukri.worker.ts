import { chromium, type Browser } from 'playwright';
import type {
  AutomationAction,
  AutomationWorker,
  ExecutionContext,
  ProviderId,
  WorkerOutcome,
} from '../types';
import { env } from '../../config/env'; // Assuming env has credentials, or we will add them later

/**
 * Naukri automation worker — Phase 3 (Playwright).
 */
export class NaukriWorker implements AutomationWorker {
  readonly provider: ProviderId = 'naukri';
  readonly supportedActions: readonly AutomationAction[] = ['profile.update'];

  async execute({ logger, dryRun, signal }: ExecutionContext): Promise<WorkerOutcome> {
    logger.info('naukri worker starting', { dryRun });
    signal.throwIfAborted();

    let browser: Browser | null = null;
    try {
      logger.info('launching browser');
      browser = await chromium.launch({
        headless: env.NODE_ENV === 'production',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      signal.throwIfAborted();

      let cookies = [];
      if (env.NAUKRI_COOKIES) {
        try {
          cookies = JSON.parse(env.NAUKRI_COOKIES);
          logger.info('parsed NAUKRI_COOKIES from environment');
        } catch (e) {
          throw new Error('NAUKRI_COOKIES is not valid JSON. Ensure you exported cookies correctly.');
        }
      } else {
        logger.warn('NAUKRI_COOKIES not provided. Attempting to run without session (will likely hit login).');
      }

      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        javaScriptEnabled: true,
        extraHTTPHeaders: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1'
        }
      });
      
      if (cookies.length > 0) {
        // Sanitize cookies because Chrome extensions sometimes export invalid Playwright formats
        const sanitizedCookies = cookies.map((cookie: any) => {
          if (cookie.sameSite && !['Strict', 'Lax', 'None'].includes(cookie.sameSite)) {
            if (cookie.sameSite.toLowerCase() === 'no_restriction') cookie.sameSite = 'None';
            else if (cookie.sameSite.toLowerCase() === 'lax') cookie.sameSite = 'Lax';
            else if (cookie.sameSite.toLowerCase() === 'strict') cookie.sameSite = 'Strict';
            else delete cookie.sameSite;
          }
          return cookie;
        });

        await context.addCookies(sanitizedCookies);
        logger.info('injected session cookies into browser context');
      }

      const page = await context.newPage();
      
      // 1. Inject anti-bot scripts to hide the fact that we are using a headless browser
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        (window as any).chrome = { runtime: {} };
        // Overwrite permissions to avoid headless leak
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters: any) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission } as PermissionStatus) :
            originalQuery(parameters)
        );
      });
      
      logger.info('navigating to homepage first (referrer spoofing)');
      await page.goto('https://www.naukri.com/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      
      logger.info('navigating to naukri profile page');
      await page.goto('https://www.naukri.com/mnjuser/profile', { waitUntil: 'domcontentloaded' });
      signal.throwIfAborted();
      
      // Give React some time to render the initial DOM just in case
      await page.waitForTimeout(3000);
      
      // Check if we were redirected to login page due to expired cookies
      if (page.url().includes('login')) {
        throw new Error('Redirected to login page. Your NAUKRI_COOKIES have expired or are invalid.');
      }
      
      if (dryRun) {
        logger.info('dry run: skipping actual profile update actions');
      } else {
        logger.info('updating profile (simulating activity)');
        
        try {
          logger.info('waiting for Key skills section');
          
          // Target the specific "Key skills" widget using its ID container
          const editIcon = page.locator('#lazyKeySkills .edit.icon');
          
          await editIcon.waitFor({ state: 'visible', timeout: 15000 });
          await editIcon.click();
          
          logger.info('clicked edit, waiting for save button on Key skills modal');
          
          // Target the specific save button ID shown in the screenshot
          const saveButton = page.locator('#saveKeySkills');
          await saveButton.waitFor({ state: 'visible', timeout: 5000 });
          await saveButton.click();
          
          logger.info('saved profile successfully');
          // Wait for save operation to complete
          await page.waitForTimeout(3000); 
        } catch (e: any) {
          logger.warn('could not execute the exact edit/save sequence. Taking screenshot and continuing.', { error: e.message });
          logger.warn(`Debug info - Current URL: ${page.url()}`);
          
          let screenshotBase64 = '';
          try {
            // Wait an extra 2 seconds before screenshot to ensure the page isn't just loading slowly
            await page.waitForTimeout(2000);
            const buffer = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: true });
            screenshotBase64 = buffer.toString('base64');
            logger.info('captured debug screenshot');
          } catch (screenshotError) {
            logger.error('failed to capture screenshot', { error: String(screenshotError) });
          }

          return {
            success: false,
            message: `Failed to find or click Key skills section: ${e.message}`,
            details: { 
              dryRun, 
              url: page.url(),
              screenshot: screenshotBase64 ? `data:image/jpeg;base64,${screenshotBase64}` : 'Failed to capture' 
            },
          };
        }
      }

      return {
        success: true,
        message: 'Naukri profile updated successfully.',
        details: { dryRun },
      };
    } catch (error: any) {
      logger.error('naukri worker failed', { error: error.message, stack: error.stack });
      return {
        success: false,
        message: 'Failed to update Naukri profile',
        details: { error: error.message },
      };
    } finally {
      if (browser) {
        logger.info('closing browser');
        await browser.close().catch(e => logger.error('failed to close browser', { error: e.message }));
      }
    }
  }
}
