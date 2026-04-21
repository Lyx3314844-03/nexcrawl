/**
 * Protobuf Structure Inference — reverse-engineer protobuf message structure
 * from binary data without .proto files.
 *
 * Strategy:
 *   1. Parse wire format: extract field numbers, types, and values
 *   2. Infer field types from wire type + value patterns
 *   3. Detect repeated fields, nested messages, packed arrays
 *   4. Generate .proto schema from inferred structure
 *
 * Wire types:
 *   0 = varint (int32/int64/uint32/uint64/bool/enum)
 *   1 = 64-bit (fixed64/sfixed64/double)
 *   2 = length-delimited (string/bytes/embedded message/packed repeated)
 *   5 = 32-bit (fixed32/sfixed32/float)
 */

// ─── Wire format parsing ──────────────────────────────────────────────────────

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, nextOffset: pos };
}

function readFixed32(buf, offset) {
  if (offset + 4 > buf.length) return { value: 0, nextOffset: offset };
  const value = buf.readUInt32LE(offset);
  return { value, nextOffset: offset + 4 };
}

function readFixed64(buf, offset) {
  if (offset + 8 > buf.length) return { value: 0n, nextOffset: offset };
  const value = buf.readBigUInt64LE(offset);
  return { value, nextOffset: offset + 8 };
}

function parseWireFormat(buf) {
  const fields = [];
  let offset = 0;

  while (offset < buf.length) {
    // Read tag (field number + wire type)
    const { value: tag, nextOffset: tagEnd } = readVarint(buf, offset);
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    offset = tagEnd;

    let value = null;
    let rawBytes = null;

    if (wireType === 0) {
      // Varint
      const res = readVarint(buf, offset);
      value = res.value;
      offset = res.nextOffset;
    } else if (wireType === 1) {
      // 64-bit
      const res = readFixed64(buf, offset);
      value = res.value;
      offset = res.nextOffset;
    } else if (wireType === 2) {
      // Length-delimited
      const { value: length, nextOffset: lenEnd } = readVarint(buf, offset);
      offset = lenEnd;
      if (offset + length > buf.length) break;
      rawBytes = buf.subarray(offset, offset + length);
      value = rawBytes;
      offset += length;
    } else if (wireType === 5) {
      // 32-bit
      const res = readFixed32(buf, offset);
      value = res.value;
      offset = res.nextOffset;
    } else {
      // Unknown wire type, skip
      break;
    }

    fields.push({ fieldNumber, wireType, value, rawBytes });
  }

  return fields;
}

// ─── Type inference ───────────────────────────────────────────────────────────

function inferFieldType(wireType, value, rawBytes) {
  if (wireType === 0) {
    // Varint: could be int32/int64/uint32/uint64/bool/enum
    if (value === 0 || value === 1) return 'bool';
    if (value < 0) return 'int32';
    if (value < 2147483647) return 'uint32';
    return 'int64';
  }

  if (wireType === 1) {
    // 64-bit: fixed64/sfixed64/double
    return 'double';
  }

  if (wireType === 2) {
    // Length-delimited: string/bytes/message/packed
    if (!rawBytes) return 'bytes';

    // Try to parse as UTF-8 string
    try {
      const str = rawBytes.toString('utf8');
      if (/^[\x20-\x7E\s]*$/.test(str)) return 'string';
    } catch {}

    // Try to parse as nested message
    try {
      const nested = parseWireFormat(rawBytes);
      if (nested.length > 0) return 'message';
    } catch {}

    return 'bytes';
  }

  if (wireType === 5) {
    // 32-bit: fixed32/sfixed32/float
    return 'float';
  }

  return 'unknown';
}

// ─── Schema generation ────────────────────────────────────────────────────────

/**
 * Infer protobuf message structure from binary data.
 *
 * @param {Buffer} data - Protobuf binary data
 * @param {Object} [options]
 * @param {string} [options.messageName='InferredMessage']
 * @param {boolean} [options.detectRepeated=true]
 * @returns {{
 *   fields: Array<{fieldNumber: number, name: string, type: string, repeated: boolean}>,
 *   protoSchema: string,
 *   rawFields: Array
 * }}
 */
export function inferProtobufStructure(data, options = {}) {
  const { messageName = 'InferredMessage', detectRepeated = true } = options;

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const rawFields = parseWireFormat(buf);

  // Group by field number to detect repeated fields
  const fieldMap = new Map();
  for (const field of rawFields) {
    if (!fieldMap.has(field.fieldNumber)) {
      fieldMap.set(field.fieldNumber, []);
    }
    fieldMap.get(field.fieldNumber).push(field);
  }

  const fields = [];
  for (const [fieldNumber, occurrences] of fieldMap) {
    const first = occurrences[0];
    const type = inferFieldType(first.wireType, first.value, first.rawBytes);
    const repeated = detectRepeated && occurrences.length > 1;
    const name = `field_${fieldNumber}`;
    fields.push({ fieldNumber, name, type, repeated });
  }

  // Sort by field number
  fields.sort((a, b) => a.fieldNumber - b.fieldNumber);

  // Generate .proto schema
  const protoLines = [
    `syntax = "proto3";`,
    ``,
    `message ${messageName} {`,
  ];

  for (const field of fields) {
    const repeatedPrefix = field.repeated ? 'repeated ' : '';
    protoLines.push(`  ${repeatedPrefix}${field.type} ${field.name} = ${field.fieldNumber};`);
  }

  protoLines.push(`}`);

  return {
    fields,
    protoSchema: protoLines.join('\n'),
    rawFields,
  };
}

/**
 * Infer structure from multiple samples to improve accuracy.
 *
 * @param {Buffer[]} samples - Array of protobuf binary samples
 * @param {Object} [options]
 * @returns {ReturnType<inferProtobufStructure>}
 */
export function inferFromMultipleSamples(samples, options = {}) {
  const allFields = new Map();

  for (const sample of samples) {
    const { fields } = inferProtobufStructure(sample, { ...options, detectRepeated: false });
    for (const field of fields) {
      const key = field.fieldNumber;
      if (!allFields.has(key)) {
        allFields.set(key, { ...field, count: 0, types: new Set() });
      }
      const existing = allFields.get(key);
      existing.count++;
      existing.types.add(field.type);
    }
  }

  // Resolve type conflicts (pick most common)
  const fields = [];
  for (const [fieldNumber, info] of allFields) {
    const type = info.types.size === 1 ? [...info.types][0]
      : info.types.has('string') ? 'string'
      : info.types.has('message') ? 'message'
      : [...info.types][0];
    const repeated = info.count > samples.length * 0.5; // If appears in >50% samples
    fields.push({ fieldNumber, name: info.name, type, repeated });
  }

  fields.sort((a, b) => a.fieldNumber - b.fieldNumber);

  const messageName = options.messageName ?? 'InferredMessage';
  const protoLines = [
    `syntax = "proto3";`,
    ``,
    `message ${messageName} {`,
  ];

  for (const field of fields) {
    const repeatedPrefix = field.repeated ? 'repeated ' : '';
    protoLines.push(`  ${repeatedPrefix}${field.type} ${field.name} = ${field.fieldNumber};`);
  }

  protoLines.push(`}`);

  return {
    fields,
    protoSchema: protoLines.join('\n'),
    sampleCount: samples.length,
  };
}

/**
 * Decode a protobuf message using inferred structure.
 *
 * @param {Buffer} data
 * @param {Object} schema - Result from inferProtobufStructure()
 * @returns {Object} - Decoded message as plain object
 */
export function decodeWithInferredSchema(data, schema) {

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const rawFields = parseWireFormat(buf);
  const result = {};

  for (const raw of rawFields) {
    const fieldInfo = schema.fields.find((f) => f.fieldNumber === raw.fieldNumber);
    if (!fieldInfo) continue;

    let decodedValue = raw.value;
    if (fieldInfo.type === 'string' && raw.rawBytes) {
      decodedValue = raw.rawBytes.toString('utf8');
    } else if (fieldInfo.type === 'message' && raw.rawBytes) {
      decodedValue = `<nested message ${raw.rawBytes.length} bytes>`;
    } else if (fieldInfo.type === 'bytes' && raw.rawBytes) {
      decodedValue = raw.rawBytes.toString('hex');
    } else if (typeof raw.value === 'bigint') {
      decodedValue = Number(raw.value);
    }

    if (fieldInfo.repeated) {
      if (!result[fieldInfo.name]) result[fieldInfo.name] = [];
      result[fieldInfo.name].push(decodedValue);
    } else {
      result[fieldInfo.name] = decodedValue;
    }
  }

  return result;
}
