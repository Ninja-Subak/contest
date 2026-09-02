export default async function handler(req, res) {
  // CORS 헤더 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url, stream } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    // 1. 수노 웹페이지 요청 (데스크톱 User-Agent로 리다이렉트 추적)
    const sunoRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow'
    });

    const html = await sunoRes.text();

    // 2. 곡 고유 UUID 추출 (canonical link, JSON 데이터, 또는 URL 자체)
    const idMatch = html.match(/suno\.com\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ||
                    html.match(/"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i) ||
                    targetUrl.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);

    const songId = idMatch ? idMatch[1] : null;

    if (!songId) {
      return res.status(404).json({ error: 'Suno 곡 ID(UUID)를 찾을 수 없습니다.' });
    }

    // 3. 실제 CloudFront m4a 스트리밍 주소 추출
    const m4aMatch = html.match(/https:\\?\/\\?\/[a-z0-9]+\.cloudfront\.net\\?\/1\\?\/clip\\?\/[0-9a-f-]+\.m4a/i);
    const audioUrl = m4aMatch ? m4aMatch[0].replace(/\\/g, '') : `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${songId}.m4a`;
    const cdnUrl = `https://cdn1.suno.ai/${songId}.mp3`;
    const embedUrl = `https://suno.com/embed/${songId}`;

    // 4. 곡 제목 추출
    const titleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                       html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/ \| Suno$/i, '').trim() : '';

    // 5. 앨범 커버 이미지 추출
    const imgMatch = html.match(/https:\\?\/\\?\/cdn2\.suno\.ai\\?\/image_large_[0-9a-f-]+\.jpeg/i) ||
                     html.match(/https:\\?\/\\?\/cdn2\.suno\.ai\\?\/image_[0-9a-f-]+\.jpeg/i);
    const coverUrl = imgMatch ? imgMatch[0].replace(/\\/g, '') : `https://cdn2.suno.ai/image_large_${songId}.jpeg`;

    // 5.5 음악 장르 / 스타일 태그 추출 (JSON 메타데이터 유출 차단)
    const tagMatch = html.match(/\\*"tags\\*"\s*:\s*\\*"([^"\\{}:]+?)\\*"/i) ||
                     html.match(/\\*"display_tags\\*"\s*:\s*\\*"([^"\\{}:]+?)\\*"/i);
    let genre = tagMatch ? tagMatch[1].replace(/\\"/g, '"').trim() : '';
    if (genre.includes(':') || genre.includes('{') || genre.includes('"')) {
      genre = genre.split(/[:{"']/)[0].trim();
    }

    // 6. 가사 (Prompt) 정밀 추출 및 메타데이터 아티팩트 정제
    let lyrics = '';
    const promptRefMatch = html.match(/\\?"prompt\\?"\s*:\s*\\?"\$([a-zA-Z0-9]+)\\?"/);
    if (promptRefMatch) {
      const chunkId = promptRefMatch[1];
      const needle = `${chunkId}:T`;
      const startIdx = html.indexOf(needle);
      if (startIdx !== -1) {
        const commaIdx = html.indexOf(',', startIdx);
        if (commaIdx !== -1) {
          const slice = html.slice(commaIdx + 1, commaIdx + 6000);
          const nextChunk = slice.search(/[0-9a-zA-Z]+:(\[|"|T)/);
          lyrics = nextChunk !== -1 ? slice.slice(0, nextChunk) : slice;
        }
      }
    }

    if (!lyrics) {
      const directMatch = html.match(/\\?"prompt\\?"\s*:\s*\\?"([^"\\]*(?:\\.[^"\\]*)*)\\?"/);
      if (directMatch && !directMatch[1].startsWith('$') && directMatch[1].length > 10) {
        lyrics = directMatch[1];
      }
    }

    // 🧹 가사 후처리: JSON 태그, 메타데이터 아티팩트 및 백슬래시(\) 완전 제거
    if (lyrics) {
      // 1. JSON 메타데이터 꼬리표 (예: ","edited_clip_id":... 등) 제거
      const artifactMatch = lyrics.match(/",\s*"?\w+"?\s*:/);
      if (artifactMatch) {
        lyrics = lyrics.slice(0, artifactMatch.index);
      }
      const bracketMatch = lyrics.match(/"]\s*[,\]\}]/);
      if (bracketMatch) {
        lyrics = lyrics.slice(0, bracketMatch.index);
      }
      const htmlMetaMatch = lyrics.match(/\["\$","meta"/);
      if (htmlMetaMatch) {
        lyrics = lyrics.slice(0, htmlMetaMatch.index);
      }

      // 2. 줄바꿈 정돈 및 끝부분 불필요한 백슬래시(\) 제거
      lyrics = lyrics
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\+(\r?\n)/g, '$1')
        .replace(/\\+$/g, '')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/^"+|"+$/g, '')
        .trim();
    }

    // 7. stream 파라미터가 있는 경우 오디오 프록시 스트리밍
    if (stream) {
      const audioRes = await fetch(audioUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      });
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const arrayBuffer = await audioRes.arrayBuffer();
      return res.status(200).send(Buffer.from(arrayBuffer));
    }

    return res.status(200).json({
      success: true,
      songId,
      audioUrl,
      cdnUrl,
      embedUrl,
      title,
      coverUrl,
      lyrics,
      genre
    });
  } catch (err) {
    console.error('Error resolving Suno link:', err);
    return res.status(500).json({ error: err.message || '음원 주소 변환 중 오류가 발생했습니다.' });
  }
}
