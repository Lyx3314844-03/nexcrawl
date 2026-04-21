/**
 * XPath extractor — evaluates XPath expressions against HTML/XML using jsdom.
 *
 * Supports:
 *   - Single value extraction (first match)
 *   - Multi-value extraction (all matches, rule.all = true)
 *   - Attribute extraction via XPath (e.g. //a/@href)
 *   - Text content extraction
 */

import { JSDOM } from 'jsdom';

/**
 * Resolve the string value of an XPath result node.
 * @param {XPathResult} result
 * @returns {string|null}
 */
function nodeValue(node) {
  if (!node) return null;
  // Attribute node
  if (node.nodeType === 2) return node.value;
  // Text node
  if (node.nodeType === 3) return node.nodeValue;
  // Element node — return textContent
  return node.textContent ?? null;
}

/**
 * Evaluate an XPath expression against an HTML/XML string.
 *
 * @param {string} body - Raw HTML or XML string
 * @param {Object} rule - Extraction rule
 * @param {string} rule.expression - XPath expression
 * @param {boolean} [rule.all] - Return all matches as array
 * @param {string} [rule.attribute] - Attribute name to extract (alternative to XPath attr axis)
 * @param {number} [rule.maxItems] - Max items when all=true
 * @param {boolean} [rule.xml] - Parse as XML (default: false, parse as HTML)
 * @returns {string|string[]|null}
 */
export function evaluateXPath(body, rule) {
  const expression = rule.expression ?? rule.xpath ?? '';
  if (!expression) return null;

  const isXml = rule.xml === true;
  const dom = isXml
    ? new JSDOM(body, { contentType: 'application/xml' })
    : new JSDOM(body, { contentType: 'text/html' });

  const doc = dom.window.document;
  const xpathResult = doc.evaluate(
    expression,
    doc,
    null,
    dom.window.XPathResult.ANY_TYPE,
    null,
  );

  const resultType = xpathResult.resultType;
  const XPathResult = dom.window.XPathResult;

  // Scalar results
  if (resultType === XPathResult.STRING_TYPE) return xpathResult.stringValue;
  if (resultType === XPathResult.NUMBER_TYPE) return String(xpathResult.numberValue);
  if (resultType === XPathResult.BOOLEAN_TYPE) return String(xpathResult.booleanValue);

  // Node results
  if (rule.all) {
    const maxItems = rule.maxItems ?? 100;
    const values = [];
    let node = xpathResult.iterateNext();
    while (node && values.length < maxItems) {
      const raw = rule.attribute
        ? node.getAttribute?.(rule.attribute) ?? null
        : nodeValue(node);
      if (raw !== null) values.push(raw.trim());
      node = xpathResult.iterateNext();
    }
    return values;
  }

  const first = xpathResult.iterateNext();
  if (!first) return null;
  const raw = rule.attribute ? first.getAttribute?.(rule.attribute) ?? null : nodeValue(first);
  return raw !== null ? raw.trim() : null;
}
