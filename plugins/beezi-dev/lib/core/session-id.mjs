// Owns the one session-id validator every path helper relies on.
const RESERVED = ['null', 'undefined', 'NaN', 'true', 'false'];
// Win32 device names alias a device whatever extension follows them (`nul.x`), in any case.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

// The only session-id validator. The character class already excludes '/', '\' and NUL; '..' is refused explicitly,
// and so are a trailing '.' (Win32 strips it, aliasing `<id>.` to `<id>`) and Windows device names.
export function isUsableSessionId(id) {
  return typeof id === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
    && id.indexOf('..') === -1
    && id[id.length - 1] !== '.'
    && !WINDOWS_DEVICE.test(id)
    && RESERVED.indexOf(id) === -1;
}
