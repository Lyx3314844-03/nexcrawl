import CryptoJS from 'crypto-js';
import smCrypto from 'sm-crypto';

const { sm2, sm3, sm4 } = smCrypto;

const cryptoPatterns = {
  MD5: {
    pattern: /\b(md5|MD5|hash\.md5|CryptoJS\.MD5)\b/i,
    type: 'hash',
    description: 'MD5 哈希算法（128位）',
  },
  SHA1: {
    pattern: /\b(sha1|SHA1|hash\.sha1|CryptoJS\.SHA1)\b/i,
    type: 'hash',
    description: 'SHA-1 哈希算法（160位）',
  },
  SHA256: {
    pattern: /\b(sha256|SHA256|sha-256|CryptoJS\.SHA256)\b/i,
    type: 'hash',
    description: 'SHA-256 哈希算法（256位）',
  },
  SHA512: {
    pattern: /\b(sha512|SHA512|sha-512|CryptoJS\.SHA512)\b/i,
    type: 'hash',
    description: 'SHA-512 哈希算法（512位）',
  },
  SM2: {
    pattern: /\b(sm2|SM2|sm2\.encrypt|sm2\.decrypt|sm2\.sign)\b/i,
    type: 'asymmetric',
    description: '国密SM2 非对称加密算法',
  },
  SM3: {
    pattern: /\b(sm3|SM3|sm3\.hash|sm3\.digest)\b/i,
    type: 'hash',
    description: '国密SM3 哈希算法（256位）',
  },
  SM4: {
    pattern: /\b(sm4|SM4|sm4\.encrypt|sm4\.decrypt)\b/i,
    type: 'symmetric',
    description: '国密SM4 对称加密算法（128位）',
  },
  AES: {
    pattern: /\b(aes|AES|aes\.encrypt|aes\.decrypt|CryptoJS\.AES)\b/i,
    type: 'symmetric',
    description: 'AES 对称加密算法（128/192/256位）',
    modes: ['ECB', 'CBC', 'CFB', 'OFB', 'CTR'],
  },
  DES: {
    pattern: /\b(des|DES|des\.encrypt|des\.decrypt|CryptoJS\.DES)\b/i,
    type: 'symmetric',
    description: 'DES 对称加密算法（56位）',
  },
  TripleDES: {
    pattern: /\b(tripledes|3DES|TripleDES|des\.ede)\b/i,
    type: 'symmetric',
    description: '3DES 三重DES加密',
  },
  RC4: {
    pattern: /\b(rc4|RC4|rc4\.encrypt|rc4\.decrypt|arc4)\b/i,
    type: 'symmetric',
    description: 'RC4 流加密算法',
  },
  Rabbit: {
    pattern: /\b(rabbit|Rabbit|CryptoJS\.Rabbit)\b/i,
    type: 'symmetric',
    description: 'Rabbit 流加密算法',
  },
  RSA: {
    pattern: /\b(rsa|RSA|rsa\.encrypt|rsa\.decrypt|publicKey|privateKey|RSAKey)\b/i,
    type: 'asymmetric',
    description: 'RSA 非对称加密算法',
    keySizes: [1024, 2048, 4096],
  },
  ECC: {
    pattern: /\b(ecc|ECC|elliptic|ecdsa|ecdh)\b/i,
    type: 'asymmetric',
    description: 'ECC 椭圆曲线加密',
  },
  HMAC: {
    pattern: /\b(hmac|HMAC|hmacsha|hmac-md5|hmac-sha)\b/i,
    type: 'mac',
    description: 'HMAC 基于哈希的消息认证码',
  },
  CMAC: {
    pattern: /\b(cmac|CMAC|aes-cmac)\b/i,
    type: 'mac',
    description: 'CMAC 基于AES的消息认证码',
  },
  Base64: {
    pattern: /\b(base64|Base64|btoa|atob|CryptoJS\.enc\.Base64|Buffer\.from.*base64)\b/i,
    type: 'encoding',
    description: 'Base64 编码',
  },
  Hex: {
    pattern: /\b(hex|Hex|CryptoJS\.enc\.Hex|toString\(\s*["']hex["']\s*\))\b/i,
    type: 'encoding',
    description: 'Hex 十六进制编码',
  },
  UTF8: {
    pattern: /\b(utf8|UTF8|utf-8|CryptoJS\.enc\.Utf8|TextEncoder|TextDecoder)\b/i,
    type: 'encoding',
    description: 'UTF-8 编码',
  },
  PBKDF2: {
    pattern: /\b(pbkdf2|PBKDF2|pbkdf2sync|crypto\.pbkdf2|crypto\.pbkdf2sync|pbkdf2\.derive)\b/i,
    type: 'kdf',
    description: 'PBKDF2 密码基密钥派生函数',
  },
  Bcrypt: {
    pattern: /\b(bcrypt|Bcrypt|bcrypt\.hash|bcrypt\.genSalt)\b/i,
    type: 'kdf',
    description: 'Bcrypt 密码哈希函数',
  },
  Argon2: {
    pattern: /\b(argon2|Argon2|argon2\.hash)\b/i,
    type: 'kdf',
    description: 'Argon2 密码哈希函数',
  },
};

function confidenceKeywords(name) {
  return {
    MD5: ['md5', 'MD5', 'hash'],
    AES: ['aes', 'AES', 'encrypt', 'decrypt', 'key', 'iv', 'mode'],
    RSA: ['rsa', 'RSA', 'publicKey', 'privateKey', 'pem', 'encrypt'],
    SM2: ['sm2', 'SM2'],
    SM3: ['sm3', 'SM3'],
    SM4: ['sm4', 'SM4'],
    Rabbit: ['rabbit', 'Rabbit'],
    ECC: ['ecc', 'ecdsa', 'ecdh', 'elliptic'],
    PBKDF2: ['pbkdf2', 'iterations', 'salt'],
    Bcrypt: ['bcrypt', 'saltRounds', 'compare'],
    Argon2: ['argon2', 'memoryCost', 'timeCost'],
    Base64: ['base64', 'Base64', 'btoa', 'atob'],
    HMAC: ['hmac', 'HMAC', 'signature'],
  }[name] ?? [];
}

function calculateConfidence(code, cryptoName) {
  const keywords = confidenceKeywords(cryptoName);
  if (keywords.length === 0) {
    return 0.5;
  }

  const hits = keywords.filter((keyword) => code.toLowerCase().includes(keyword.toLowerCase())).length;
  return Math.min(0.95, 0.5 + hits * 0.1);
}

function collectMatches(code, patterns, mapMatch) {
  const output = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code)) !== null) {
      output.push(mapMatch(match));
    }
  }
  return output;
}

function dedupeEntries(entries, keyFn = (entry) => JSON.stringify(entry)) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = keyFn(entry);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function identifyCrypto(code) {
  return Object.entries(cryptoPatterns)
    .filter(([, config]) => {
      config.pattern.lastIndex = 0;
      return config.pattern.test(code);
    })
    .map(([name, config]) => ({
      name,
      type: config.type,
      description: config.description,
      confidence: calculateConfidence(code, name),
      modes: config.modes ?? [],
      keySizes: config.keySizes ?? [],
    }))
    .sort((left, right) => right.confidence - left.confidence);
}

export function extractKeys(code) {
  return dedupeEntries(
    collectMatches(
      code,
      [
        /(?:key|secret|password|pwd|passphrase)\s*[:=]\s*["']([^"']{8,64})["']/gi,
        /(?:aes|des|sm4)[_-]?(?:key|secret)\s*[:=]\s*["']([^"']+)["']/gi,
        /CryptoJS\.(?:enc\.)?(?:Utf8|Hex|Base64)\.parse\(["']([^"']+)["']\)/gi,
        /new\s+(?:Uint8Array|Buffer)\(\[([^\]]+)\]/gi,
        /const\s+\w*[Kk]ey\w*\s*=\s*["']([^"']+)["']/gi,
      ],
      (match) => ({
        value: match[1],
        context: match[0],
        index: match.index,
        type: guessKeyType(match[1]),
      }),
    ),
    (entry) => entry.value,
  );
}

export function maskKey(key) {
  if (!key || key.length <= 8) return '***';
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

export function extractKeysMasked(code) {
  return extractKeys(code).map((entry) => ({
    ...entry,
    maskedValue: maskKey(entry.value),
    warning: '密钥已脱敏，完整密钥仅在必要时返回',
  }));
}

function guessKeyType(key) {
  if (key.length === 32) return 'AES-128';
  if (key.length === 48) return 'AES-192';
  if (key.length === 64) return 'AES-256';
  if (key.length === 16) return 'DES/SM4';
  if (/^[0-9a-fA-F]+$/.test(key)) return 'Hex Key';
  if (/^[A-Za-z0-9+/=]+$/.test(key)) return 'Base64 Key';
  return 'Unknown';
}

export function extractIVs(code) {
  return collectMatches(
    code,
    [
      /(?:iv|IV|initializationVector|initVec)\s*[:=]\s*["']([^"']{16,32})["']/gi,
      /iv:\s*CryptoJS\.(?:enc\.)?(?:Utf8|Hex|Base64)\.parse\(["']([^"']+)["']\)/gi,
      /const\s+\w*[Ii][Vv]\w*\s*=\s*["']([^"']+)["']/gi,
    ],
    (match) => ({
      value: match[1],
      context: match[0],
      index: match.index,
    }),
  );
}

export function extractModes(code) {
  return collectMatches(
    code,
    [
      /(?:mode|Mode)\s*[:=]\s*["']?([^"',}\]]+)["']?/gi,
      /\b(ECB|CBC|CFB|OFB|CTR|GCM|CCM|OCB)\b/gi,
      /\b(Pkcs7|Pkcs5|NoPadding|ZeroPadding|Iso10126|AnsiX923)\b/gi,
    ],
    (match) => ({
      type: match[0].includes('Pkcs') || match[0].includes('Padding') ? 'Padding' : 'Mode',
      value: match[1],
      context: match[0],
    }),
  );
}

export function extractSignatures(code) {
  return collectMatches(
    code,
    [
      /(?:sign|signature|signed)\s*\(\s*["']([^"']+)["']\s*\)/gi,
      /(?:createSign|createHash)\s*\(\s*["']([^"']+)["']\s*\)/gi,
      /(?:RSA|ECDSA|SM2)\.sign\s*\(/gi,
    ],
    (match) => ({
      algorithm: match[1] || 'Unknown',
      context: match[0],
      index: match.index,
    }),
  );
}

export function extractSalt(code) {
  return collectMatches(
    code,
    [
      /(?:salt|Salt)\s*[:=]\s*["']([^"']+)["']/gi,
      /salt:\s*CryptoJS\.(?:enc\.)?(?:Utf8|Hex|Base64)\.parse\(["']([^"']+)["']\)/gi,
    ],
    (match) => ({
      value: match[1],
      context: match[0],
      index: match.index,
    }),
  );
}

export function analyzeEncryption(code) {
  const cryptoTypes = identifyCrypto(code);
  const keys = extractKeys(code);
  const ivs = extractIVs(code);
  const modes = extractModes(code);
  const signatures = extractSignatures(code);
  const salt = extractSalt(code);
  const suggestions = [];

  if (cryptoTypes.length > 0) {
    suggestions.push(`已识别 ${cryptoTypes.length} 种加密算法`);
  }
  if (keys.length > 0) {
    suggestions.push(`发现 ${keys.length} 个疑似密钥`);
  }
  if (signatures.length > 0) {
    suggestions.push(`发现 ${signatures.length} 个签名算法`);
  }

  return {
    cryptoTypes,
    keys,
    ivs,
    modes,
    signatures,
    salt,
    suggestions,
  };
}

function utf8WordArray(value) {
  return typeof value === 'string' ? CryptoJS.enc.Utf8.parse(value) : value;
}

export function encrypt({ algorithm, data, key, iv, mode = 'CBC', padding, hmacAlgorithm } = {}) {
  switch (String(algorithm).toUpperCase()) {
    case 'AES':
      return aesEncrypt(data, key, iv, mode, padding);
    case 'DES':
      return desEncrypt(data, key, iv, mode);
    case 'TRIPLEDES':
    case '3DES':
      return tripleDesEncrypt(data, key, iv, mode);
    case 'SM4':
      return sm4.encrypt(data, key, { mode: String(mode).toLowerCase(), iv });
    case 'RC4':
      return CryptoJS.RC4.encrypt(data, utf8WordArray(key)).toString();
    case 'RABBIT':
      return CryptoJS.Rabbit.encrypt(data, utf8WordArray(key)).toString();
    case 'MD5':
      return CryptoJS.MD5(data).toString();
    case 'SHA256':
      return CryptoJS.SHA256(data).toString();
    case 'SHA512':
      return CryptoJS.SHA512(data).toString();
    case 'SM3':
      return sm3(data);
    case 'BASE64':
      return CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(data));
    case 'HMAC':
      return hmac(data, key, hmacAlgorithm);
    default:
      throw new Error(`不支持的加密算法: ${algorithm}`);
  }
}

export function decrypt({ algorithm, data, key, iv, mode = 'CBC' } = {}) {
  switch (String(algorithm).toUpperCase()) {
    case 'AES':
      return aesDecrypt(data, key, iv, mode);
    case 'DES':
      return desDecrypt(data, key, iv, mode);
    case 'TRIPLEDES':
    case '3DES':
      return tripleDesDecrypt(data, key, iv, mode);
    case 'SM4':
      return sm4.decrypt(data, key, { mode: String(mode).toLowerCase(), iv });
    case 'RC4':
      return CryptoJS.RC4.decrypt(data, utf8WordArray(key)).toString(CryptoJS.enc.Utf8);
    case 'RABBIT':
      return CryptoJS.Rabbit.decrypt(data, utf8WordArray(key)).toString(CryptoJS.enc.Utf8);
    case 'BASE64':
      return CryptoJS.enc.Base64.parse(data).toString(CryptoJS.enc.Utf8);
    default:
      throw new Error(`不支持的解密算法: ${algorithm}`);
  }
}

function aesEncrypt(data, key, iv, mode = 'CBC', padding = 'Pkcs7') {
  const config = {};
  if (iv) config.iv = utf8WordArray(iv);
  config.mode = CryptoJS.mode[String(mode).toUpperCase()] ?? CryptoJS.mode.CBC;
  config.padding = CryptoJS.pad[padding] ?? CryptoJS.pad.Pkcs7;
  return CryptoJS.AES.encrypt(data, utf8WordArray(key), config).toString();
}

function aesDecrypt(data, key, iv, mode = 'CBC', padding = 'Pkcs7') {
  const config = {};
  if (iv) config.iv = utf8WordArray(iv);
  config.mode = CryptoJS.mode[String(mode).toUpperCase()] ?? CryptoJS.mode.CBC;
  config.padding = CryptoJS.pad[padding] ?? CryptoJS.pad.Pkcs7;
  const output = CryptoJS.AES.decrypt(data, utf8WordArray(key), config).toString(CryptoJS.enc.Utf8);
  if (!output) {
    throw new Error('解密结果为空，可能是密钥或IV错误');
  }
  return output;
}

function desEncrypt(data, key, iv, mode = 'CBC') {
  const config = {};
  if (iv) config.iv = utf8WordArray(iv);
  config.mode = CryptoJS.mode[String(mode).toUpperCase()] ?? CryptoJS.mode.CBC;
  return CryptoJS.DES.encrypt(data, utf8WordArray(key), config).toString();
}

function desDecrypt(data, key, iv, mode = 'CBC') {
  const config = {};
  if (iv) config.iv = utf8WordArray(iv);
  config.mode = CryptoJS.mode[String(mode).toUpperCase()] ?? CryptoJS.mode.CBC;
  const output = CryptoJS.DES.decrypt(data, utf8WordArray(key), config).toString(CryptoJS.enc.Utf8);
  if (!output) {
    throw new Error('解密结果为空，可能是密钥或IV错误');
  }
  return output;
}

function tripleDesEncrypt(data, key, iv, mode = 'CBC') {
  const config = {};
  if (iv) config.iv = utf8WordArray(iv);
  config.mode = CryptoJS.mode[String(mode).toUpperCase()] ?? CryptoJS.mode.CBC;
  return CryptoJS.TripleDES.encrypt(data, utf8WordArray(key), config).toString();
}

function tripleDesDecrypt(data, key, iv, mode = 'CBC') {
  const config = {};
  if (iv) config.iv = utf8WordArray(iv);
  config.mode = CryptoJS.mode[String(mode).toUpperCase()] ?? CryptoJS.mode.CBC;
  const output = CryptoJS.TripleDES.decrypt(data, utf8WordArray(key), config).toString(CryptoJS.enc.Utf8);
  if (!output) {
    throw new Error('解密结果为空，可能是密钥或IV错误');
  }
  return output;
}

export function hmac(data, key, algorithm = 'SHA256') {
  const keyValue = utf8WordArray(key);
  switch (String(algorithm).toUpperCase()) {
    case 'SHA1':
      return CryptoJS.HmacSHA1(data, keyValue).toString();
    case 'SHA256':
      return CryptoJS.HmacSHA256(data, keyValue).toString();
    case 'SHA512':
      return CryptoJS.HmacSHA512(data, keyValue).toString();
    case 'MD5':
      return CryptoJS.HmacMD5(data, keyValue).toString();
    case 'SM3':
      return sm3(`${key}${data}`);
    default:
      throw new Error(`不支持的HMAC算法: ${algorithm}`);
  }
}

export { sm2 };
