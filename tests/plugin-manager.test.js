import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginManager } from '../src/plugins/plugin-manager.js';

test('plugin manager loads external plugin modules from workflow config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-plugin-manager-'));
  const pluginPath = join(root, 'plugins', 'custom-plugin.js');

  try {
    await mkdir(join(root, 'plugins'), { recursive: true });
    await writeFile(
      pluginPath,
      `export default function customPlugin() {
        return {
          name: 'custom-plugin',
          async beforeRequest({ request }) {
            request.headers = request.headers ?? {};
            request.headers['x-custom-plugin'] = 'on';
          },
        };
      }`,
    );

    const manager = new PluginManager(
      [
        {
          name: 'custom-plugin',
          path: './plugins/custom-plugin.js',
        },
      ],
      {
        projectRoot: root,
        runDir: root,
      },
    );

    await manager.init();

    const request = {
      url: 'https://example.com',
      headers: {},
    };

    await manager.runHook('beforeRequest', {
      request,
    });

    assert.equal(request.headers['x-custom-plugin'], 'on');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
