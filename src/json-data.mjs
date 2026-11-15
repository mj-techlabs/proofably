// JSON data only: reject accessors/classes/cycles; preserve -0 in text round trips.
export function isJsonData(value, ancestors = new Set(), depth = 0) {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return false;
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
  }
  return Reflect.ownKeys(value).every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value') &&
      isJsonData(descriptor.value, next, depth + 1);
  });
}

export function stringifyJson(value, pretty = false) {
  if (!isJsonData(value)) throw new TypeError('Expected JSON data (maximum depth 64)');
  function encode(item, depth) {
    if (Object.is(item, -0)) return '-0';
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    const array = Array.isArray(item);
    const entries = array ? item.map(v => encode(v, depth + 1)) :
      Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${pretty ? ' ' : ''}${encode(item[key], depth + 1)}`);
    const [open, close] = array ? ['[', ']'] : ['{', '}'];
    if (!entries.length) return open + close;
    return pretty ? `${open}\n${'  '.repeat(depth + 1)}${entries.join(`,\n${'  '.repeat(depth + 1)}`)}\n${'  '.repeat(depth)}${close}` :
      open + entries.join(',') + close;
  }
  return encode(value, 0);
}

export function boundedText(value, maximum) {
  return new TextDecoder().decode(Buffer.from(String(value)).subarray(0, maximum), { stream: true });
}
