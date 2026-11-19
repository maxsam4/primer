import { logger } from '../logger.ts';
import { MailgunNotifier } from './mailgun.ts';
import { NoopNotifier } from './notifier.ts';
import type { Notifier } from './notifier.ts';

function deriveDomain(fromAddress: string): string | undefined {
  // Accepts "primer@domain" or "Primer <primer@domain>" — returns the host part.
  const match = fromAddress.match(/<?[^<\s@]+@([^>\s]+)>?\s*$/);
  return match?.[1];
}

export function notifierFromEnv(env: NodeJS.ProcessEnv = process.env): Notifier {
  const apiKey = env.MAILGUN_API_KEY;
  const fromAddress = env.EMAIL_FROM;
  const appBaseUrl = env.AUTH_BASE_URL;
  // Compose forwards unset overrides as empty strings, so treat '' as unset.
  const domain = env.MAILGUN_DOMAIN || (fromAddress ? deriveDomain(fromAddress) : undefined);
  const apiBaseUrl = env.MAILGUN_API_BASE_URL || undefined;
  if (apiKey && fromAddress && appBaseUrl && domain) {
    logger.info({ fromAddress, domain, apiBaseUrl }, 'notifier: Mailgun enabled');
    return new MailgunNotifier({ apiKey, domain, fromAddress, appBaseUrl, apiBaseUrl });
  }
  logger.warn(
    {
      hasApiKey: !!apiKey,
      hasFromAddress: !!fromAddress,
      hasAppBaseUrl: !!appBaseUrl,
      hasDomain: !!domain,
    },
    'notifier: Mailgun env incomplete, falling back to NoopNotifier',
  );
  return new NoopNotifier();
}
