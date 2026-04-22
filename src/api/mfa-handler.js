import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('mfa-handler');
const require = createRequire(import.meta.url);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePattern(pattern) {
  if (pattern instanceof RegExp) {
    return pattern;
  }
  if (typeof pattern === 'string' && pattern.trim()) {
    return new RegExp(pattern, 'i');
  }
  return /\b(\d{6})\b/;
}

function extractCodeFromText(text, pattern) {
  const normalized = normalizePattern(pattern);
  const match = String(text ?? '').match(normalized);
  if (!match) {
    return null;
  }
  return String(match[1] ?? match[0] ?? '').trim() || null;
}

function decodeBase32(input = '') {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = String(input).toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
  let bits = '';

  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      continue;
    }
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(secret, options = {}) {
  if (!secret) {
    throw new Error('TOTP secret is required');
  }

  const digits = Math.max(4, Number(options.digits ?? 6) || 6);
  const period = Math.max(1, Number(options.period ?? 30) || 30);
  const timestamp = Number(options.timestamp ?? Date.now());
  const algorithm = String(options.algorithm ?? 'sha1').toLowerCase();
  const counter = Math.floor(timestamp / 1000 / period);

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const keyBuffer =
    options.encoding === 'ascii'
      ? Buffer.from(String(secret), 'ascii')
      : decodeBase32(secret);

  const digest = createHmac(algorithm, keyBuffer).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);

  return String(binary % (10 ** digits)).padStart(digits, '0');
}

async function loadImapModule() {
  const moduleValue = require('node-imap');
  return moduleValue?.default ?? moduleValue;
}

function buildImapSearchCriteria(filter, config = {}) {
  if (Array.isArray(config.searchCriteria) && config.searchCriteria.length > 0) {
    return config.searchCriteria;
  }

  const criteria = ['UNSEEN'];
  if (filter) {
    criteria.push(['OR', ['SUBJECT', String(filter)], ['FROM', String(filter)]]);
  }
  return criteria;
}

async function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.once('error', reject);
  });
}

async function typeIntoPage(page, selector, code) {
  if (typeof page?.fill === 'function') {
    await page.fill(selector, code);
    return;
  }

  if (typeof page?.locator === 'function') {
    await page.locator(selector).fill(code);
    return;
  }

  if (typeof page?.$eval === 'function') {
    await page.$eval(selector, (element) => {
      if ('value' in element) {
        element.value = '';
      }
    });
  }

  if (typeof page?.focus === 'function') {
    await page.focus(selector);
  }

  if (typeof page?.type === 'function') {
    await page.type(selector, code);
    return;
  }

  throw new Error('Page object does not support fill/type interactions');
}

async function clickPage(page, selector) {
  if (!selector) {
    return;
  }
  if (typeof page?.click === 'function') {
    await page.click(selector);
    return;
  }
  if (typeof page?.locator === 'function') {
    await page.locator(selector).click();
    return;
  }
  throw new Error('Page object does not support click interactions');
}

/**
 * MFA handler with pluggable providers.
 * Supported providers:
 * - static: fixed code from config.code
 * - totp: generated from config.secret
 * - imap: polls an inbox and extracts the newest code
 * - custom/function: callback-based provider
 */
export class MfaHandler {
  constructor(options = {}) {
    this.provider = options.provider ?? 'static';
    this.config = options.config ?? {};
    this.codePattern = options.codePattern ?? this.config.codePattern ?? /\b(\d{6})\b/;
    this.pollIntervalMs = Number(options.pollIntervalMs ?? this.config.pollIntervalMs ?? 5000) || 5000;
    this.timeoutMs = Number(options.timeoutMs ?? this.config.timeoutMs ?? 120000) || 120000;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.imapFactory = options.imapFactory ?? this.config.imapFactory ?? null;
  }

  /**
   * Fetch the latest MFA code.
   * @param {string} filter
   * @param {object} [options]
   * @returns {Promise<string>}
   */
  async getCode(filter, options = {}) {
    logger.info(`Waiting for MFA code for ${filter ?? 'default'}...`);

    if (typeof this.provider === 'function') {
      const code = await this.provider({
        filter,
        options,
        config: this.config,
        handler: this,
      });
      if (!code) {
        throw new Error('Custom MFA provider returned an empty code');
      }
      return String(code);
    }

    switch (String(this.provider).toLowerCase()) {
      case 'static': {
        const code = options.code ?? this.config.code;
        if (!code) {
          throw new Error('Static MFA provider requires config.code');
        }
        return String(code);
      }

      case 'totp': {
        return generateTotp(this.config.secret, {
          digits: this.config.digits,
          period: this.config.period,
          timestamp: options.timestamp ?? this.now(),
          algorithm: this.config.algorithm,
          encoding: this.config.encoding,
        });
      }

      case 'imap': {
        return this._fetchFromEmail(filter, options);
      }

      case 'custom':
      case 'callback': {
        const fn = options.provider ?? this.config.provider;
        if (typeof fn !== 'function') {
          throw new Error('Custom MFA provider requires a provider function');
        }
        const code = await fn({
          filter,
          options,
          config: this.config,
          handler: this,
        });
        if (!code) {
          throw new Error('Custom MFA provider returned an empty code');
        }
        return String(code);
      }

      default:
        throw new Error(`Unsupported MFA provider: ${this.provider}`);
    }
  }

  async _fetchFromEmail(filter, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? this.timeoutMs) || this.timeoutMs;
    const startedAt = this.now();

    while (this.now() - startedAt < timeoutMs) {
      const code = await this._readLatestEmailCode(filter, options).catch((error) => {
        logger.warn('MFA IMAP read attempt failed', { error: error.message });
        return null;
      });

      if (code) {
        return code;
      }

      await delay(this.pollIntervalMs);
    }

    throw new Error('Timed out waiting for MFA code from email');
  }

  async _readLatestEmailCode(filter, options = {}) {
    if (this.imapFactory && typeof this.imapFactory.getLatestCode === 'function') {
      const code = await this.imapFactory.getLatestCode(filter, {
        options,
        config: this.config,
        pattern: this.codePattern,
      });
      return code ? String(code) : null;
    }

    const Imap = await loadImapModule();
    const imap = this.imapFactory
      ? this.imapFactory
      : new Imap({
          user: this.config.user,
          password: this.config.password,
          host: this.config.host,
          port: Number(this.config.port ?? 993) || 993,
          tls: this.config.tls !== false,
          tlsOptions: this.config.tlsOptions,
        });

    const openBoxName = this.config.mailbox ?? 'INBOX';
    const searchCriteria = buildImapSearchCriteria(filter, this.config);
    const fetchBodies = this.config.fetchBodies ?? '';

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value = null) => {
        if (settled) return;
        settled = true;
        try {
          if (typeof imap.end === 'function') {
            imap.end();
          }
        } catch {
          // ignore shutdown errors
        }
        if (error) {
          reject(error);
          return;
        }
        resolve(value);
      };

      imap.once?.('error', (error) => finish(error));
      imap.once?.('end', () => {
        if (!settled) {
          finish(null, null);
        }
      });

      imap.once?.('ready', () => {
        imap.openBox(openBoxName, true, (openError) => {
          if (openError) {
            finish(openError);
            return;
          }

          imap.search(searchCriteria, (searchError, results = []) => {
            if (searchError) {
              finish(searchError);
              return;
            }
            if (!results.length) {
              finish(null, null);
              return;
            }

            const messages = [];
            const fetcher = imap.fetch(results.slice(-10), {
              bodies: fetchBodies,
              markSeen: false,
              struct: true,
            });
            const bodyReads = [];

            fetcher.on('message', (message) => {
              const entry = { body: '', date: 0 };
              messages.push(entry);

              message.on('body', (stream) => {
                bodyReads.push(
                  readStream(stream).then((body) => {
                    entry.body += body;
                  }),
                );
              });

              message.once('attributes', (attrs) => {
                entry.date = attrs?.date ? new Date(attrs.date).getTime() : 0;
              });
            });

            fetcher.once('error', (error) => finish(error));
            fetcher.once('end', async () => {
              await Promise.all(bodyReads);
              const latest = messages
                .sort((left, right) => right.date - left.date)
                .map((entry) => extractCodeFromText(entry.body, this.codePattern))
                .find(Boolean);
              finish(null, latest ?? null);
            });
          });
        });
      });

      if (typeof imap.connect === 'function') {
        imap.connect();
      } else {
        finish(new Error('IMAP client does not support connect()'));
      }
    });
  }
}

/**
 * Fetch an MFA code and submit it through a page object.
 */
export async function solveLoginMfa(page, mfaHandler, inputSelector, options = {}) {
  if (!page) {
    throw new Error('page is required');
  }
  if (!mfaHandler || typeof mfaHandler.getCode !== 'function') {
    throw new Error('mfaHandler with getCode() is required');
  }
  if (!inputSelector) {
    throw new Error('inputSelector is required');
  }

  const code = await mfaHandler.getCode(options.filter, options);
  await typeIntoPage(page, inputSelector, code);
  await clickPage(page, options.submitSelector ?? 'button[type="submit"]');
  return code;
}

export function buildOtpSecretFingerprint(secret) {
  return createHash('sha256').update(String(secret ?? '')).digest('hex');
}
