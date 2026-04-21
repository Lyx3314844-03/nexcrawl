import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.js';

function createWebSocketAccept(key) {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function encodeWebSocketFrame(payload) {
  const body = Buffer.from(payload, 'utf8');
  if (body.length >= 126) {
    throw new Error('test websocket frame payload too large');
  }
  return Buffer.concat([
    Buffer.from([0x81, body.length]),
    body,
  ]);
}

function decodeWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      throw new Error('test websocket frame payload too large');
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (offset + frameLength > buffer.length) {
      break;
    }

    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + maskLength;
    let payload = buffer.subarray(payloadOffset, payloadOffset + payloadLength);

    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      payload = Buffer.from(payload);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    if (opcode === 0x1) {
      messages.push(payload.toString('utf8'));
    }

    offset += frameLength;
  }

  return {
    messages,
    remaining: buffer.subarray(offset),
  };
}

function encodeVarint(value) {
  let current = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current > 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (current > 0n);
  return Buffer.from(bytes);
}

function encodeProtobufString(fieldNumber, value) {
  const body = Buffer.from(String(value), 'utf8');
  return Buffer.concat([
    encodeVarint((fieldNumber << 3) | 2),
    encodeVarint(body.length),
    body,
  ]);
}

async function createLabFixture() {
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <body>
            <iframe src="/frame"></iframe>
            <script src="/app.js"></script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/ws-page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <body>
            <script src="/ws-app.js"></script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/worker-page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <body>
            <script>
              window.workerReady = navigator.serviceWorker.register('/sw.js')
                .then(async (registration) => {
                  await navigator.serviceWorker.ready;
                  if (registration.active) {
                    registration.active.postMessage({ via: 'page' });
                  }
                  return 'sw-ready';
                });
              window.sharedLabWorker = new SharedWorker('/shared-lab-worker.js');
              window.sharedLabWorker.port.start();
              window.sharedLabWorker.port.postMessage({ via: 'page-shared-worker' });
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/frame') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><body><div id="frame">frame-ready</div></body></html>');
      return;
    }

    if (req.url === '/app.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`
        console.log('lab-ready');
        window.sign = function sign(payload) {
          const marker = payload + '-sig';
          return marker;
        };
        window.signObject = function signObject(payload) {
          const result = {};
          result.sig = payload + '-obj';
          return result.sig;
        };
        window.signSequence = function signSequence(payload) {
          const marker = payload + '-seq';
          const upper = marker.toUpperCase();
          const wrapped = upper + '-done';
          return wrapped;
        };
        window.signNested = function signNested(payload) {
          const marker = payload + '-nested';
          [1].forEach(() => {
            const ignored = payload + '-ignored';
            return ignored;
          });
          return marker;
        };
        window.signBranch = function signBranch(payload) {
          const marker = payload + '-branch';
          if (payload.startsWith('x')) {
            return marker + '-x';
          }
          return marker + '-fallback';
        };
        window.bundleHost = {
          signPayload(payload) {
            const marker = payload + '-bundle';
            return marker;
          },
        };
        window.runAnon = function runAnon(payload) {
          return (function(secret) {
            const marker = secret + '-anon';
            return marker;
          })(payload);
        };
        window.issueSignedRequest = async function issueSignedRequest(payload) {
          const signed = window.sign(payload);
          const response = await fetch('/api/data?via=lab&sig=' + encodeURIComponent(signed));
          return response.text();
        };
        window.loadData = async function loadData() {
          return window.issueSignedRequest('load-data');
        };
        window.loadProtoData = async function loadProtoData() {
          const response = await fetch('/api/proto');
          return response.arrayBuffer().then((buffer) => buffer.byteLength);
        };
        //# sourceMappingURL=/app.js.map
      `);
      return;
    }

    if (req.url === '/app.js.map') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        version: 3,
        file: 'app.js',
        sourceRoot: '',
        sources: ['src/app.ts'],
        names: ['sign', 'issueSignedRequest', 'loadData'],
        sourcesContent: ['export const sign = (payload) => payload + "-sig";'],
        mappings: '',
      }));
      return;
    }

    if (req.url === '/ws-app.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`
        window.wsMessages = [];
        window.openSocket = function openSocket() {
          return new Promise((resolve, reject) => {
            const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
            socket.addEventListener('open', () => {
              window.labSocket = socket;
              socket.send('client-hello');
              resolve('socket-open');
            }, { once: true });
            socket.addEventListener('message', (event) => {
              window.wsMessages.push(event.data);
            });
            socket.addEventListener('error', () => reject(new Error('socket-error')), { once: true });
          });
        };
      `);
      return;
    }

    if (req.url === '/sw.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`
        self.addEventListener('install', (event) => {
          event.waitUntil(fetch('/api/worker-beacon?via=service-worker-install'));
        });
        self.addEventListener('activate', (event) => {
          event.waitUntil(fetch('/api/worker-beacon?via=service-worker-activate'));
        });
        self.addEventListener('message', (event) => {
          fetch('/api/worker-beacon?via=service-worker-message');
        });
        //# sourceMappingURL=/sw.js.map
      `);
      return;
    }

    if (req.url === '/sw.js.map') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        version: 3,
        file: 'sw.js',
        sourceRoot: '',
        sources: ['src/sw.ts'],
        names: ['install', 'activate'],
        sourcesContent: ['self.addEventListener("install", () => fetch("/api/worker-beacon?via=service-worker-install"));'],
        mappings: '',
      }));
      return;
    }

    if (req.url === '/shared-lab-worker.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`
        onconnect = (event) => {
          const port = event.ports[0];
          fetch('/api/worker-beacon?via=shared-worker-connect');
          port.onmessage = () => {
            fetch('/api/worker-beacon?via=shared-worker-message');
          };
          port.start();
        };
        //# sourceMappingURL=/shared-lab-worker.js.map
      `);
      return;
    }

    if (req.url === '/shared-lab-worker.js.map') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        version: 3,
        file: 'shared-lab-worker.js',
        sourceRoot: '',
        sources: ['src/shared-lab-worker.ts'],
        names: ['onconnect'],
        sourcesContent: ['onconnect = (event) => fetch("/api/worker-beacon?via=shared-worker-connect");'],
        mappings: '',
      }));
      return;
    }

    if (req.url?.startsWith('/api/data')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('data-ok');
      return;
    }

    if (req.url === '/api/proto') {
      const body = Buffer.concat([
        encodeProtobufString(1, 'hello-lab'),
      ]);
      res.setHeader('Content-Type', 'application/x-protobuf');
      res.end(body);
      return;
    }

    if (req.url?.startsWith('/api/worker-beacon')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        ok: true,
        via: new URL(req.url, 'http://127.0.0.1').searchParams.get('via'),
      }));
      return;
    }

    res.statusCode = 404;
    res.end('missing');
  });

  server.on('upgrade', (req, socket) => {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
      '\r\n',
    ].join('\r\n'));
    sockets.add(socket);
    socket.write(encodeWebSocketFrame('server-ready'));

    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const decoded = decodeWebSocketFrames(pending);
      pending = decoded.remaining;
      for (const message of decoded.messages) {
        socket.write(encodeWebSocketFrame(`echo:${message}`));
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.on('error', () => {
      sockets.delete(socket);
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
      await once(server, 'close');
    },
  };
}

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

test('reverse lab exposes persistent page debugging surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-reverse-lab-'));
  const fixture = await createLabFixture();
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const newPageResponse = await fetch(`${apiBase}/reverse/lab/pages/new`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/page`,
      }),
    });
    assert.equal(newPageResponse.status, 200);
    const page = await newPageResponse.json();
    const pageId = page.id;
    assert.ok(pageId);
    assert.equal(typeof page.backend, 'string');
    assert.equal(page.requestedEngine, 'auto');

    const pagesResponse = await fetch(`${apiBase}/reverse/lab/pages`);
    const pages = await pagesResponse.json();
    assert.equal(pages.selectedPageId, pageId);
    assert.equal(pages.pages.length, 1);
    assert.equal(pages.pages[0].backend, page.backend);
    assert.equal(pages.pages[0].backendFamily, page.backendFamily);
    assert.equal(pages.pages[0].requestedEngine, page.requestedEngine);

    const stealthSurfaceResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: `(async () => {
          const permission = await navigator.permissions.query({ name: 'notifications' });
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl');
          return {
            webdriver: navigator.webdriver,
            vendor: navigator.vendor,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory,
            userAgent: navigator.userAgent,
            hasUserAgentData: !!navigator.userAgentData,
            hasChromeRuntime: !!window.chrome?.runtime,
            permission: permission.state,
            webglVendor: gl ? gl.getParameter(37445) : null,
          };
        })()`,
      }),
    });
    assert.equal(stealthSurfaceResponse.status, 200);
    const stealthSurface = await stealthSurfaceResponse.json();
    assert.equal(stealthSurface.result.webdriver, false);
    assert.equal(stealthSurface.result.vendor, 'Google Inc.');
    assert.equal(stealthSurface.result.hardwareConcurrency, 8);
    assert.equal(stealthSurface.result.deviceMemory, 8);
    assert.equal(stealthSurface.result.hasUserAgentData, true);
    assert.equal(stealthSurface.result.hasChromeRuntime, true);
    assert.equal(stealthSurface.result.permission, 'default');
    assert.match(stealthSurface.result.userAgent, /Chrome\/123/);
    assert.match(stealthSurface.result.webglVendor ?? '', /Google Inc/);

    const framesResponse = await fetch(`${apiBase}/reverse/lab/frames?pageId=${pageId}`);
    const frames = await framesResponse.json();
    assert.ok(frames.frames.length >= 2);
    const childFrame = frames.frames.find((item) => item.isMain === false);
    assert.ok(childFrame);

    const selectFrameResponse = await fetch(`${apiBase}/reverse/lab/frames/select`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        frameId: childFrame.frameId,
      }),
    });
    assert.equal(selectFrameResponse.status, 200);

    const frameEvalResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: 'document.querySelector("#frame").textContent',
      }),
    });
    const frameEval = await frameEvalResponse.json();
    assert.equal(frameEval.result, 'frame-ready');

    const mainFrame = frames.frames.find((item) => item.isMain === true);
    const reselectMainResponse = await fetch(`${apiBase}/reverse/lab/frames/select`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        frameId: mainFrame.frameId,
      }),
    });
    assert.equal(reselectMainResponse.status, 200);

    const scripts = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/scripts?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.some((item) => item.url?.endsWith('/app.js')) ? json : null;
    });
    assert.ok(scripts);
    const appScript = scripts.items.find((item) => item.url?.endsWith('/app.js'));
    assert.ok(appScript);
    assert.equal(appScript.sourceMapLoaded, true);
    assert.match(appScript.sourceMapResolvedUrl ?? '', /\/app\.js\.map$/);
    assert.equal(appScript.sourceMap?.sourceCount, 1);

    const sourceResponse = await fetch(`${apiBase}/reverse/lab/scripts/${appScript.scriptId}/source?pageId=${pageId}`);
    assert.equal(sourceResponse.status, 200);
    const source = await sourceResponse.json();
    assert.match(source.source, /window\.sign/);
    assert.equal(source.sourceMap?.file, 'app.js');
    assert.ok(source.sourceMap?.rawText?.includes('"sources":["src/app.ts"]'));

    const searchResponse = await fetch(`${apiBase}/reverse/lab/scripts/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        query: 'window.sign',
      }),
    });
    const search = await searchResponse.json();
    assert.ok(search.count >= 1);
    const signMarkerLocation = search.items.find((item) => item.snippet.includes("const marker = payload + '-sig';"));
    assert.ok(signMarkerLocation);

    const breakpointResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        query: "const marker = payload + '-sig';",
      }),
    });
    const breakpoint = await breakpointResponse.json();
    assert.equal(breakpoint.type, 'text');

    const triggerResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: "setTimeout(() => window.sign('demo'), 0); 'scheduled';",
      }),
    });
    assert.equal(triggerResponse.status, 200);

    const paused = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/paused?pageId=${pageId}`);
      const json = await response.json();
      return json?.callFrames?.length ? json : null;
    });
    assert.ok(paused);
    assert.ok(paused.callFrames[0].functionName.includes('sign'));
    assert.match(paused.callFrames[0].sourceContext?.snippet ?? '', /const marker = payload \+ '-sig';/);

    const pausedEvalResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        context: 'paused',
        expression: 'payload',
      }),
    });
    const pausedEval = await pausedEvalResponse.json();
    assert.equal(pausedEval.result, 'demo');

    const resumeResponse = await fetch(`${apiBase}/reverse/lab/execution/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pageId }),
    });
    assert.equal(resumeResponse.status, 200);

    const removeBreakpointResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        breakpointId: breakpoint.id,
      }),
    });
    assert.equal(removeBreakpointResponse.status, 200);

    const traceTextResponse = await fetch(`${apiBase}/reverse/lab/trace-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        query: "const marker = payload + '-sig';",
        logExpression: 'payload',
      }),
    });
    assert.equal(traceTextResponse.status, 200);
    const traceText = await traceTextResponse.json();
    assert.equal(traceText.mode, 'logpoint');
    assert.ok(['wrapper-text', 'source-patch', 'text'].includes(traceText.type));
    assert.equal(traceText.backend, page.backend);
    assert.equal(traceText.backendFamily, page.backendFamily);
    assert.equal(traceText.requestedEngine, page.requestedEngine);

    const triggerTraceTextResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: "window.issueSignedRequest('trace-text'); 'ok';",
      }),
    });
    assert.equal(triggerTraceTextResponse.status, 200);

    const traceTextEvent = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/traces?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.find((item) => item.traceId === traceText.id && item.values?.includes('trace-text')) ?? null;
    });
    assert.ok(traceTextEvent);
    assert.ok(['wrapper', 'source-patch', 'heuristic'].includes(traceTextEvent.traceStrategy));
    assert.deepEqual(traceTextEvent.arguments, ['trace-text']);
    assert.equal(traceTextEvent.returnValue, 'trace-text-sig');
    if (traceTextEvent.traceStrategy === 'heuristic') {
      assert.equal(traceTextEvent.returnExpression, 'marker');
      assert.match(traceTextEvent.returnSourceContext?.snippet ?? '', /return marker;/);
      assert.ok(Array.isArray(traceTextEvent.returnCandidates));
      assert.ok(traceTextEvent.returnCandidates.some((candidate) => candidate.expression === 'marker'));
      assert.equal(typeof traceTextEvent.selectedReturnLine, 'number');
    } else if (traceTextEvent.traceStrategy === 'source-patch') {
      assert.equal(traceTextEvent.returnExpression, 'marker');
    } else {
      assert.equal(traceTextEvent.returnExpression, '[runtime-wrapper]');
    }
    assert.ok(Array.isArray(traceTextEvent.executionPath));
    assert.ok(traceTextEvent.executionPath.length >= 1);
    if (traceTextEvent.traceStrategy === 'heuristic') {
      assert.equal(traceTextEvent.callSite?.functionName, 'issueSignedRequest');
      assert.match(traceTextEvent.callSiteSourceContext?.snippet ?? '', /window\.sign\(payload\)/);
    }

    const wrapperTraceResponse = await fetch(`${apiBase}/reverse/lab/trace-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        query: "const marker = payload + '-sig';",
        logExpression: 'payload',
        strategy: 'wrapper',
      }),
    });
    assert.equal(wrapperTraceResponse.status, 200);
    const wrapperTrace = await wrapperTraceResponse.json();
    assert.equal(wrapperTrace.type, 'wrapper-text');
    assert.equal(wrapperTrace.strategy, 'wrapper');

    const triggerWrapperTraceResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: "window.sign('wrapper-trace')",
      }),
    });
    assert.equal(triggerWrapperTraceResponse.status, 200);

    const wrapperTraceEvent = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/traces?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.find((item) => item.traceId === wrapperTrace.id && item.values?.includes('wrapper-trace')) ?? null;
    });
    assert.ok(wrapperTraceEvent);
    assert.equal(wrapperTraceEvent.traceStrategy, 'wrapper');
    assert.deepEqual(wrapperTraceEvent.arguments, ['wrapper-trace']);
    assert.equal(wrapperTraceEvent.returnValue, 'wrapper-trace-sig');
    assert.equal(wrapperTraceEvent.returnExpression, '[runtime-wrapper]');

    const removeWrapperTraceResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        breakpointId: wrapperTrace.id,
      }),
    });
    assert.equal(removeWrapperTraceResponse.status, 200);

    const traceObjectResponse = await fetch(`${apiBase}/reverse/lab/trace-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        query: "result.sig = payload + '-obj';",
        logExpression: 'payload',
        strategy: 'heuristic',
      }),
    });
    assert.equal(traceObjectResponse.status, 200);
    const traceObject = await traceObjectResponse.json();

    const triggerTraceObjectResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: "window.signObject('object-trace')",
      }),
    });
    assert.equal(triggerTraceObjectResponse.status, 200);

    const traceObjectEvent = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/traces?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.find((item) => item.traceId === traceObject.id && item.values?.includes('object-trace')) ?? null;
    });
    assert.ok(traceObjectEvent);
    assert.deepEqual(traceObjectEvent.arguments, ['object-trace']);
    assert.equal(traceObjectEvent.returnExpression, 'result.sig');
    assert.equal(traceObjectEvent.returnValue, 'object-trace-obj');

    const traceSequenceResponse = await fetch(`${apiBase}/reverse/lab/trace-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        query: "const marker = payload + '-seq';",
        logExpression: 'payload',
        strategy: 'heuristic',
      }),
    });
    assert.equal(traceSequenceResponse.status, 200);
    const traceSequence = await traceSequenceResponse.json();

    const triggerTraceSequenceResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: "window.signSequence('multi-step')",
      }),
    });
    assert.equal(triggerTraceSequenceResponse.status, 200);

    const traceSequenceEvent = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/traces?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.find((item) => item.traceId === traceSequence.id && item.values?.includes('multi-step')) ?? null;
    });
    assert.ok(traceSequenceEvent);
    assert.deepEqual(traceSequenceEvent.arguments, ['multi-step']);
    assert.equal(traceSequenceEvent.returnExpression, 'wrapped');
    assert.equal(traceSequenceEvent.returnValue, 'MULTI-STEP-SEQ-done');
    assert.ok(traceSequenceEvent.executionPath.length >= 2);
    assert.ok(traceSequenceEvent.stepsTaken >= 1);
    assert.match(traceSequenceEvent.returnSourceContext?.snippet ?? '', /return wrapped;/);

    const traceNestedResponse = await fetch(`${apiBase}/reverse/lab/trace-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        query: "const marker = payload + '-nested';",
        logExpression: 'payload',
        strategy: 'heuristic',
      }),
    });
    assert.equal(traceNestedResponse.status, 200);
    const traceNested = await traceNestedResponse.json();

    const triggerTraceNestedResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: "window.signNested('nested-trace')",
      }),
    });
    assert.equal(triggerTraceNestedResponse.status, 200);

    const traceNestedEvent = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/traces?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.find((item) => item.traceId === traceNested.id && item.values?.includes('nested-trace')) ?? null;
    });
    assert.ok(traceNestedEvent);
    assert.deepEqual(traceNestedEvent.arguments, ['nested-trace']);
    assert.equal(traceNestedEvent.returnExpression, 'marker');
    assert.equal(traceNestedEvent.returnValue, 'nested-trace-nested');
    assert.match(traceNestedEvent.returnSourceContext?.snippet ?? '', /return marker;/);

    const traceBranchResponse = await fetch(`${apiBase}/reverse/lab/trace-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        query: "const marker = payload + '-branch';",
        logExpression: 'payload',
        strategy: 'heuristic',
      }),
    });
    assert.equal(traceBranchResponse.status, 200);
    const traceBranch = await traceBranchResponse.json();

    const triggerTraceBranchResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: "window.signBranch('alpha')",
      }),
    });
    assert.equal(triggerTraceBranchResponse.status, 200);

    const traceBranchEvent = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/traces?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.find((item) => item.traceId === traceBranch.id && item.values?.includes('alpha')) ?? null;
    });
    assert.ok(traceBranchEvent);
    assert.deepEqual(traceBranchEvent.arguments, ['alpha']);
    assert.equal(traceBranchEvent.returnExpression, "marker + '-fallback'");
    assert.equal(traceBranchEvent.returnValue, 'alpha-branch-fallback');
    assert.ok(traceBranchEvent.returnCandidates.length >= 2);
    assert.ok(traceBranchEvent.returnCandidates.some((candidate) => candidate.expression === "marker + '-x'"));
    assert.ok(traceBranchEvent.returnCandidates.some((candidate) => candidate.expression === "marker + '-fallback'"));
    assert.equal(traceBranchEvent.selectedReturnLine, traceBranchEvent.returnCandidates.find((candidate) => candidate.expression === "marker + '-fallback'")?.lineNumber ?? null);
    assert.match(traceBranchEvent.returnSourceContext?.snippet ?? '', /return marker \+ '-fallback';/);

    const removeTraceBranchBreakpointResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        breakpointId: traceBranch.id,
      }),
    });
    assert.equal(removeTraceBranchBreakpointResponse.status, 200);

    const traceBranchXResponse = await fetch(`${apiBase}/reverse/lab/trace-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        query: "const marker = payload + '-branch';",
        logExpression: 'payload',
        strategy: 'heuristic',
      }),
    });
    assert.equal(traceBranchXResponse.status, 200);
    const traceBranchX = await traceBranchXResponse.json();

    const triggerTraceBranchXResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: "window.signBranch('xray')",
      }),
    });
    assert.equal(triggerTraceBranchXResponse.status, 200);

    const traceBranchXEvent = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/traces?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.find((item) => item.traceId === traceBranchX.id && item.values?.includes('xray')) ?? null;
    });
    assert.ok(traceBranchXEvent);
    assert.deepEqual(traceBranchXEvent.arguments, ['xray']);
    assert.equal(traceBranchXEvent.returnExpression, "marker + '-x'");
    assert.equal(traceBranchXEvent.returnValue, 'xray-branch-x');
    assert.ok(traceBranchXEvent.returnCandidates.length >= 2);
    assert.equal(traceBranchXEvent.selectedReturnLine, traceBranchXEvent.returnCandidates.find((candidate) => candidate.expression === "marker + '-x'")?.lineNumber ?? null);
    assert.match(traceBranchXEvent.returnSourceContext?.snippet ?? '', /return marker \+ '-x';/);

    const wrapperAutoObjectTraceResponse = await fetch(`${apiBase}/reverse/lab/trace-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        query: "const marker = payload + '-bundle';",
        logExpression: 'payload',
        strategy: 'wrapper',
      }),
    });
    assert.equal(wrapperAutoObjectTraceResponse.status, 200);
    const wrapperAutoObjectTrace = await wrapperAutoObjectTraceResponse.json();
    assert.equal(wrapperAutoObjectTrace.type, 'wrapper-text');
    assert.equal(wrapperAutoObjectTrace.targetExpression, 'window.bundleHost.signPayload');

    const triggerWrapperAutoObjectTraceResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: "window.bundleHost.signPayload('bundle-auto')",
      }),
    });
    assert.equal(triggerWrapperAutoObjectTraceResponse.status, 200);

    const wrapperAutoObjectTraceEvent = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/traces?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.find((item) => item.traceId === wrapperAutoObjectTrace.id && item.values?.includes('bundle-auto')) ?? null;
    });
    assert.ok(wrapperAutoObjectTraceEvent);
    assert.equal(wrapperAutoObjectTraceEvent.traceStrategy, 'wrapper');
    assert.equal(wrapperAutoObjectTraceEvent.returnValue, 'bundle-auto-bundle');

    const wrapperExplicitTraceResponse = await fetch(`${apiBase}/reverse/lab/trace-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        query: "const marker = payload + '-bundle';",
        logExpression: 'payload',
        strategy: 'wrapper',
        targetExpression: 'window.bundleHost.signPayload',
      }),
    });
    assert.equal(wrapperExplicitTraceResponse.status, 200);
    const wrapperExplicitTrace = await wrapperExplicitTraceResponse.json();
    assert.equal(wrapperExplicitTrace.type, 'wrapper-text');
    assert.equal(wrapperExplicitTrace.targetExpression, 'window.bundleHost.signPayload');

    const triggerWrapperExplicitTraceResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: "window.bundleHost.signPayload('bundle-trace')",
      }),
    });
    assert.equal(triggerWrapperExplicitTraceResponse.status, 200);

    const wrapperExplicitTraceEvent = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/traces?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.find((item) => item.traceId === wrapperExplicitTrace.id && item.values?.includes('bundle-trace')) ?? null;
    });
    assert.ok(wrapperExplicitTraceEvent);
    assert.equal(wrapperExplicitTraceEvent.traceStrategy, 'wrapper');
    assert.deepEqual(wrapperExplicitTraceEvent.arguments, ['bundle-trace']);
    assert.equal(wrapperExplicitTraceEvent.returnValue, 'bundle-trace-bundle');

    const sourcePatchTraceResponse = await fetch(`${apiBase}/reverse/lab/trace-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        query: "const marker = secret + '-anon';",
        logExpression: 'secret',
        strategy: 'source-patch',
      }),
    });
    assert.equal(sourcePatchTraceResponse.status, 200);
    const sourcePatchTrace = await sourcePatchTraceResponse.json();
    assert.equal(sourcePatchTrace.type, 'source-patch');
    assert.equal(sourcePatchTrace.strategy, 'source-patch');

    const triggerSourcePatchTraceResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: "window.runAnon('anon-trace')",
      }),
    });
    assert.equal(triggerSourcePatchTraceResponse.status, 200);

    const sourcePatchTraceEvent = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/traces?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.find((item) => item.traceId === sourcePatchTrace.id && item.values?.includes('anon-trace')) ?? null;
    });
    assert.ok(sourcePatchTraceEvent);
    assert.equal(sourcePatchTraceEvent.traceStrategy, 'source-patch');
    assert.deepEqual(sourcePatchTraceEvent.arguments, ['anon-trace']);
    assert.equal(sourcePatchTraceEvent.returnValue, 'anon-trace-anon');
    assert.equal(sourcePatchTraceEvent.returnExpression, 'marker');

    const removeTraceTextBreakpointResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        breakpointId: traceText.id,
      }),
    });
    assert.equal(removeTraceTextBreakpointResponse.status, 200);

    const removeTraceObjectBreakpointResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        breakpointId: traceObject.id,
      }),
    });
    assert.equal(removeTraceObjectBreakpointResponse.status, 200);

    const removeTraceSequenceBreakpointResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        breakpointId: traceSequence.id,
      }),
    });
    assert.equal(removeTraceSequenceBreakpointResponse.status, 200);

    const removeTraceNestedBreakpointResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        breakpointId: traceNested.id,
      }),
    });
    assert.equal(removeTraceNestedBreakpointResponse.status, 200);

    const removeTraceBranchXBreakpointResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        breakpointId: traceBranchX.id,
      }),
    });
    assert.equal(removeTraceBranchXBreakpointResponse.status, 200);

    const removeWrapperAutoObjectTraceResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        breakpointId: wrapperAutoObjectTrace.id,
      }),
    });
    assert.equal(removeWrapperAutoObjectTraceResponse.status, 200);

    const removeWrapperExplicitTraceResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        breakpointId: wrapperExplicitTrace.id,
      }),
    });
    assert.equal(removeWrapperExplicitTraceResponse.status, 200);

    const removeSourcePatchTraceResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        breakpointId: sourcePatchTrace.id,
      }),
    });
    assert.equal(removeSourcePatchTraceResponse.status, 200);

    const locationPageResponse = await fetch(`${apiBase}/reverse/lab/pages/new`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/page`,
        setSelected: false,
      }),
    });
    assert.equal(locationPageResponse.status, 200);
    const locationPage = await locationPageResponse.json();
    const locationPageId = locationPage.id;

    const locationScripts = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/scripts?pageId=${locationPageId}`);
      const json = await response.json();
      return json.items?.some((item) => item.url?.endsWith('/app.js')) ? json : null;
    });
    assert.ok(locationScripts);
    const locationAppScript = locationScripts.items.find((item) => item.url?.endsWith('/app.js'));
    assert.ok(locationAppScript);

    const locationSearchResponse = await fetch(`${apiBase}/reverse/lab/scripts/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId: locationPageId,
        query: "const marker = payload + '-sig';",
      }),
    });
    const locationSearch = await locationSearchResponse.json();
    const locationMarker = locationSearch.items.find((item) => item.snippet.includes("const marker = payload + '-sig';"));
    assert.ok(locationMarker);

    const locationBreakpointResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/location`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId: locationPageId,
        url: locationAppScript.url,
        lineNumber: locationMarker.lineNumber,
        columnNumber: locationMarker.columnNumber,
      }),
    });
    assert.equal(locationBreakpointResponse.status, 200);
    const locationBreakpoint = await locationBreakpointResponse.json();
    assert.equal(locationBreakpoint.type, 'location');

    const triggerLocationBreakpointResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId: locationPageId,
        expression: "setTimeout(() => window.sign('line-breakpoint'), 0); 'scheduled';",
      }),
    });
    assert.equal(triggerLocationBreakpointResponse.status, 200);

    const locationPaused = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/paused?pageId=${locationPageId}`);
      const json = await response.json();
      return json?.hitBreakpoints?.includes(locationBreakpoint.id) ? json : null;
    });
    assert.ok(locationPaused);

    const locationPausedEvalResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId: locationPageId,
        context: 'paused',
        expression: 'payload',
      }),
    });
    const locationPausedEval = await locationPausedEvalResponse.json();
    assert.equal(locationPausedEval.result, 'line-breakpoint');

    const resumeLocationBreakpointResponse = await fetch(`${apiBase}/reverse/lab/execution/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pageId: locationPageId }),
    });
    assert.equal(resumeLocationBreakpointResponse.status, 200);

    const removeLocationBreakpointResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId: locationPageId,
        breakpointId: locationBreakpoint.id,
      }),
    });
    assert.equal(removeLocationBreakpointResponse.status, 200);

    const conditionalLogpointResponse = await fetch(`${apiBase}/reverse/lab/breakpoints/location`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId: locationPageId,
        url: locationAppScript.url,
        lineNumber: locationMarker.lineNumber,
        columnNumber: locationMarker.columnNumber,
        mode: 'logpoint',
        condition: "payload === 'trace-hit'",
        logExpression: 'payload',
        autoResume: true,
      }),
    });
    assert.equal(conditionalLogpointResponse.status, 200);
    const conditionalLogpoint = await conditionalLogpointResponse.json();

    const conditionalLogpointTriggerResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId: locationPageId,
        expression: "window.sign('skip'); window.sign('trace-hit'); 'done';",
      }),
    });
    assert.equal(conditionalLogpointTriggerResponse.status, 200);

    const conditionalLogpointEvent = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/traces?pageId=${locationPageId}`);
      const json = await response.json();
      return json.items?.find((item) => item.traceId === conditionalLogpoint.id && item.values?.includes('trace-hit')) ?? null;
    });
    assert.ok(conditionalLogpointEvent);
    assert.deepEqual(conditionalLogpointEvent.arguments, ['trace-hit']);

    const traceResponse = await fetch(`${apiBase}/reverse/lab/trace-function`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: 'window.loadData',
      }),
    });
    assert.equal(traceResponse.status, 200);

    const loadDataResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: "loadData(); 'ok';",
      }),
    });
    assert.equal(loadDataResponse.status, 200);

    const traces = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/traces?pageId=${pageId}`);
      const json = await response.json();
      return json.count >= 1 ? json : null;
    });
    assert.ok(traces);

    const requests = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/network?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.some((item) => item.url.includes('/api/data')) ? json : null;
    });
    assert.ok(requests);
    const request = requests.items.find((item) => item.url.includes('/api/data'));
    assert.ok(request);
    assert.equal(request.responseBodyCaptured, true);
    assert.equal(request.responseBodyPreview, 'data-ok');

    const loadProtoResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: 'window.loadProtoData()',
      }),
    });
    assert.equal(loadProtoResponse.status, 200);
    const loadProto = await loadProtoResponse.json();
    assert.ok(loadProto.result > 0);

    const protoRequest = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/network?pageId=${pageId}`);
      const json = await response.json();
      return json.items?.find((item) => item.url.endsWith('/api/proto')) ?? null;
    });
    assert.ok(protoRequest);
    assert.equal(protoRequest.responseBodyCaptured, true);
    assert.equal(protoRequest.responseBodyBase64Encoded, true);

    const decodeProtoResponse = await fetch(`${apiBase}/reverse/lab/network/${protoRequest.requestId}/decode`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        protocol: 'protobuf',
      }),
    });
    assert.equal(decodeProtoResponse.status, 200);
    const decodedProto = await decodeProtoResponse.json();
    assert.equal(decodedProto.protocol, 'protobuf');
    assert.equal(decodedProto.decoded.kind, 'protobuf-analysis');
    assert.equal(decodedProto.decoded.decoded.fields[0].value, 'hello-lab');

    const initiatorResponse = await fetch(`${apiBase}/reverse/lab/network/${request.requestId}/initiator?pageId=${pageId}`);
    assert.equal(initiatorResponse.status, 200);
    const initiator = await initiatorResponse.json();
    assert.ok(initiator.initiator);

    const injectionResponse = await fetch(`${apiBase}/reverse/lab/inject-before-load`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        id: 'custom-injection',
        script: "window.injectedBeforeLoad = 'ok';",
      }),
    });
    assert.equal(injectionResponse.status, 200);

    const injectionsResponse = await fetch(`${apiBase}/reverse/lab/injections?pageId=${pageId}`);
    assert.equal(injectionsResponse.status, 200);
    const injections = await injectionsResponse.json();
    assert.ok(injections.items.some((item) => item.id === 'custom-injection'));

    const reloadResponse = await fetch(`${apiBase}/reverse/lab/navigate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        action: 'reload',
      }),
    });
    assert.equal(reloadResponse.status, 200);

    const injectedValueResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: 'window.injectedBeforeLoad',
      }),
    });
    const injectedValue = await injectedValueResponse.json();
    assert.equal(injectedValue.result, 'ok');

    const removeInjectionResponse = await fetch(`${apiBase}/reverse/lab/injections/remove`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        injectionId: 'custom-injection',
      }),
    });
    assert.equal(removeInjectionResponse.status, 200);
    const removedInjections = await removeInjectionResponse.json();
    assert.ok(removedInjections.items.every((item) => item.id !== 'custom-injection'));

    const reloadWithoutInjectionResponse = await fetch(`${apiBase}/reverse/lab/navigate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        action: 'reload',
      }),
    });
    assert.equal(reloadWithoutInjectionResponse.status, 200);

    const missingInjectedValueResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
        expression: 'window.injectedBeforeLoad ?? null',
      }),
    });
    const missingInjectedValue = await missingInjectedValueResponse.json();
    assert.equal(missingInjectedValue.result, null);

    const consoleResponse = await fetch(`${apiBase}/reverse/lab/console?pageId=${pageId}`);
    assert.equal(consoleResponse.status, 200);
    const consoleMessages = await consoleResponse.json();
    assert.ok(consoleMessages.items.some((item) => item.text.includes('lab-ready')));

    const screenshotResponse = await fetch(`${apiBase}/reverse/lab/screenshot`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId,
      }),
    });
    assert.equal(screenshotResponse.status, 200);
    const screenshot = await screenshotResponse.json();
    assert.ok(screenshot.bytes > 0);

    const workflowResponse = await fetch(`${apiBase}/reverse/lab/workflow/trace-request-initiator`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/page`,
        searchQuery: 'window.sign',
        traceQuery: "const marker = payload + '-sig';",
        traceLogExpression: 'payload',
        actionExpression: "window.issueSignedRequest('workflow'); 'workflow-triggered';",
        requestPattern: '/api/data?via=lab&sig=',
      }),
    });
    assert.equal(workflowResponse.status, 200);
    const workflow = await workflowResponse.json();
    assert.ok(workflow.page.id);
    assert.ok(workflow.search.count >= 1);
    assert.equal(workflow.action.result, 'workflow-triggered');
    assert.deepEqual(workflow.traceEvent.arguments, ['workflow']);
    assert.equal(workflow.traceEvent.returnValue, 'workflow-sig');
    assert.match(workflow.request.url, /sig=workflow-sig/);
    assert.ok(workflow.initiator);

    const wsPageResponse = await fetch(`${apiBase}/reverse/lab/pages/new`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/ws-page`,
        setSelected: false,
      }),
    });
    assert.equal(wsPageResponse.status, 200);
    const wsPage = await wsPageResponse.json();
    const wsPageId = wsPage.id;

    const openSocketResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId: wsPageId,
        expression: 'window.openSocket()',
      }),
    });
    assert.equal(openSocketResponse.status, 200);
    const openSocket = await openSocketResponse.json();
    assert.equal(openSocket.result, 'socket-open');

    const websockets = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/websockets?pageId=${wsPageId}`);
      const json = await response.json();
      const readyConnection = json.items?.find((item) =>
        item.messages?.some((message) => message.payload === 'server-ready')
        && item.messages?.some((message) => message.payload === 'echo:client-hello'));
      return readyConnection ? { ...json, readyConnection } : null;
    });
    assert.ok(websockets);
    assert.equal(websockets.count, 1);
    assert.match(websockets.readyConnection.url, /\/ws$/);
    assert.ok(websockets.readyConnection.messages.some((message) => message.direction === 'sent' && message.payload === 'client-hello'));
    assert.ok(websockets.readyConnection.messages.some((message) => message.direction === 'received' && message.payload === 'server-ready'));
    assert.ok(websockets.readyConnection.messages.some((message) => message.direction === 'received' && message.payload === 'echo:client-hello'));

    const websocketDetailResponse = await fetch(`${apiBase}/reverse/lab/websockets?pageId=${wsPageId}&connectionId=${websockets.readyConnection.connectionId}`);
    assert.equal(websocketDetailResponse.status, 200);
    const websocketDetail = await websocketDetailResponse.json();
    assert.equal(websocketDetail.connectionId, websockets.readyConnection.connectionId);
    assert.ok(websocketDetail.messages.length >= 3);

    const wsMessagesResponse = await fetch(`${apiBase}/reverse/lab/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pageId: wsPageId,
        expression: 'window.wsMessages.slice()',
      }),
    });
    assert.equal(wsMessagesResponse.status, 200);
    const wsMessages = await wsMessagesResponse.json();
    assert.deepEqual(wsMessages.result, ['server-ready', 'echo:client-hello']);
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('reverse lab auto-attaches shared and service worker targets for script and network capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-reverse-lab-workers-'));
  const fixture = await createLabFixture();
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const newPageResponse = await fetch(`${apiBase}/reverse/lab/pages/new`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: `${fixture.baseUrl}/worker-page`,
      }),
    });
    assert.equal(newPageResponse.status, 200);
    const page = await newPageResponse.json();
    const pageId = page.id;

    const scripts = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/scripts?pageId=${pageId}`);
      const json = await response.json();
      const hasServiceWorker = json.items?.some((item) => item.targetType === 'service_worker' && /\/sw\.js$/.test(item.url ?? ''));
      const hasSharedWorker = json.items?.some((item) => item.targetType === 'shared_worker' && /\/shared-lab-worker\.js$/.test(item.url ?? ''));
      return hasServiceWorker && hasSharedWorker ? json : null;
    }, { timeoutMs: 10000, intervalMs: 150 });
    assert.ok(scripts);

    const serviceWorkerScript = scripts.items.find((item) => item.targetType === 'service_worker');
    const sharedWorkerScript = scripts.items.find((item) => item.targetType === 'shared_worker');
    assert.ok(serviceWorkerScript);
    assert.ok(sharedWorkerScript);
    assert.equal(serviceWorkerScript.sourceMapLoaded, true);
    assert.equal(sharedWorkerScript.sourceMapLoaded, true);

    const network = await waitFor(async () => {
      const response = await fetch(`${apiBase}/reverse/lab/network?pageId=${pageId}`);
      const json = await response.json();
      const hasServiceWorkerBeacon = json.items?.some((item) => /service-worker-/.test(item.url ?? '') || /service-worker-/.test(item.responseBody ?? ''));
      const hasSharedWorkerBeacon = json.items?.some((item) => /shared-worker-/.test(item.url ?? '') || /shared-worker-/.test(item.responseBody ?? ''));
      return hasServiceWorkerBeacon && hasSharedWorkerBeacon ? json : null;
    }, { timeoutMs: 10000, intervalMs: 150 });
    assert.ok(network);
    assert.ok(network.items.some((item) => item.targetType === 'service_worker'));
    assert.ok(network.items.some((item) => item.targetType === 'shared_worker'));
  } finally {
    await runtime.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
