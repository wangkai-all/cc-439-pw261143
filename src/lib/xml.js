// A deliberately small, dependency-free XML reader.
//
// The intake pipeline receives XML from outside suppliers, so it must never
// expand DTD entities or resolve external resources. This reader treats the
// document as data: namespaces are collapsed onto local names, CDATA and text
// are decoded, and any DOCTYPE is refused outright (XXE / billion-laughs).
//
// It also records the raw character offsets of every leaf element so the
// parser can cite exactly which bytes a structured field came from.

export class XmlError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = 'XmlError';
    this.offset = offset;
  }
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const n = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) {
        throw new XmlError(`无效的字符引用 ${whole}`);
      }
      return String.fromCodePoint(n);
    }
    if (body in ENTITIES) return ENTITIES[body];
    // Unknown named entities are refused rather than silently kept: with no
    // DTD allowed there is no legitimate way for them to be defined.
    throw new XmlError(`未知实体 ${whole}`);
  });
}

const NAME_RE = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const ATTR_RE = /\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

/**
 * Parse an XML string into a tree of
 *   { name, local, attrs, children, text, start, end }
 * `start`/`end` are offsets of the element's inner content.
 */
export const MAX_DEPTH = 200;
export const MAX_XML_CHARS = 8 * 1024 * 1024;

export function parseXml(source) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new XmlError('文档为空', 0);
  }
  if (source.length > MAX_XML_CHARS) {
    throw new XmlError(`文档超过 ${MAX_XML_CHARS} 个字符上限`, 0);
  }

  const root = { name: '#document', local: '#document', attrs: {}, children: [], text: '', start: 0, end: 0 };
  const stack = [root];
  let i = 0;

  const fail = (msg) => {
    const line = source.slice(0, i).split('\n').length;
    throw new XmlError(`${msg}（第 ${line} 行）`, i);
  };

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      const tail = source.slice(i);
      if (stack.length > 1) {
        throw new XmlError(`元素 <${stack[stack.length - 1].name}> 未闭合`, source.length);
      }
      if (tail.trim()) fail('文档结束后存在多余文本');
      break;
    }
    if (lt > i) {
      const text = decodeEntities(source.slice(i, lt));
      stack[stack.length - 1].children.push({ name: '#text', local: '#text', attrs: {}, children: [], text, start: i, end: lt });
    }
    i = lt;

    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end === -1) fail('注释未闭合');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      if (end === -1) fail('CDATA 段未闭合');
      stack[stack.length - 1].children.push({
        name: '#text', local: '#text', attrs: {}, children: [],
        text: source.slice(i + 9, end), start: i + 9, end,
      });
      i = end + 3;
      continue;
    }
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      if (end === -1) fail('处理指令未闭合');
      i = end + 2;
      continue;
    }
    if (source.startsWith('<!', i)) {
      if (/^<!doctype/i.test(source.slice(i, i + 9))) {
        fail('不允许 DOCTYPE');
      }
      fail('不支持的标记声明');
    }

    if (source[i + 1] === '/') {
      i += 2;
      NAME_RE.lastIndex = i;
      const m = NAME_RE.exec(source);
      if (!m) fail('结束标签格式错误');
      const name = m[0];
      i = NAME_RE.lastIndex;
      while (i < source.length && /\s/.test(source[i])) i += 1;
      if (source[i] !== '>') fail('结束标签格式错误');
      i += 1;
      const open = stack.pop();
      if (!open || open === root) fail(`意外的结束标签 </${name}>`);
      if (open.name !== name) fail(`结束标签 </${name}> 与 <${open.name}> 不匹配`);
      open.end = lt;
      continue;
    }

    i += 1;
    NAME_RE.lastIndex = i;
    const m = NAME_RE.exec(source);
    if (!m) fail('开始标签格式错误');
    const name = m[0];
    i = NAME_RE.lastIndex;
    const attrs = {};
    let selfClosing = false;
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) i += 1;
      if (i >= source.length) fail('开始标签未闭合');
      if (source[i] === '>') { i += 1; break; }
      if (source[i] === '/' && source[i + 1] === '>') { i += 2; selfClosing = true; break; }
      ATTR_RE.lastIndex = i;
      const a = ATTR_RE.exec(source);
      if (!a) fail('属性格式错误');
      const key = a[1];
      if (key in attrs) fail(`重复的属性 ${key}`);
      attrs[key] = decodeEntities(a[2] ?? a[3] ?? '');
      i = ATTR_RE.lastIndex;
    }
    const local = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
    if (stack.length > MAX_DEPTH) {
      throw new XmlError(`元素嵌套超过 ${MAX_DEPTH} 层`, i);
    }
    const node = { name, local, attrs, children: [], text: '', start: i, end: i };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    else node.end = i;
  }

  if (stack.length !== 1) {
    const open = stack[stack.length - 1];
    throw new XmlError(`元素 <${open.name}> 未闭合`, source.length);
  }
  const elements = root.children.filter((c) => c.name !== '#text');
  if (elements.length !== 1) {
    throw new XmlError('文档必须恰好有一个根元素', 0);
  }
  const doc = elements[0];
  materializeText(doc);
  return doc;
}

function materializeText(root) {
  // Post-order without recursion: depth is already capped, but an explicit
  // stack keeps this robust if the cap changes.
  const stack = [{ node: root, index: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const { node } = frame;
    if (frame.index === 0 && node.children.length === 0) {
      node.text = '';
      stack.pop();
      continue;
    }
    if (frame.index < node.children.length) {
      const child = node.children[frame.index];
      frame.index += 1;
      if (child.name !== '#text') stack.push({ node: child, index: 0 });
      continue;
    }
    // Every child has been materialized by the time its parent reaches here.
    node.text = node.children.map((c) => c.text).join('');
    stack.pop();
  }
}

/** Direct child elements, optionally filtered by local name. */
export function children(node, localName) {
  if (!node) return [];
  const els = node.children.filter((c) => c.name !== '#text');
  return localName === undefined ? els : els.filter((c) => c.local === localName);
}

/** Depth-first search by local name (namespace prefixes ignored). */
export function findAll(node, localName, acc = []) {
  if (!node) return acc;
  const stack = [...node.children].reverse();
  while (stack.length) {
    const current = stack.pop();
    if (current.name === '#text') continue;
    if (current.local === localName) acc.push(current);
    for (let i = current.children.length - 1; i >= 0; i -= 1) stack.push(current.children[i]);
  }
  return acc;
}

export function findFirst(node, localName) {
  return findAll(node, localName, [])[0] ?? null;
}

/** Text of the first descendant with the given local name, or null. */
export function textOf(node, localName) {
  const el = findFirst(node, localName);
  if (!el) return null;
  const t = el.text.trim();
  return t === '' ? null : t;
}

/** Path of local names from root to the given node, e.g. "Invoice.Lines.Line". */
export function pathOf(root, target) {
  const stack = [{ node: root, trail: [] }];
  while (stack.length) {
    const { node, trail } = stack.pop();
    const next = [...trail, node.local];
    if (node === target) return next.join('.');
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i];
      if (child.name !== '#text') stack.push({ node: child, trail: next });
    }
  }
  return '';
}
