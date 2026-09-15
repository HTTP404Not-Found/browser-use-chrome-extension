// lib/images.js
// Image helpers shared by the service worker and the side panel. Everything
// works on Blobs and bitmaps: fetch() of a data: URL is blocked by the
// extension CSP (connect-src), and the service worker has no DOM.

/** Decode a base64 data: URL into a Blob. */
export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  const mime = /data:([^;,]+)/.exec(head)?.[1] || 'application/octet-stream';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Encode a Blob as a base64 data: URL. */
export async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

/**
 * Downscale a bitmap so its longer side is at most `maxSide` and encode it
 * as JPEG. Large screenshots and photos cost many more image tokens without
 * helping the model read them.
 */
export async function encodeScaled(bitmap, maxSide, quality = 0.8) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  // JPEG has no alpha; paint transparent images onto white instead of black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { dataUrl: await blobToDataUrl(blob), width, height };
}
