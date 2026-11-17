const express = require('express');
const { spawn, execSync } = require('child_process');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname))); // Serves index.html automatically!

// Smart log filter to keep the terminal clean of spam (progress, frames, bitrates, ffmpeg streams)
function cleanLog(prefix, data) {
  const msg = data.toString();
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

// ==========================================
// 1. YOUTUBE ENDPOINTS (UNTOUCHED & PERFECT)
// ==========================================
app.post('/api/youtube/info', (expressReq, res) => {
  const { url } = expressReq.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const ytdlp = spawn('yt-dlp', ['--dump-json', '--no-playlist', url]);
  let data = '';

  ytdlp.stdout.on('data', (chunk) => { data += chunk; });
  ytdlp.stderr.on('data', (err) => { cleanLog('[YouTube Info]', err); });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({ error: 'Failed to extract video info via yt-dlp' });
    }
    try {
      const info = JSON.parse(data);
      res.json({
        title: info.title,
        uploader: info.uploader || info.channel,
        duration: info.duration_string || '',
        thumbnail: info.thumbnail,
        formats: info.formats || []
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse video metadata' });
    }
  });
});

app.get('/api/download-muxed', (req, res) => {
  const { url, height = '720', type = 'video', abr = '192', title = 'video', direct = '0' } = req.query;
  if (!url) return res.status(400).send('URL is required');

  const safeTitle = title.replace(/[\/\\?%*:|"<>]/g, '').trim();
  const ext = type === 'audio' ? 'mp3' : 'mp4';
  const filename = `${safeTitle}_${type === 'audio' ? abr + 'kbps' : height + 'p'}.${ext}`;

  if (direct === '1' || (type === 'video' && Number(height) <= 720)) {
    const formatSelector = type === 'audio' ? 'bestaudio' : `best[height<=${height}][ext=mp4]/best[height<=${height}]/best`;
    
    const ytdlpUrl = spawn('yt-dlp', [
      '--no-check-certificates',
      '--force-ipv4',
      '--get-url',
      '-f', formatSelector,
      url
    ]);

    let directUrl = '';
    ytdlpUrl.stdout.on('data', (chunk) => { directUrl += chunk; });
    ytdlpUrl.stderr.on('data', (err) => { cleanLog('[YouTube CDN]', err); });
    
    ytdlpUrl.on('close', (code) => {
      if (code === 0 && directUrl.trim()) {
        return res.redirect(302, directUrl.trim().split('\n')[0]);
      }
      fallbackPipeStream();
    });
    return;
  }

  function fallbackPipeStream() {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');

    let ytdlpArgs = [];
    if (type === 'audio') {
      ytdlpArgs = [
        '-f', 'bestaudio',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', `${abr}K`,
        '-o', '-',
        url
      ];
    } else {
      ytdlpArgs = [
        '-f', `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best/best`,
        '--merge-output-format', 'mp4',
        '-o', '-',
        url
      ];
    }

    const ytdlp = spawn('yt-dlp', ytdlpArgs);
    ytdlp.stdout.pipe(res);

    ytdlp.stderr.on('data', (err) => {
      cleanLog('[Download log]', err);
    });

    req.on('close', () => {
      try { ytdlp.kill(); } catch (_) {}
    });
  }

  if (type === 'video' && Number(height) > 720) {
    fallbackPipeStream();
  }
});


// ==========================================
// 2. INSTAGRAM ENDPOINTS (UNTOUCHED & PERFECT)
// ==========================================

// Batch Endpoint: Fetches real caption and sets download route
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
      const jsonStr = execSync(`yt-dlp --dump-json --no-playlist "${url}"`, { encoding: 'utf8', timeout: 10000 });
      const info = JSON.parse(jsonStr);
      if (info.title || info.description) {
        caption = (info.title || info.description).split('\n')[0];
      }
    } catch (e) {
      console.error(`[Instagram Caption Fetch Notice]: Using default shortcode name for shortcode ${shortcode}`);
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

// Single Download Endpoint: Server-side secure streaming guaranteeing Video + Audio
app.get('/api/instagram/download', (req, res) => {
  const { url, title = 'Instagram_Reel' } = req.query;
  if (!url) return res.status(400).send('URL required');

  const safeTitle = title.replace(/[\/\\?%*:|"<>]/g, '').trim();
  const filename = `${safeTitle}.mp4`;

  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Type', 'video/mp4');

  const ytdlp = spawn('yt-dlp', [
    '--no-check-certificates',
    '--force-ipv4',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    '--extractor-args', 'instagram:api_hostname=i.instagram.com',
    '-f', 'best[ext=mp4]/bestvideo+bestaudio/best',
    '--merge-output-format', 'mp4',
    '-o', '-',
    url
  ]);

  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on('data', (err) => {
    cleanLog('[Instagram Error]', err);
  });

  req.on('close', () => {
    try { ytdlp.kill(); } catch (_) {}
  });
});

app.listen(PORT, () => {
  console.log(`🚀 OmniSave Pro Backend running live at http://localhost:${PORT}`);
});