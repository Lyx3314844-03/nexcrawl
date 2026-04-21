import http2 from 'node:http2';
import { getLogger } from '../utils/logger.js';
import { inferProtobufStructure, decodeWithInferredSchema, encodeGrpcFrame } from '../reverse/protobuf-inferrer.js';

const logger = getLogger('grpc-crawler');

export class GrpcCrawler {
  constructor(options = {}) {
    this.endpoint = options.endpoint;
    this.session = null;
  }

  /**
   * 执行全自动 gRPC 请求 (无需 Proto 文件)
   */
  async call(service, method, message) {
    if (!this.session) await this._connect();

    const path = `/${service}/${method}`;
    logger.info(`Invoking RPC: ${path}`);

    // 1. 自动编码载荷
    const payload = encodeGrpcFrame(Buffer.from(JSON.stringify(message))); 

    return new Promise((resolve, reject) => {
      const req = this.session.request({
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/grpc',
        'te': 'trailers'
      });

      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const fullBody = Buffer.concat(chunks);
        // 2. 自动推断结构并解码
        const schema = inferProtobufStructure(fullBody.subarray(5));
        const decoded = decodeWithInferredSchema(fullBody.subarray(5), schema);
        resolve(decoded);
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  async _connect() {
    this.session = http2.connect(this.endpoint);
    logger.debug('H2 session established.');
  }
}
