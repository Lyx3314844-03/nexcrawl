// Debug: test enforceIdentityConsistency logic directly
function getHeaderValue(headers = {}, name) {
  const target = String(name ?? '').toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (String(key).toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function buildIdentityHttpHeaders(identity = {}) {
  return {
    'user-agent': identity.userAgent,
    'accept-language': identity.acceptLanguage,
  };
}

const identity = { enabled: true, userAgent: 'ExpectedUA/1.0', acceptLanguage: 'zh-CN,zh' };
const headers = { 'user-agent': 'BadUA/0.1', 'accept-language': 'en-US' };

const identityHeaders = buildIdentityHttpHeaders(identity);
console.log('identityHeaders:', identityHeaders);

for (const [headerName, expectedValue] of Object.entries(identityHeaders)) {
  if (!expectedValue) continue;
  const actualValue = getHeaderValue(headers, headerName);
  console.log(`${headerName}: expected="${expectedValue}", actual="${actualValue}"`);
  if (actualValue !== undefined && String(actualValue) !== String(expectedValue)) {
    console.log(`  -> DRIFT detected`);
  }
}
