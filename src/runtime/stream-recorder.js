import { getLogger } from '../utils/logger.js';
import { spawn } from 'node:child_process';

const logger = getLogger('stream-recorder');

/**
 * 直播流录制器
 * 支持：RTMP, HLS (m3u8), DASH
 */
export class StreamRecorder {
  constructor(options = {}) {
    this.outputDir = options.outputDir || './recordings';
  }

  /**
   * 开始录制
   * @param {string} url 直播流地址
   * @param {string} fileName 文件名
   */
  async record(url, fileName) {
    logger.info(`Starting stream recording: ${url}`);
    
    // 逻辑：利用 FFmpeg 进行无损流拷贝 (Stream Copy)
    const ffmpeg = spawn('ffmpeg', [
      '-i', url,
      '-c', 'copy',
      '-f', 'mp4',
      `${this.outputDir}/${fileName}.mp4`
    ]);

    ffmpeg.stderr.on('data', (data) => {
      logger.debug(`FFmpeg: ${data}`);
    });

    return new Promise((resolve, reject) => {
      ffmpeg.on('close', resolve);
      ffmpeg.on('error', reject);
    });
  }
}
