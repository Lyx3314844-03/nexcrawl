import { readFile } from 'node:fs/promises';

const PROTOBUF_WIRE_TYPES = {
  0: 'varint',
  1: 'fixed64',
  2: 'length-delimited',
  3: 'start-group',
  4: 'end-group',
  5: 'fixed32',
};

function isBufferLike(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array || ArrayBuffer.isView(value);
}

function normalizeBase64(value) {
  return String(value ?? '')
    .replace(/[\r\n\s]/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
}

function looksLikeBase64(value) {
  const normalized = normalizeBase64(value);
  return normalized.length > 0
    && normalized.length % 4 === 0
    && /^[A-Za-z0-9+/=]+$/.test(normalized);
}

function isMostlyPrintableText(buffer) {
  if (!buffer || buffer.length === 0) {
    return true;
  }

  let printable = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) {
      printable += 1;
    }
  }
  return printable / buffer.length >= 0.85;
}

function utf8Preview(buffer, maxBytes = 160) {
  if (!buffer || buffer.length === 0) {
    return '';
  }

  const preview = buffer.subarray(0, maxBytes).toString('utf8');
  return preview.length > 0 ? preview : '';
}

function makeBinaryPreview(buffer, maxBytes = 48) {
  const slice = buffer.subarray(0, maxBytes);
  return {
    utf8: isMostlyPrintableText(slice) ? slice.toString('utf8') : null,
    hex: slice.toString('hex'),
    base64: slice.toString('base64'),
    truncated: buffer.length > maxBytes,
  };
}

function fieldTypeToWireType(type = '') {
  const normalized = String(type).replace(/^\./, '').toLowerCase();
  if (['double', 'fixed64', 'sfixed64'].includes(normalized)) return 1;
  if (['float', 'fixed32', 'sfixed32'].includes(normalized)) return 5;
  if ([
    'string',
    'bytes',
    'message',
    'map',
  ].includes(normalized)) return 2;
  if ([
    'int32', 'int64', 'uint32', 'uint64',
    'sint32', 'sint64', 'bool', 'enum',
  ].includes(normalized)) return 0;
  return null;
}

function shouldTreatAsMessage(type = '') {
  const normalized = String(type).replace(/^\./, '');
  if (!normalized) return false;
  return ![
    'double', 'float',
    'int32', 'int64', 'uint32', 'uint64',
    'sint32', 'sint64',
    'fixed32', 'fixed64',
    'sfixed32', 'sfixed64',
    'bool', 'string', 'bytes', 'enum',
  ].includes(normalized.toLowerCase());
}

function toSafeNumber(value) {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  return value;
}

export function normalizeBinaryInput(payload, options = {}) {
  const {
    encoding = 'utf8',
    assumeBase64 = false,
  } = options;

  if (payload === null || payload === undefined) {
    return Buffer.alloc(0);
  }

  if (Buffer.isBuffer(payload)) {
    return payload;
  }

  if (payload instanceof Uint8Array) {
    return Buffer.from(payload);
  }

  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }

  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload);
  }

  if (Array.isArray(payload)) {
    return Buffer.from(payload);
  }

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    const wantsBase64 = assumeBase64 || encoding === 'base64' || looksLikeBase64(trimmed);
    return wantsBase64
      ? Buffer.from(normalizeBase64(trimmed), 'base64')
      : Buffer.from(payload, encoding);
  }

  throw new TypeError('Unsupported binary payload type');
}

function readVarint(buffer, offset = 0) {
  let result = 0n;
  let shift = 0n;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = BigInt(buffer[cursor]);
    result |= (byte & 0x7fn) << shift;
    cursor += 1;

    if ((byte & 0x80n) === 0n) {
      return {
        value: result,
        length: cursor - offset,
      };
    }

    shift += 7n;
    if (shift > 70n) {
      break;
    }
  }

  throw new Error(`Invalid protobuf varint at offset ${offset}`);
}

function parseProtoBlocks(source = '', keyword = 'message') {
  const blocks = [];
  const marker = `${keyword} `;
  let cursor = 0;

  while (cursor < source.length) {
    const keywordIndex = source.indexOf(marker, cursor);
    if (keywordIndex === -1) {
      break;
    }

    const headerMatch = source.slice(keywordIndex).match(new RegExp(`^${keyword}\\s+([A-Za-z_][\\w.]*)\\s*\\{`));
    if (!headerMatch) {
      cursor = keywordIndex + marker.length;
      continue;
    }

    const name = headerMatch[1];
    const bodyStart = keywordIndex + headerMatch[0].length;
    let depth = 1;
    let index = bodyStart;

    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      index += 1;
    }

    blocks.push({
      name,
      body: source.slice(bodyStart, Math.max(bodyStart, index - 1)),
    });
    cursor = index;
  }

  return blocks;
}

function parseProtoMessageBody(body = '') {
  const fieldsByNumber = {};
  const fieldsByName = {};
  const lines = body.split('\n');

  for (const rawLine of lines) {
    const line = rawLine
      .replace(/\/\/.*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line || line.startsWith('option ') || line.startsWith('oneof ') || line.startsWith('reserved ')) {
      continue;
    }

    const match = line.match(/^(optional|required|repeated)?\s*([.\w<>]+)\s+([A-Za-z_]\w*)\s*=\s*(\d+)/);
    if (!match) {
      continue;
    }

    const label = match[1] ?? null;
    const type = match[2];
    const name = match[3];
    const fieldNumber = Number(match[4]);
    const descriptor = {
      fieldNumber,
      name,
      type,
      label,
      repeated: label === 'repeated',
      wireType: fieldTypeToWireType(type),
    };
    fieldsByNumber[fieldNumber] = descriptor;
    fieldsByName[name] = descriptor;
  }

  return {
    fieldsByNumber,
    fieldsByName,
  };
}

function parseProtoServiceBody(body = '') {
  const methods = [];
  const lines = body.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    const match = line.match(/^rpc\s+([A-Za-z_]\w*)\s*\(\s*([.\w]+)\s*\)\s*returns\s*\(\s*([.\w]+)\s*\)/);
    if (!match) {
      continue;
    }

    methods.push({
      name: match[1],
      requestType: match[2].replace(/^\./, ''),
      responseType: match[3].replace(/^\./, ''),
    });
  }

  return methods;
}

export async function loadProtoSchema(descriptorPaths = []) {
  const messages = {};
  const services = [];

  for (const descriptorPath of descriptorPaths) {
    const source = await readFile(descriptorPath, 'utf8');
    for (const block of parseProtoBlocks(source, 'message')) {
      messages[block.name.replace(/^\./, '')] = {
        name: block.name.replace(/^\./, ''),
        ...parseProtoMessageBody(block.body),
      };
    }

    for (const block of parseProtoBlocks(source, 'service')) {
      services.push({
        name: block.name.replace(/^\./, ''),
        methods: parseProtoServiceBody(block.body),
      });
    }
  }

  return {
    messageCount: Object.keys(messages).length,
    serviceCount: services.length,
    messages,
    services,
  };
}

function resolveMessageDescriptor(schema, messageType) {
  if (!schema || !messageType) {
    return null;
  }

  const normalized = String(messageType).replace(/^\./, '');
  return schema.messages?.[normalized] ?? null;
}

export function decodeProtobufMessage(buffer, options = {}) {
  const {
    descriptor = null,
    schema = null,
    maxDepth = 2,
    depth = 0,
  } = options;

  const fields = [];
  let offset = 0;

  while (offset < buffer.length) {
    const fieldOffset = offset;
    const tag = readVarint(buffer, offset);
    offset += tag.length;

    const tagValue = Number(tag.value);
    const fieldNumber = tagValue >> 3;
    const wireType = tagValue & 0x07;
    const descriptorField = descriptor?.fieldsByNumber?.[fieldNumber] ?? null;
    const wireTypeName = PROTOBUF_WIRE_TYPES[wireType] ?? 'unknown';
    const field = {
      fieldNumber,
      fieldName: descriptorField?.name ?? null,
      fieldType: descriptorField?.type ?? null,
      label: descriptorField?.label ?? null,
      wireType,
      wireTypeName,
      offset: fieldOffset,
      value: null,
      byteLength: 0,
    };

    if (wireType === 0) {
      const decoded = readVarint(buffer, offset);
      offset += decoded.length;
      field.byteLength = decoded.length;
      field.valueType = 'varint';
      field.value = toSafeNumber(decoded.value);
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) {
        throw new Error(`Invalid fixed64 field at offset ${offset}`);
      }
      const slice = buffer.subarray(offset, offset + 8);
      offset += 8;
      field.byteLength = 8;
      field.valueType = 'fixed64';
      field.value = {
        littleEndianUnsigned: slice.readBigUInt64LE(0).toString(),
        hex: slice.toString('hex'),
      };
    } else if (wireType === 2) {
      const lengthInfo = readVarint(buffer, offset);
      offset += lengthInfo.length;
      const length = Number(lengthInfo.value);
      const end = offset + length;
      if (end > buffer.length) {
        throw new Error(`Invalid length-delimited field at offset ${offset}`);
      }
      const slice = buffer.subarray(offset, end);
      offset = end;
      field.byteLength = length;
      field.valueType = 'length-delimited';

      const preview = makeBinaryPreview(slice);
      const text = isMostlyPrintableText(slice) ? slice.toString('utf8') : null;
      field.preview = preview;

      if (descriptorField?.type === 'bytes') {
        field.value = {
          base64: slice.toString('base64'),
          hex: slice.toString('hex'),
        };
      } else if (text && text.trim().startsWith('{')) {
        try {
          field.value = JSON.parse(text);
          field.valueType = 'json';
        } catch {
          field.value = text;
          field.valueType = 'string';
        }
      } else if (text) {
        field.value = text;
        field.valueType = 'string';
      } else {
        const nestedDescriptor = shouldTreatAsMessage(descriptorField?.type)
          ? resolveMessageDescriptor(schema, descriptorField?.type)
          : null;
        if (depth < maxDepth) {
          try {
            const nested = decodeProtobufMessage(slice, {
              descriptor: nestedDescriptor,
              schema,
              maxDepth,
              depth: depth + 1,
            });
            if (nested.fields.length > 0) {
              field.nestedMessage = nested;
              field.value = {
                nestedFieldCount: nested.fields.length,
              };
              field.valueType = 'message';
            } else {
              field.value = {
                base64: slice.toString('base64'),
                hex: slice.toString('hex'),
              };
              field.valueType = 'bytes';
            }
          } catch {
            field.value = {
              base64: slice.toString('base64'),
              hex: slice.toString('hex'),
            };
            field.valueType = 'bytes';
          }
        } else {
          field.value = {
            base64: slice.toString('base64'),
            hex: slice.toString('hex'),
          };
          field.valueType = 'bytes';
        }
      }
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) {
        throw new Error(`Invalid fixed32 field at offset ${offset}`);
      }
      const slice = buffer.subarray(offset, offset + 4);
      offset += 4;
      field.byteLength = 4;
      field.valueType = 'fixed32';
      field.value = {
        littleEndianUnsigned: slice.readUInt32LE(0),
        hex: slice.toString('hex'),
      };
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }

    fields.push(field);
  }

  return {
    byteLength: buffer.length,
    descriptorName: descriptor?.name ?? null,
    fields,
  };
}

function resolveGrpcMethod(schema, path = '') {
  const parts = String(path).split('/').filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const serviceName = parts[0].replace(/^\./, '');
  const methodName = parts[1];
  for (const service of schema?.services ?? []) {
    const serviceMatches = service.name === serviceName || service.name.endsWith(`.${serviceName}`);
    if (!serviceMatches) continue;
    const method = service.methods.find((entry) => entry.name === methodName);
    if (method) {
      return {
        service: service.name,
        ...method,
      };
    }
  }

  return {
    service: serviceName,
    name: methodName,
    requestType: null,
    responseType: null,
  };
}

export async function analyzeProtobufPayload(payload, options = {}) {
  const {
    encoding = 'base64',
    assumeBase64 = encoding === 'base64',
    descriptorPaths = [],
    messageType = null,
    maxDepth = 2,
  } = options;

  const buffer = normalizeBinaryInput(payload, {
    encoding,
    assumeBase64,
  });
  const schema = descriptorPaths.length > 0 ? await loadProtoSchema(descriptorPaths) : null;
  const descriptor = resolveMessageDescriptor(schema, messageType);
  const decoded = decodeProtobufMessage(buffer, {
    descriptor,
    schema,
    maxDepth,
  });

  return {
    kind: 'protobuf-analysis',
    format: 'protobuf',
    byteLength: buffer.length,
    messageType: descriptor?.name ?? (messageType ? String(messageType) : null),
    schema: schema
      ? {
          messageCount: schema.messageCount,
          serviceCount: schema.serviceCount,
          messages: Object.keys(schema.messages).slice(0, 40),
          services: schema.services.map((service) => ({
            name: service.name,
            methods: service.methods,
          })),
        }
      : null,
    decoded,
    preview: makeBinaryPreview(buffer),
  };
}

export async function analyzeGrpcPayload(payload, options = {}) {
  const {
    encoding = 'base64',
    assumeBase64 = encoding === 'base64',
    descriptorPaths = [],
    path = '',
    direction = 'request',
    maxDepth = 2,
  } = options;

  const rawBuffer = normalizeBinaryInput(payload, {
    encoding,
    assumeBase64,
  });
  const schema = descriptorPaths.length > 0 ? await loadProtoSchema(descriptorPaths) : null;
  const grpcMethod = resolveGrpcMethod(schema, path);
  const selectedType = direction === 'response'
    ? grpcMethod?.responseType ?? null
    : grpcMethod?.requestType ?? null;
  const descriptor = resolveMessageDescriptor(schema, selectedType);
  const frames = [];

  let offset = 0;
  while (offset + 5 <= rawBuffer.length) {
    const compressed = rawBuffer[offset] === 1;
    const messageLength = rawBuffer.readUInt32BE(offset + 1);
    offset += 5;
    const end = offset + messageLength;
    if (end > rawBuffer.length) {
      throw new Error('Invalid gRPC frame length');
    }

    const message = rawBuffer.subarray(offset, end);
    offset = end;
    frames.push({
      compressed,
      byteLength: messageLength,
      preview: makeBinaryPreview(message),
      message: decodeProtobufMessage(message, {
        descriptor,
        schema,
        maxDepth,
      }),
    });
  }

  const trailingBytes = rawBuffer.length - offset;
  return {
    kind: 'grpc-analysis',
    format: 'grpc',
    byteLength: rawBuffer.length,
    frameCount: frames.length,
    trailingBytes,
    path: path || null,
    direction,
    method: grpcMethod,
    messageType: descriptor?.name ?? selectedType ?? null,
    schema: schema
      ? {
          messageCount: schema.messageCount,
          serviceCount: schema.serviceCount,
          services: schema.services.map((service) => ({
            name: service.name,
            methods: service.methods,
          })),
        }
      : null,
    frames,
    preview: makeBinaryPreview(rawBuffer),
  };
}
