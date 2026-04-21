import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppCaptureManager } from '../src/runtime/app-capture-manager.js';
import { startServer } from '../src/server.js';

test('app capture manager starts and stops runnable capture sessions', async () => {
  const manager = new AppCaptureManager();
  const session = await manager.start({
    app: {
      frida: {
        enabled: true,
        exec: {
          command: process.execPath,
          args: ['-e', 'setTimeout(() => process.exit(0), 5000)'],
        },
      },
    },
    options: {
      toolStatus: {
        frida: { available: true, version: 'test' },
        'frida-ps': { available: true, version: 'test' },
        mitmdump: { available: false, version: null },
        mitmproxy: { available: false, version: null },
      },
    },
  });

  assert.equal(session.status, 'running');
  assert.equal(session.processes.length, 1);

  await sleep(100);
  const stopped = await manager.stop(session.id);
  assert.ok(stopped);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.processes.length, 1);
  assert.ok(stopped.assetRef?.assetId);
  const stored = await manager.assetStore.readLatestAsset('app-captures', `tool-app-capture-${session.id}`);
  assert.equal(stored?.payload?.status, 'stopped');
});

test('app capture manager generates default helper scripts and planned artifact paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-app-capture-'));

  try {
    const manager = new AppCaptureManager({ projectRoot: root });
    const session = await manager.start({
      app: {
        bundleId: 'com.example.demo',
        frida: {
          enabled: true,
          exec: {
            command: process.execPath,
            args: ['-e', 'setTimeout(() => process.exit(0), 50)'],
          },
        },
        mitmproxy: {
          enabled: true,
          exec: {
            command: process.execPath,
            args: ['-e', 'setTimeout(() => process.exit(0), 50)'],
          },
        },
      },
      options: {
        toolStatus: {
          frida: { available: true, version: 'test' },
          'frida-ps': { available: true, version: 'test' },
          mitmdump: { available: true, version: 'test' },
          mitmproxy: { available: true, version: 'test' },
        },
      },
    });

    assert.equal(session.status, 'running');
    assert.ok(session.captureDir);
    assert.ok(session.assetRef?.assetId);
    assert.equal(session.assetRef.assetId, `tool-app-capture-${session.id}`);
    const stored = await manager.assetStore.readLatestAsset('app-captures', `tool-app-capture-${session.id}`);
    assert.equal(stored?.payload?.status, 'starting');
    assert.equal(stored?.payload?.target?.bundleId, 'com.example.demo');
    assert.ok(session.generated.fridaScriptPath.endsWith('frida-auto.js'));
    assert.ok(session.generated.mitmproxyAddonPath.endsWith('mitm-addon.py'));
    assert.ok(session.generated.mitmproxyDumpPath.endsWith('traffic.dump'));
    assert.ok(session.generated.androidBootstrapPath.endsWith('android-bootstrap.sh'));
    assert.ok(session.generated.windowsBootstrapPath.endsWith('windows-bootstrap.bat'));
    assert.ok(session.generated.iosNotesPath.endsWith('ios-capture-notes.md'));
    assert.ok(session.generated.androidProxySetupPath.endsWith('android-proxy-setup.sh'));
    assert.ok(session.generated.androidClearProxyPath.endsWith('android-clear-proxy.sh'));
    assert.ok(session.generated.windowsProxyNotesPath.endsWith('windows-proxy-notes.md'));
    assert.ok(session.generated.bundleReadmePath.endsWith('README.md'));
    assert.ok(session.generated.captureManifestPath.endsWith('capture-manifest.json'));
    assert.match(session.plan.steps.find((step) => step.id === 'frida-attach')?.command ?? '', /frida-auto\.js/);
    assert.match(session.plan.steps.find((step) => step.id === 'mitmproxy-capture')?.command ?? '', /mitm-addon\.py/);

    const fridaScript = await readFile(session.generated.fridaScriptPath, 'utf8');
    const mitmAddon = await readFile(session.generated.mitmproxyAddonPath, 'utf8');
    const androidBootstrap = await readFile(session.generated.androidBootstrapPath, 'utf8');
    const androidProxySetup = await readFile(session.generated.androidProxySetupPath, 'utf8');
    const androidClearProxy = await readFile(session.generated.androidClearProxyPath, 'utf8');
    const windowsBootstrap = await readFile(session.generated.windowsBootstrapPath, 'utf8');
    const windowsProxyNotes = await readFile(session.generated.windowsProxyNotesPath, 'utf8');
    const iosNotes = await readFile(session.generated.iosNotesPath, 'utf8');
    const bundleReadme = await readFile(session.generated.bundleReadmePath, 'utf8');
    const captureManifest = JSON.parse(await readFile(session.generated.captureManifestPath, 'utf8'));
    assert.match(fridaScript, /omnicrawl/);
    assert.match(fridaScript, /com\.example\.demo/);
    assert.match(mitmAddon, /mitmproxy/);
    assert.match(androidBootstrap, /mitmdump/);
    assert.match(androidBootstrap, /frida/);
    assert.match(androidProxySetup, /adb/);
    assert.match(androidProxySetup, /http_proxy/);
    assert.match(androidClearProxy, /http_proxy :0/);
    assert.match(windowsBootstrap, /frida/);
    assert.match(windowsProxyNotes, /mitmdump/);
    assert.match(iosNotes, /mitm\.it/);
    assert.match(bundleReadme, /OmniCrawl Capture Bundle/);
    assert.match(bundleReadme, /Recommended order:/);
    assert.equal(captureManifest.sessionId, session.id);
    assert.ok(Array.isArray(captureManifest.generatedFiles));
    assert.ok(captureManifest.generatedFiles.some((entry) => entry.key === 'androidProxySetupPath'));
    assert.ok(Array.isArray(captureManifest.operatorChecklist));
    assert.ok(captureManifest.quickStart.androidClearProxy);
    assert.equal(captureManifest.target.bundleId, 'com.example.demo');
    assert.equal(captureManifest.target.fridaTemplateKind, 'generic');

    await sleep(100);
    const stopped = await manager.stop(session.id);
    const storedStopped = await manager.assetStore.readLatestAsset('app-captures', `tool-app-capture-${session.id}`);
    assert.equal(stopped.status, 'stopped');
    assert.equal(storedStopped?.payload?.status, 'stopped');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app capture manager generates platform-specific Frida templates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-app-capture-platform-'));

  try {
    const manager = new AppCaptureManager({ projectRoot: root });

    const androidSession = await manager.start({
      app: {
        platform: 'android',
        bundleId: 'com.example.android',
        frida: {
          enabled: true,
          exec: {
            command: process.execPath,
            args: ['-e', 'setTimeout(() => process.exit(0), 50)'],
          },
        },
      },
      options: {
        toolStatus: {
          frida: { available: true, version: 'test' },
          'frida-ps': { available: true, version: 'test' },
          mitmdump: { available: false, version: null },
          mitmproxy: { available: false, version: null },
        },
      },
    });
    const androidFrida = await readFile(androidSession.generated.fridaScriptPath, 'utf8');
    const androidManifest = JSON.parse(await readFile(androidSession.generated.captureManifestPath, 'utf8'));
    assert.match(androidFrida, /Java\.perform/);
    assert.match(androidFrida, /okhttp3\.CertificatePinner/);
    assert.equal(androidManifest.target.fridaTemplateKind, 'android');

    const iosSession = await manager.start({
      app: {
        platform: 'ios',
        bundleId: 'com.example.ios',
        frida: {
          enabled: true,
          exec: {
            command: process.execPath,
            args: ['-e', 'setTimeout(() => process.exit(0), 50)'],
          },
        },
      },
      options: {
        toolStatus: {
          frida: { available: true, version: 'test' },
          'frida-ps': { available: true, version: 'test' },
          mitmdump: { available: false, version: null },
          mitmproxy: { available: false, version: null },
        },
      },
    });
    const iosFrida = await readFile(iosSession.generated.fridaScriptPath, 'utf8');
    const iosManifest = JSON.parse(await readFile(iosSession.generated.captureManifestPath, 'utf8'));
    assert.match(iosFrida, /ObjC\.available/);
    assert.match(iosFrida, /NSURLSession/);
    assert.equal(iosManifest.target.fridaTemplateKind, 'ios');

    await sleep(100);
    await manager.stop(androidSession.id);
    await manager.stop(iosSession.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app capture helper files are exposed through the server API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-app-capture-api-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const startResponse = await fetch(`${apiBase}/tools/app-capture/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        app: {
          bundleId: 'com.example.demo',
          frida: {
            enabled: true,
            exec: {
              command: process.execPath,
              args: ['-e', 'setTimeout(() => process.exit(0), 100)'],
            },
          },
          mitmproxy: {
            enabled: true,
            exec: {
              command: process.execPath,
              args: ['-e', 'setTimeout(() => process.exit(0), 100)'],
            },
          },
        },
        options: {
          toolStatus: {
            frida: { available: true, version: 'test' },
            'frida-ps': { available: true, version: 'test' },
            mitmdump: { available: true, version: 'test' },
            mitmproxy: { available: true, version: 'test' },
          },
        },
      }),
    });
    assert.equal(startResponse.status, 201);
    const started = await startResponse.json();

    const filesResponse = await fetch(`${apiBase}/tools/app-capture/sessions/${started.item.id}/files`);
    assert.equal(filesResponse.status, 200);
    const filesPayload = await filesResponse.json();
    assert.ok(filesPayload.items.some((entry) => entry.key === 'androidBootstrapPath'));
    assert.ok(filesPayload.items.some((entry) => entry.key === 'fridaScriptPath'));
    assert.ok(filesPayload.items.some((entry) => entry.key === 'captureManifestPath'));
    assert.ok(filesPayload.items.some((entry) => entry.key === 'bundleReadmePath'));

    const fileResponse = await fetch(`${apiBase}/tools/app-capture/sessions/${started.item.id}/files/androidBootstrapPath`);
    assert.equal(fileResponse.status, 200);
    const filePayload = await fileResponse.json();
    assert.match(filePayload.item.content, /mitmdump/);
    assert.match(filePayload.item.content, /frida/);

    const manifestResponse = await fetch(`${apiBase}/tools/app-capture/sessions/${started.item.id}/files/captureManifestPath`);
    assert.equal(manifestResponse.status, 200);
    const manifestPayload = await manifestResponse.json();
    const manifest = JSON.parse(manifestPayload.item.content);
    assert.equal(manifest.sessionId, started.item.id);
    assert.ok(manifest.generatedFiles.some((entry) => entry.key === 'windowsBootstrapPath'));

    const readmeResponse = await fetch(`${apiBase}/tools/app-capture/sessions/${started.item.id}/files/bundleReadmePath`);
    assert.equal(readmeResponse.status, 200);
    const readmePayload = await readmeResponse.json();
    assert.match(readmePayload.item.content, /Recommended order:/);

    const assetResponse = await fetch(`${apiBase}/tools/app-capture/sessions/${started.item.id}/asset`);
    assert.equal(assetResponse.status, 200);
    const assetPayload = await assetResponse.json();
    assert.equal(assetPayload.sessionId, started.item.id);
    assert.equal(assetPayload.assetRef.assetId, `tool-app-capture-${started.item.id}`);
    assert.equal(assetPayload.item.payload.sessionId, started.item.id);

    const assetListResponse = await fetch(`${apiBase}/tools/reverse-assets/app-captures`);
    assert.equal(assetListResponse.status, 200);
    const assetListPayload = await assetListResponse.json();
    assert.ok(assetListPayload.items.some((entry) => entry.assetId === `tool-app-capture-${started.item.id}`));

    const assetItemResponse = await fetch(`${apiBase}/tools/reverse-assets/app-captures/${encodeURIComponent(`tool-app-capture-${started.item.id}`)}`);
    assert.equal(assetItemResponse.status, 200);
    const assetItemPayload = await assetItemResponse.json();
    assert.equal(assetItemPayload.item.payload.target.bundleId, 'com.example.demo');

    await fetch(`${apiBase}/tools/app-capture/sessions/${started.item.id}/stop`, {
      method: 'POST',
    });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
