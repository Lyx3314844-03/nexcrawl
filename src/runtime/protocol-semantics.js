const CRITICAL_GQL_RE = /(login|auth|session|token|refresh|checkout|order|payment|search|profile|user|account|mutation)/i;
const CHANNEL_RE = /(channel|topic|room|stream|symbol|feed|subscription|watch)/i;
const HEARTBEAT_RE = /(ping|pong|heartbeat|keepalive|keep_alive)/i;

function typeName(value) {
  return String(value ?? '').replace(/[!\[\]]/g, '');
}

export function inferGraphQLSemantics(schema = {}, options = {}) {
  const roots = [
    ['query', schema.queryType],
    ['mutation', schema.mutationType],
    ['subscription', schema.subscriptionType],
  ];
  const types = new Map((schema.types ?? []).map((entry) => [entry.name, entry]));
  const operations = [];

  for (const [operationType, rootName] of roots) {
    const root = types.get(rootName);
    for (const field of root?.fields ?? []) {
      const score = [
        CRITICAL_GQL_RE.test(field.name) ? 5 : 0,
        operationType === 'mutation' ? 3 : 0,
        (field.args?.length ?? 0) > 0 ? 1 : 0,
        /token|session|auth/i.test(JSON.stringify(field.args ?? [])) ? 3 : 0,
      ].reduce((sum, value) => sum + value, 0);
      operations.push({
        operationType,
        fieldName: field.name,
        returnType: typeName(field.type),
        args: field.args ?? [],
        score,
        critical: score >= Number(options.criticalScore ?? 5),
      });
    }
  }

  return {
    kind: 'graphql-semantics',
    operations: operations.sort((left, right) => right.score - left.score),
    criticalOperations: operations.filter((operation) => operation.critical).sort((left, right) => right.score - left.score),
  };
}

export function inferWebSocketSemantics(transcript = []) {
  const messages = transcript.map((entry, index) => {
    const payload = entry?.json ?? entry?.payload ?? entry?.message ?? entry;
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
    return {
      index,
      direction: entry?.direction ?? 'in',
      payload,
      isHeartbeat: HEARTBEAT_RE.test(text),
      isSubscription: /(subscribe|join|listen|watch)/i.test(text),
      channelKeys: Object.keys(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {})
        .filter((key) => CHANNEL_RE.test(key)),
      isError: /(error|unauthorized|forbidden|failed)/i.test(text),
    };
  });
  const subscription = messages.find((message) => message.isSubscription);
  const heartbeat = messages.find((message) => message.isHeartbeat);

  return {
    kind: 'websocket-semantics',
    subscriptionModel: subscription ? 'explicit-subscribe' : 'implicit-stream',
    channelFields: [...new Set(messages.flatMap((message) => message.channelKeys))],
    heartbeat: {
      required: Boolean(heartbeat),
      sample: heartbeat?.payload ?? null,
    },
    errorRecovery: messages.some((message) => message.isError) ? 'refresh-auth-and-reconnect' : 'reconnect-on-close',
    messages,
  };
}

export function inferGrpcSemantics(samples = []) {
  const groups = new Map();
  for (const sample of samples) {
    const fields = sample.fields ?? sample.inferred?.fields ?? [];
    const signature = fields
      .map((field) => `${field.id ?? field.number ?? field.name}:${field.type ?? typeof field.value}`)
      .sort()
      .join('|') || `len:${sample.length ?? sample.bytes?.length ?? 0}`;
    if (!groups.has(signature)) {
      groups.set(signature, { signature, count: 0, samples: [], semanticHints: [] });
    }
    const group = groups.get(signature);
    group.count += 1;
    group.samples.push(sample);
    const text = JSON.stringify(sample).toLowerCase();
    if (/token|auth|session/.test(text)) group.semanticHints.push('auth');
    if (/id|uuid|cursor/.test(text)) group.semanticHints.push('identity-or-pagination');
    if (/error|status|code/.test(text)) group.semanticHints.push('status');
  }

  return {
    kind: 'grpc-semantics',
    messageTypes: [...groups.values()].map((group, index) => ({
      typeId: `message-type-${index + 1}`,
      signature: group.signature,
      count: group.count,
      semanticHints: [...new Set(group.semanticHints)],
      sample: group.samples[0] ?? null,
    })),
  };
}
