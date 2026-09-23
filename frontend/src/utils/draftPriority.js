// A draft keeps its priority in its own headers (X-Priority, the one nodemailer writes, and
// Importance), so reopening it in the composer restores what was chosen. Pure: runs under
// `node --test`.

// 'high' | 'normal' | 'low' from a raw header block. A draft without either header was saved as
// normal priority (the composer writes the header only for high and low).
export function priorityFromHeaders(rawHeaders) {
  const text = String(rawHeaders ?? '');
  const xPriority = text.match(/^X-Priority:\s*([1-5])/mi);
  if (xPriority) {
    const n = Number(xPriority[1]);
    return n <= 2 ? 'high' : n >= 4 ? 'low' : 'normal';
  }
  const importance = text.match(/^Importance:\s*(high|normal|low)\b/mi);
  if (importance) return importance[1].toLowerCase();
  return 'normal';
}
