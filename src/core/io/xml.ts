/**
 * A small XML reader. SVG import needs to run in unit tests and in the main
 * process as well as the browser, so the DOM's parser is not an option.
 */

export type XmlNode = {
  name: string;
  /** Attribute names keep any namespace prefix except a leading `svg:`. */
  attributes: Record<string, string>;
  children: XmlNode[];
  /** Concatenated text content directly inside this element. */
  text: string;
};

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

export function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const NAME_CHAR = /[A-Za-z0-9_.:\-]/;

/** Strips a namespace prefix, so `svg:path` and `path` both parse as `path`. */
function localName(name: string): string {
  const colon = name.indexOf(':');
  if (colon < 0) return name;
  const prefix = name.slice(0, colon);
  // `xlink:href` and `xml:space` carry meaning in their prefix; keep those.
  if (prefix === 'xlink' || prefix === 'xml' || prefix === 'xmlns') return name;
  return name.slice(colon + 1);
}

/**
 * Parses an XML document and returns its root element, or null if there is
 * none. Processing instructions, comments and DOCTYPE declarations are skipped.
 */
export function parseXml(source: string): XmlNode | null {
  let i = 0;
  const n = source.length;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;

  const skipWhitespace = () => {
    while (i < n && /\s/.test(source[i])) i++;
  };

  const readName = (): string => {
    const start = i;
    while (i < n && NAME_CHAR.test(source[i])) i++;
    return source.slice(start, i);
  };

  const appendText = (raw: string) => {
    const parent = stack[stack.length - 1];
    if (!parent) return;
    const decoded = decodeEntities(raw);
    if (decoded.length > 0) parent.text += decoded;
  };

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      appendText(source.slice(i));
      break;
    }
    if (lt > i) appendText(source.slice(i, lt));
    i = lt + 1;

    if (source.startsWith('!--', i)) {
      const end = source.indexOf('-->', i);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (source.startsWith('![CDATA[', i)) {
      const end = source.indexOf(']]>', i);
      const body = source.slice(i + 8, end < 0 ? n : end);
      const parent = stack[stack.length - 1];
      if (parent) parent.text += body;
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (source[i] === '?' || source[i] === '!') {
      // Processing instruction or DOCTYPE: skip to the matching '>'.
      let depth = 0;
      while (i < n) {
        const ch = source[i];
        if (ch === '<') depth++;
        else if (ch === '>') {
          if (depth === 0) {
            i++;
            break;
          }
          depth--;
        }
        i++;
      }
      continue;
    }

    if (source[i] === '/') {
      i++;
      readName();
      const close = source.indexOf('>', i);
      i = close < 0 ? n : close + 1;
      const finished = stack.pop();
      if (finished && stack.length === 0) root = root ?? finished;
      continue;
    }

    const name = localName(readName());
    const element: XmlNode = { name, attributes: {}, children: [], text: '' };

    // Attributes.
    while (i < n) {
      skipWhitespace();
      if (i >= n || source[i] === '>' || source[i] === '/') break;
      const attributeName = localName(readName());
      if (attributeName.length === 0) {
        i++; // Unexpected character: skip it rather than loop forever.
        continue;
      }
      skipWhitespace();
      let value = '';
      if (source[i] === '=') {
        i++;
        skipWhitespace();
        const quote = source[i];
        if (quote === '"' || quote === "'") {
          i++;
          const end = source.indexOf(quote, i);
          value = source.slice(i, end < 0 ? n : end);
          i = end < 0 ? n : end + 1;
        } else {
          const start = i;
          while (i < n && !/[\s>]/.test(source[i])) i++;
          value = source.slice(start, i);
        }
      }
      element.attributes[attributeName] = decodeEntities(value);
    }

    const selfClosing = source[i] === '/';
    if (selfClosing) i++;
    if (source[i] === '>') i++;

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    if (selfClosing) {
      if (!parent) root = root ?? element;
    } else {
      stack.push(element);
      if (stack.length === 1) root = root ?? element;
    }
  }

  return root ?? stack[0] ?? null;
}

/** Direct children with the given tag name. */
export const childrenNamed = (node: XmlNode, name: string): XmlNode[] =>
  node.children.filter((c) => c.name === name);

/** Depth-first search for every descendant with the given tag name. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const result: XmlNode[] = [];
  const recurse = (current: XmlNode) => {
    if (current.name === name) result.push(current);
    for (const child of current.children) recurse(child);
  };
  recurse(node);
  return result;
}

export type XmlAttributes = Record<string, string | number | undefined | null>;

/** Serializes one element. `children` is inserted verbatim. */
export function element(name: string, attributes: XmlAttributes, children?: string): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}="${escapeXml(String(value))}"`);
  }
  const head = parts.length > 0 ? `${name} ${parts.join(' ')}` : name;
  if (children === undefined || children === '') return `<${head}/>`;
  return `<${head}>${children}</${name}>`;
}
