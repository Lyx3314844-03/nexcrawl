import { HttpCrawler } from '../api/crawler-presets.js';
import { getLogger } from '../utils/logger.js';
import { createTorAgent } from '../fetchers/socks5-proxy.js';

const logger = getLogger('tor-crawler');

function parseTorProxy(proxyUrl) {
  const parsed = new URL(proxyUrl);
  return {
    host: parsed.hostname,
    socksPort: parsed.port ? Number(parsed.port) : 9050,
  };
}

/**
 * Tor-backed crawler.
 *
 * This preset binds the workflow to a SOCKS5/SOCKS5h Tor proxy so normal HTTP
 * fetches, crawl-policy lookups, and follow-up requests all route through the
 * same Tor circuit.
 */
export class TorCrawler extends HttpCrawler {
  constructor(options = {}) {
    super(options);
    this.torProxy = options.torProxy || 'socks5h://127.0.0.1:9050';
    this.torControlPort = options.torControlPort ?? 9051;
    this.torControlPassword = options.torControlPassword;
    this._torAgent = null;

    this.useProxy({ server: this.torProxy });
  }

  async #getTorAgent() {
    if (this._torAgent) {
      return this._torAgent;
    }

    const connection = parseTorProxy(this.torProxy);
    this._torAgent = await createTorAgent({
      host: connection.host,
      socksPort: connection.socksPort,
      controlPort: this.torControlPort,
      controlPassword: this.torControlPassword,
    });
    return this._torAgent;
  }

  async renewIdentity() {
    logger.info('Requesting new Tor identity...');
    const agent = await this.#getTorAgent();
    return agent.renewIdentity();
  }

  async checkTorConnection() {
    const agent = await this.#getTorAgent();
    return agent.checkTorConnection();
  }
}
