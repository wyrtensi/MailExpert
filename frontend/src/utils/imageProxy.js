// Keep proxy URLs inside the composer; restore originals only at send/save boundaries.
// Both relative and absolute URLs occur: clipboard HTML may include the panel origin.
const PROXIED = /(?:https?:\/\/[^\s"'<>()/]+)?\/api\/mail\/messages\/[0-9a-f-]{36}\/image\/\d+\.[A-Za-z0-9_-]+\?u=([A-Za-z0-9%._~-]*)(?:(?:&amp;|&)allow=1)?/gi;

export function unproxyImages(html) {
  if (!html) return html;
  return html.replace(PROXIED, (match, encoded) => {
    try { return decodeURIComponent(encoded); } catch { return match; }
  });
}

export function outgoingImagePayload(data) {
  return {
    ...data,
    ...(data.bodyIsHtml && typeof data.body === 'string' ? { body: unproxyImages(data.body) } : {}),
    ...(typeof data.quotedBodyHtml === 'string' ? { quotedBodyHtml: unproxyImages(data.quotedBodyHtml) } : {}),
    ...(typeof data.editedSignature === 'string' ? { editedSignature: unproxyImages(data.editedSignature) } : {}),
  };
}
