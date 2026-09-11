// Suno audio decryption & streaming serverless function
// Supports HTTP Range requests (206 Partial Content) for seamless audio playback

const rightsCache = new Map();

async function getRights(clipId) {
  if (rightsCache.has(clipId)) {
    const cached = rightsCache.get(clipId);
    if (Date.now() - cached.timestamp < 30 * 60 * 1000) {
      return cached;
    }
  }

  const rightsRes = await fetch('https://studio-api-prod.suno.com/api/mango/rights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ content_params: { content_id: clipId, content_type: 'clip' } })
  });

  if (!rightsRes.ok) {
    throw new Error('Suno rights fetch failed: ' + rightsRes.status);
  }
  const rights = await rightsRes.json();

  const gltBytes = new TextEncoder().encode(rights.glt);
  const userKeyHash = await crypto.subtle.digest('SHA-256', gltBytes);
  const userKey = await crypto.subtle.importKey('raw', userKeyHash, { name: 'AES-GCM' }, false, ['decrypt']);

  const toWrappedKey = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const wrappedKey = toWrappedKey(rights.key);
  const wrappedIv = toWrappedKey(rights.iv);

  const rawKey = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: wrappedKey.slice(0, 12), additionalData: new TextEncoder().encode(clipId) },
    userKey,
    wrappedKey.slice(12)
  );
  const aesCtrKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CTR' }, false, ['decrypt']);

  const iv = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: wrappedIv.slice(0, 12), additionalData: new TextEncoder().encode(clipId) },
      userKey,
      wrappedIv.slice(12)
    )
  );

  const mediaUrl = 'https://d2lwuy8qc234o3.cloudfront.net/1/clip/' + clipId + '.m4a';
  const probeRes = await fetch(mediaUrl, {
    headers: { Range: 'bytes=0-0', 'User-Agent': 'Mozilla/5.0' }
  });
  const cr = probeRes.headers.get('content-range') || '';
  const crMatch = cr.match(/\/(\d+)$/);
  const totalLength = crMatch ? parseInt(crMatch[1], 10) : 0;

  const info = { aesCtrKey, iv, totalLength, mediaUrl, timestamp: Date.now() };
  rightsCache.set(clipId, info);
  return info;
}

function incrementCounter(baseIv, blockOffset) {
  const r = new Uint8Array(16);
  r.set(baseIv);
  if (blockOffset === 0) return r;
  let n = BigInt(0);
  for (let e = 0; e < 16; e++) n = (n << BigInt(8)) | BigInt(r[e]);
  n += BigInt(blockOffset);
  for (let e = 15; e >= 0; e--) {
    r[e] = Number(n & BigInt(255));
    n >>= BigInt(8);
  }
  return r;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { songId, url } = req.query;
  let clipId = songId;
  if (!clipId && url) {
    const m = String(url).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m) clipId = m[1];
  }

  if (!clipId) {
    return res.status(400).json({ error: 'Missing songId or valid url parameter' });
  }

  try {
    const { aesCtrKey, iv, totalLength, mediaUrl } = await getRights(clipId);

    const rangeHeader = req.headers.range;
    if (rangeHeader && totalLength > 0) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
      if (!match) {
        res.setHeader('Content-Range', 'bytes */' + totalLength);
        return res.status(416).end();
      }

      const reqStart = parseInt(match[1], 10);
      let reqEnd = match[2] ? parseInt(match[2], 10) : (totalLength - 1);
      if (reqEnd >= totalLength) reqEnd = totalLength - 1;

      const MAX_CHUNK = 2 * 1024 * 1024;
      if (reqEnd - reqStart + 1 > MAX_CHUNK) {
        reqEnd = reqStart + MAX_CHUNK - 1;
      }

      const blockOffset = Math.floor(reqStart / 16);
      const leadTrim = reqStart % 16;
      const cipherStart = blockOffset * 16;
      const cipherEnd = reqEnd;

      const mediaRes = await fetch(mediaUrl, {
        headers: { Range: 'bytes=' + cipherStart + '-' + cipherEnd, 'User-Agent': 'Mozilla/5.0' }
      });
      const encChunk = new Uint8Array(await mediaRes.arrayBuffer());

      const counter = incrementCounter(iv, blockOffset);
      const decChunk = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-CTR', counter, length: 128 },
        aesCtrKey,
        encChunk
      ));

      const finalChunk = Buffer.from(decChunk.slice(leadTrim, leadTrim + (reqEnd - reqStart + 1)));

      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Range', 'bytes ' + reqStart + '-' + reqEnd + '/' + totalLength);
      res.setHeader('Content-Length', finalChunk.length);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(206).send(finalChunk);
    } else {
      const endByte = totalLength > 0 ? Math.min(2 * 1024 * 1024 - 1, totalLength - 1) : 1024 * 1024 - 1;
      const mediaRes = await fetch(mediaUrl, {
        headers: { Range: 'bytes=0-' + endByte, 'User-Agent': 'Mozilla/5.0' }
      });
      const encChunk = new Uint8Array(await mediaRes.arrayBuffer());
      const decChunk = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-CTR', counter: iv, length: 128 },
        aesCtrKey,
        encChunk
      ));

      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      if (totalLength > 0) {
        res.setHeader('Content-Range', 'bytes 0-' + (decChunk.length - 1) + '/' + totalLength);
      }
      res.setHeader('Content-Length', decChunk.length);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).send(Buffer.from(decChunk));
    }
  } catch (err) {
    console.error('Error streaming Suno audio:', err);
    try {
      const cdnUrl = 'https://cdn1.suno.ai/' + clipId + '.mp3';
      return res.redirect(302, cdnUrl);
    } catch(e) {
      return res.status(500).json({ error: err.message || '음원 스트리밍 중 오류가 발생했습니다.' });
    }
  }
}
