import { spawnSync } from 'node:child_process';

function probeExecutable(command, args = ['--version']) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    if (result.error) {
      return {
        available: false,
        command,
        error: result.error.message,
        version: null,
      };
    }
    if (result.status !== 0) {
      return {
        available: false,
        command,
        error: (result.stderr || result.stdout || '').trim() || `exit code ${result.status}`,
        version: null,
      };
    }
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    return {
      available: true,
      command,
      error: null,
      version: output.split(/\r?\n/).find(Boolean) ?? null,
    };
  } catch (error) {
    return {
      available: false,
      command,
      error: error?.message ?? String(error),
      version: null,
    };
  }
}

export function getNativeToolStatus() {
  return {
    frida: probeExecutable('frida', ['--version']),
    'frida-ps': probeExecutable('frida-ps', ['--version']),
    mitmdump: probeExecutable('mitmdump', ['--version']),
    mitmproxy: probeExecutable('mitmproxy', ['--version']),
  };
}

function quoteIfNeeded(value) {
  const text = String(value ?? '');
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

export function buildNativeCapturePlan(app = {}, options = {}) {
  const toolStatus = options.toolStatus ?? getNativeToolStatus();
  const prerequisites = [];
  const steps = [];
  const warnings = [];

  if (app.frida?.enabled === true) {
    const fridaCommand = toolStatus.frida.available ? 'frida' : (toolStatus['frida-ps'].available ? 'frida-ps' : 'frida');
    const targetFlag = app.frida.deviceId ? `-D ${quoteIfNeeded(app.frida.deviceId)}` : '-U';
    const targetBundle = app.frida.bundleId ?? app.bundleId ?? null;
    const scriptPath = app.frida.scriptPath ?? null;

    if (!toolStatus.frida.available) {
      prerequisites.push('Install Frida CLI on the worker node before attempting native hook capture.');
    }
    if (!targetBundle) {
      warnings.push('Frida is enabled but no bundleId was provided; attach target selection will remain manual.');
    }
    if (!scriptPath) {
      warnings.push('Frida is enabled but no scriptPath was provided; runtime patching remains operator-supplied.');
    }

    steps.push({
      id: 'frida-attach',
      tool: 'frida',
      enabled: true,
      available: toolStatus.frida.available,
      mode: 'external-advisory',
      description: 'Attach Frida to the target app and load the SSL-pinning / bridge instrumentation script.',
      command: [fridaCommand, targetFlag, targetBundle ? `-f ${quoteIfNeeded(targetBundle)}` : null, scriptPath ? `-l ${quoteIfNeeded(scriptPath)}` : null, '--no-pause']
        .filter(Boolean)
        .join(' '),
    });
  }

  if (app.mitmproxy?.enabled === true) {
    const dumpPath = app.mitmproxy.dumpPath ?? 'traffic.dump';
    const addonPath = app.mitmproxy.addonPath ?? null;
    if (!toolStatus.mitmdump.available) {
      prerequisites.push('Install mitmproxy/mitmdump on the worker node before attempting external traffic capture.');
    }
    steps.push({
      id: 'mitmproxy-capture',
      tool: 'mitmdump',
      enabled: true,
      available: toolStatus.mitmdump.available,
      mode: 'external-advisory',
      description: 'Start mitmproxy capture to collect app traffic and replayable dumps.',
      command: [
        'mitmdump',
        `--mode ${quoteIfNeeded(app.mitmproxy.mode ?? 'regular')}`,
        `-w ${quoteIfNeeded(dumpPath)}`,
        addonPath ? `-s ${quoteIfNeeded(addonPath)}` : null,
      ].filter(Boolean).join(' '),
    });
  }

  if (app.sslPinning?.enabled === true && app.frida?.enabled !== true) {
    warnings.push('SSL pinning is enabled without Frida; interception may still fail until a native bypass script is attached.');
  }

  return {
    kind: 'app-native-plan',
    format: 'external-advisory',
    ready: prerequisites.length === 0,
    toolStatus,
    prerequisites,
    warnings,
    steps,
    protocolHints: {
      protobuf: {
        enabled: app.protobuf?.enabled === true,
        descriptorPaths: Array.isArray(app.protobuf?.descriptorPaths) ? app.protobuf.descriptorPaths : [],
      },
      grpc: {
        enabled: app.grpc?.enabled === true,
        services: app.grpc?.services ?? {},
      },
      websocket: {
        captureBinary: app.websocket?.captureBinary !== false,
      },
    },
  };
}
