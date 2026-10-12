// Machine lines the skills parse: `key=value` fields joined by single spaces, in exactly the order the caller lists them.

// `k1=v1 k2=v2` from [key, value] pairs; the pair order is the key order.
export function machineLine(pairs) {
  return pairs.map(([key, value]) => `${key}=${value}`).join(' ');
}

// A line read by people and parsed by the skills: the text, then its fields.
export function withFields(text, pairs) {
  return `${text} ${machineLine(pairs)}`;
}
