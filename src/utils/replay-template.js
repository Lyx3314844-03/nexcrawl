const REPLAY_TEMPLATE_PATTERN = /\{\{\s*(?:replay\.)?([a-zA-Z0-9_.-]+)\s*\}\}/g;
const REPLAY_TEMPLATE_DETECT_PATTERN = /\{\{\s*(?:replay\.)?[a-zA-Z0-9_.-]+\s*\}\}/;

export function readObjectPath(input, path) {
  if (!path) {
    return input;
  }

  return String(path)
    .split('.')
    .filter(Boolean)
    .reduce((cursor, part) => {
      if (cursor === null || cursor === undefined) {
        return undefined;
      }

      if (/^\d+$/.test(part)) {
        return cursor[Number(part)];
      }

      return cursor[part];
    }, input);
}

export function lookupReplayStateValue(state, keyPath) {
  return readObjectPath(state, keyPath);
}

export function interpolateReplayString(value, replayState = {}, { strict = false } = {}) {
  const input = String(value ?? '');
  let unresolved = false;
  const output = input.replace(REPLAY_TEMPLATE_PATTERN, (_match, keyPath) => {
    const resolved = lookupReplayStateValue(replayState, keyPath);
    if (resolved === undefined || resolved === null) {
      unresolved = true;
      return '';
    }
    return String(resolved);
  });

  if (strict && unresolved) {
    throw new Error(`unresolved replay template in value: ${input}`);
  }

  return output;
}

export function hasReplayTemplate(value) {
  return REPLAY_TEMPLATE_DETECT_PATTERN.test(String(value ?? ''));
}

export function interpolateReplayValue(value, replayState = {}, options = {}) {
  if (typeof value === 'string') {
    return interpolateReplayString(value, replayState, options);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => interpolateReplayValue(entry, replayState, options));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateReplayValue(entry, replayState, options)]),
    );
  }

  return value;
}
