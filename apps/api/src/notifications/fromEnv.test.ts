import { describe, it, expect, afterEach, vi } from 'vitest';
import { notifierFromEnv } from './fromEnv.ts';

const base = {
  MAILGUN_API_KEY: 'key-1',
  EMAIL_FROM: 'Primer <primer@mail.example.com>',
  AUTH_BASE_URL: 'https://primer.example.com',
};

async function sendOtp(env: NodeJS.ProcessEnv): Promise<string> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
  await notifierFromEnv(env).notifyExternalOtp({ toEmail: 'client@example.com', code: '123456' });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  return String(fetchSpy.mock.calls[0][0]);
}

describe('notifierFromEnv', () => {
  afterEach(() => vi.restoreAllMocks());

  it('derives the sending domain from EMAIL_FROM and uses the default API host', async () => {
    expect(await sendOtp(base)).toBe('https://api.mailgun.net/v3/mail.example.com/messages');
  });

  it('honours MAILGUN_DOMAIN and MAILGUN_API_BASE_URL', async () => {
    const url = await sendOtp({
      ...base,
      MAILGUN_DOMAIN: 'mg.example.com',
      MAILGUN_API_BASE_URL: 'https://api.eu.mailgun.net/',
    });
    expect(url).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
  });

  it('treats empty overrides (as compose forwards them) as unset', async () => {
    const url = await sendOtp({ ...base, MAILGUN_DOMAIN: '', MAILGUN_API_BASE_URL: '' });
    expect(url).toBe('https://api.mailgun.net/v3/mail.example.com/messages');
  });
});
