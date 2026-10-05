// Versioned graph encoding for recovery archives, independent of the vault schema.
// Unsupported structured-clone types fail explicitly rather than becoming {}.
function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}

function unbase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)).buffer;
}

export async function encodeRecoveryValue(value) {
  const nodes = [];
  const seen = new Map();
  async function encode(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'undefined') return { special: 'undefined' };
    if (typeof item === 'bigint') return { special: 'bigint', value: String(item) };
    if (typeof item === 'number')
      return Number.isFinite(item) && !Object.is(item, -0)
        ? item
        : { special: 'number', value: Object.is(item, -0) ? '-0' : String(item) };
    if (typeof item !== 'object')
      throw new Error(`Cannot archive source type ${typeof item}. Stored data is unchanged.`);
    if (seen.has(item)) return { ref: seen.get(item) };
    const ref = nodes.length;
    seen.set(item, ref);
    /** @type {{type:string, data:any}} */
    const node = { type: '', data: null };
    nodes.push(node);
    if (Array.isArray(item)) {
      node.type = 'array';
      node.data = { length: item.length, entries: [] };
      for (const [key, entry] of Object.entries(item)) node.data.entries.push([key, await encode(entry)]);
    } else if (item instanceof Date) {
      node.type = 'date';
      node.data = await encode(item.getTime());
    } else if (item instanceof RegExp) {
      node.type = 'regexp';
      node.data = { source: item.source, flags: item.flags, lastIndex: item.lastIndex };
    } else if (item instanceof ArrayBuffer) {
      node.type = 'buffer';
      node.data = base64(item);
    } else if (ArrayBuffer.isView(item)) {
      if (
        ![
          'DataView',
          'Int8Array',
          'Uint8Array',
          'Uint8ClampedArray',
          'Int16Array',
          'Uint16Array',
          'Int32Array',
          'Uint32Array',
          'Float32Array',
          'Float64Array',
          'BigInt64Array',
          'BigUint64Array',
        ].includes(item.constructor.name)
      )
        throw new Error('Cannot archive this binary view type. Stored data is unchanged.');
      node.type = 'view';
      node.data = {
        name: item.constructor.name,
        buffer: await encode(item.buffer),
        offset: item.byteOffset,
        bytes: item.byteLength,
      };
    } else if (item instanceof Blob) {
      node.type = typeof File !== 'undefined' && item instanceof File ? 'file' : 'blob';
      node.data = { bytes: base64(await item.arrayBuffer()), mime: item.type };
      if (typeof File !== 'undefined' && item instanceof File)
        Object.assign(node.data, { name: item.name, lastModified: item.lastModified });
    } else if (item instanceof Map || item instanceof Set) {
      node.type = item instanceof Map ? 'map' : 'set';
      node.data = [];
      for (const entry of item)
        node.data.push(node.type === 'map' ? [await encode(entry[0]), await encode(entry[1])] : await encode(entry));
    } else if (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null) {
      node.type = Object.getPrototypeOf(item) === null ? 'null-object' : 'object';
      node.data = [];
      for (const [key, entry] of Object.entries(item)) node.data.push([key, await encode(entry)]);
    } else
      throw new Error(`Cannot archive source type ${item.constructor?.name || 'unknown'}. Stored data is unchanged.`);
    return { ref };
  }
  return { encoding: 'structured-source-v1', root: await encode(value), nodes };
}

// Used by recovery tooling, not by portable backup import. Decoding never writes.
export function decodeRecoveryValue(encoded) {
  if (encoded?.encoding !== 'structured-source-v1' || !Array.isArray(encoded.nodes))
    throw new Error('Unsupported recovery source encoding.');
  const views = {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
  };
  const values = new Map();
  function decode(token) {
    if (token === null || typeof token !== 'object') return token;
    if (token.special === 'undefined') return undefined;
    if (token.special === 'bigint') return BigInt(token.value);
    if (token.special === 'number') return Number(token.value);
    const id = token.ref;
    if (!Number.isSafeInteger(id) || id < 0 || id >= encoded.nodes.length)
      throw new Error('Invalid archive reference.');
    if (values.has(id)) return values.get(id);
    const { type, data } = encoded.nodes[id];
    let value;
    if (type === 'object') value = {};
    else if (type === 'null-object') value = Object.create(null);
    else if (type === 'array') value = new Array(data.length);
    else if (type === 'map') value = new Map();
    else if (type === 'set') value = new Set();
    else if (type === 'date') value = new Date(decode(data));
    else if (type === 'regexp') {
      value = new RegExp(data.source, data.flags);
      value.lastIndex = data.lastIndex;
    } else if (type === 'buffer') value = unbase64(data);
    else if (type === 'view') {
      const buffer = decode(data.buffer);
      if (data.name === 'DataView') value = new DataView(buffer, data.offset, data.bytes);
      else {
        const View = Object.hasOwn(views, data.name) ? views[data.name] : null;
        if (!View) throw new Error('Unsupported archive array view.');
        value = new View(buffer, data.offset, data.bytes / View.BYTES_PER_ELEMENT);
      }
    } else if (type === 'blob') value = new Blob([unbase64(data.bytes)], { type: data.mime });
    else if (type === 'file')
      value = new File([unbase64(data.bytes)], data.name, { type: data.mime, lastModified: data.lastModified });
    else throw new Error('Unsupported archive node.');
    values.set(id, value);
    const entries = type === 'array' ? data.entries : data;
    if (type === 'object' || type === 'null-object' || type === 'array')
      for (const [key, entry] of entries)
        Object.defineProperty(value, key, {
          value: decode(entry),
          enumerable: true,
          writable: true,
          configurable: true,
        });
    else if (type === 'map') for (const [key, entry] of data) value.set(decode(key), decode(entry));
    else if (type === 'set') for (const entry of data) value.add(decode(entry));
    return value;
  }
  return decode(encoded.root);
}
