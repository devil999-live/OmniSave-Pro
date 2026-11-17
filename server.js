const express = require('express');
const path = require('path');
const cors = require('cors');
const ytdlpExec = require('yt-dlp-exec'); // Fully compatible with Render cloud

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname))); // Serves index.html automatically!

// Smart log filter to keep the terminal clean of spam (progress, frames, bitrates, ffmpeg streams)
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

// ==========================================
// 1. YOUTUBE ENDPOINTS (USING YTDLP-EXEC)
// ==========================================
app.post('/api/youtube/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const info = await ytdlpExec(url, {
      dumpJson: true,
      noPlaylist: true
    });
    res.json({
      title: info.title,
      uploader: info.uploader || info.channel,
      duration: info.duration_string || '',
      thumbnail: info.thumbnail,
      formats: info.formats || []
    });
  } catch (err) {
    cleanLog('[YouTube Info Error]', err);
    res.status(500).json({ error: 'Failed to extract video info via yt-dlp' });
  }
});

app.get('/api/download-muxed', (req, res) => {
  const { url, height = '720', type = 'video', abr = '192', title = 'video', direct = '0' } = req.query;
  if (!url) return res.status(400).send('URL is required');

  const safeTitle = title.replace(/[\/\\?%*:|"<>]/g, '').trim();
  const ext = type === 'audio' ? 'mp3' : 'mp4';
  const filename = `${safeTitle}_${type === 'audio' ? abr + 'kbps' : height + 'p'}.${ext}`;

  if (direct === '1' || (type === 'video' && Number(height) <= 720)) {
    const formatSelector = type === 'audio' ? 'bestaudio' : `best[height<=${height}][ext=mp4]/best[height<=${height}]/best`;
    
    ytdlpExec(url, {
      getUrl: true,
      format: formatSelector
    }).then(output => {
      const directUrl = output.trim().split('\n')[0];
      if (directUrl) {
        return res.redirect(302, directUrl);
      }
      fallbackPipeStream();
    }).catch(() => {
      fallbackPipeStream();
    });
    return;
  }

  function fallbackPipeStream() {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');

    let flags = {};
    if (type === 'audio') {
      flags = {
        format: 'bestaudio',
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: `${abr}K`,
        output: '-'
      };
    } else {
      flags = {
        format: `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best/best`,
        mergeOutputFormat: 'mp4',
        output: '-'
      };
    }

    const subprocess = ytdlpExec.exec(url, flags);
    subprocess.stdout.pipe(res);

    subprocess.stderr.on('data', (err) => {
      cleanLog('[Download log]', err);
    });

    req.on('close', () => {
      try { subprocess.kill(); } catch (_) {}
    });
  }

  if (type === 'video' && Number(height) > 720) {
    fallbackPipeStream();
  }
});


// ==========================================
// 2. INSTAGRAM ENDPOINTS (FIXED FOR RENDER)
// ==========================================

// Batch Endpoint: Fetches real caption securely using ytdlpExec instead of execSync
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
        noPlaylist: true
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

// Single Download Endpoint: Server-side secure streaming guaranteeing Video + Audio
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