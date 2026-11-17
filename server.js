const express = require('express');
const path = require('path');
const cors = require('cors');
const ytdlpExec = require('yt-dlp-exec');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Smart log filter to keep the terminal clean
function cleanLog(prefix, data) {
  const msg = data ? data.toString() : '';
  msg.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (
      trimmed.includes('frame=') ||
      trimmed.includes('% of') ||
      trimmed.includes('ETA') ||
      trimmed.includes('speed=') ||
      trimmed.includes('bitrate=') ||
      trimmed.includes('size=') ||
      trimmed.includes('fps=') ||
      trimmed.startsWith('Input #') ||
      trimmed.startsWith('Output #') ||
      trimmed.startsWith('Stream mapping') ||
      trimmed.includes('muxed as a private data stream') ||
      trimmed.includes('Press [q] to stop')
    ) {
      return;
    }
    console.log(`${prefix} ${trimmed}`);
  });
}

function extractYouTubeId(url) {
  try {
    const parsed = new URL(url.trim());
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.slice(1).split('/')[0];
    }
    if (parsed.searchParams.get('v')) {
      return parsed.searchParams.get('v');
    }
    if (parsed.pathname.includes('/shorts/') || parsed.pathname.includes('/embed/')) {
      const parts = parsed.pathname.split('/');
      return parts[parts.indexOf(parsed.pathname.includes('/shorts/') ? 'shorts' : 'embed') + 1];
    }
  } catch (e) {
    const regExp = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
    const match = url.match(regExp);
    return match ? match[1] : null;
  }
  return null;
}

// ==========================================
// 1. YOUTUBE INFO ENDPOINT
// ==========================================
app.post('/api/youtube/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const videoId = extractYouTubeId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  try {
    const fetch = (await import('node-fetch')).default || global.fetch;
    const oembedRes = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
    const oembed = await oembedRes.json();

    res.json({
      title: oembed.title || `YouTube Video (${videoId})`,
      uploader: oembed.author_name || 'YouTube Creator',
      duration: '',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      formats: []
    });
  } catch (err) {
    cleanLog('[YouTube Info Error]', err);
    res.status(500).json({ error: 'Failed to fetch video metadata' });
  }
});

// ==========================================
// 2. YOUTUBE DOWNLOAD & MUXING ENDPOINT
// ==========================================
app.get('/api/download-muxed', async (req, res) => {
  const { url, height = '720', type = 'video', abr = '192', title = 'video' } = req.query;
  if (!url) return res.status(400).send('URL is required');

  const safeTitle = title.replace(/[\/\\?%*:|"<>]/g, '').trim();
  const ext = type === 'audio' ? 'mp3' : 'mp4';
  const filename = `${safeTitle}_${type === 'audio' ? abr + 'kbps' : height + 'p'}.${ext}`;

  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');

  try {
    // Force multiple client types (web, ios, android) to bypass 429/403 blocks on datacenter IPs
    const flags = type === 'audio' ? {
      format: 'bestaudio',
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: `${abr}K`,
      output: '-',
      noCheckCertificates: true,
      forceIpv4: true,
      extractorArgs: 'youtube:player_client=web,ios'
    } : {
      format: `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best/best`,
      mergeOutputFormat: 'mp4',
      output: '-',
      noCheckCertificates: true,
      forceIpv4: true,
      extractorArgs: 'youtube:player_client=web,ios'
    };

    const subprocess = ytdlpExec.exec(url, flags);
    subprocess.stdout.pipe(res);

    subprocess.stderr.on('data', (err) => {
      cleanLog('[Download log]', err);
    });

    req.on('close', () => {
      try { subprocess.kill(); } catch (_) {}
    });
  } catch (err) {
    cleanLog('[Download Error]', err);
    if (!res.headersSent) {
      res.status(500).send('Download failed due to server restrictions.');
    }
  }
});

// ==========================================
// 3. INSTAGRAM ENDPOINTS
// ==========================================
app.post('/api/instagram/batch', async (req, res) => {
  const { urls } = req.body;
  if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'URLs array required' });

  const items = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const match = url.match(/instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
    const shortcode = match ? match[1] : `Reel_${i + 1}`;

    let caption = `Instagram_Reel_${shortcode}`;
    try {
      const info = await ytdlpExec(url, {
        dumpJson: true,
        noPlaylist: true,
        forceIpv4: true,
        noCheckCertificates: true
      });
      if (info.title || info.description) {
        caption = (info.title || info.description).split('\n')[0];
      }
    } catch (e) {
      console.log(`[Instagram Notice]: Using default shortcode name for ${shortcode}`);
    }

    items.push({
      url,
      shortcode,
      title: caption,
      directDownloadUrl: `/api/instagram/download?url=${encodeURIComponent(url)}&title=${encodeURIComponent(caption)}`
    });
  }

  res.json({ items });
});

app.get('/api/instagram/download', (req, res) => {
  const { url, title = 'Instagram_Reel' } = req.query;
  if (!url) return res.status(400).send('URL required');

  const safeTitle = title.replace(/[\/\\?%*:|"<>]/g, '').trim();
  const filename = `${safeTitle}.mp4`;

  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Type', 'video/mp4');

  const subprocess = ytdlpExec.exec(url, {
    noCheckCertificates: true,
    forceIpv4: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    extractorArgs: 'instagram:api_hostname=i.instagram.com',
    format: 'best[ext=mp4]/bestvideo+bestaudio/best',
    mergeOutputFormat: 'mp4',
    output: '-'
  });

  subprocess.stdout.pipe(res);

  subprocess.stderr.on('data', (err) => {
    cleanLog('[Instagram Error]', err);
  });

  req.on('close', () => {
    try { subprocess.kill(); } catch (_) {}
  });
});

app.listen(PORT, () => {
  console.log(`🚀 OmniSave Pro Backend running live at http://localhost:${PORT}`);
});
