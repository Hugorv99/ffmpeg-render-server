const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const { createWriteStream, createReadStream } = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '10mb' }));

// In-memory job store (cleared on restart, acceptable for once-a-day use)
const jobs = new Map();
const TMP = '/tmp/renders';

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/render', async (req, res) => {
  const { audioUrl, imageUrls, audioDurationSeconds, subtitleWords, cloudinaryCloudName, cloudinaryUploadPreset } = req.body;

  if (!audioUrl || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: 'audioUrl and imageUrls[] required' });
  }

  const jobId = uuidv4();
  jobs.set(jobId, { status: 'processing', created: Date.now() });

  processJob(jobId, { audioUrl, imageUrls, audioDurationSeconds, subtitleWords, cloudinaryCloudName, cloudinaryUploadPreset })
    .catch(err => {
      console.error(`[${jobId}] failed:`, err.message);
      jobs.set(jobId, { status: 'error', error: err.message, created: jobs.get(jobId)?.created });
    });

  res.json({ jobId, status: 'processing' });
});

app.get('/render/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

async function downloadFile(url, dest) {
  const response = await axios({ method: 'GET', url, responseType: 'stream', timeout: 60000 });
  const writer = createWriteStream(dest);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function processJob(jobId, { audioUrl, imageUrls, audioDurationSeconds, subtitleWords, cloudinaryCloudName, cloudinaryUploadPreset }) {
  const workDir = path.join(TMP, jobId);
  await fs.mkdir(workDir, { recursive: true });

  try {
    console.log(`[${jobId}] Downloading ${imageUrls.length} images + audio`);

    // Download audio and images concurrently
    const audioPath = path.join(workDir, 'audio.mp3');
    const imagePaths = imageUrls.map((_, i) => path.join(workDir, `img${i}.jpg`));
    await Promise.all([
      downloadFile(audioUrl, audioPath),
      ...imageUrls.map((url, i) => downloadFile(url, imagePaths[i]))
    ]);

    // Generate subtitle ASS file if word timing available
    const assPath = path.join(workDir, 'subs.ass');
    const hasSubtitles = Array.isArray(subtitleWords) && subtitleWords.length > 0;
    if (hasSubtitles) {
      await generateASS(subtitleWords, assPath);
      console.log(`[${jobId}] Subtitles: ${subtitleWords.length} words`);
    }

    // Build FFmpeg concat list
    const concatPath = path.join(workDir, 'concat.txt');
    const duration = Math.max(audioDurationSeconds || 60, 5);
    const sceneDuration = duration / imagePaths.length;
    let concatContent = imagePaths.map(p => `file '${p}'\nduration ${sceneDuration.toFixed(3)}`).join('\n');
    // Repeat last image without duration — required by concat demuxer for exact length
    concatContent += `\nfile '${imagePaths[imagePaths.length - 1]}'`;
    await fs.writeFile(concatPath, concatContent);

    // Render video
    const outputPath = path.join(workDir, 'output.mp4');
    console.log(`[${jobId}] Rendering ${duration}s video...`);
    await renderVideo({ concatPath, audioPath, assPath, outputPath, hasSubtitles });
    console.log(`[${jobId}] Render complete, uploading to Cloudinary`);

    // Upload to Cloudinary
    const videoUrl = await uploadToCloudinary(outputPath, cloudinaryCloudName, cloudinaryUploadPreset);
    jobs.set(jobId, { status: 'done', videoUrl, created: jobs.get(jobId)?.created });
    console.log(`[${jobId}] Done: ${videoUrl}`);

  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function generateASS(words, assPath) {
  const WORDS_PER_LINE = 4;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Luckiest Guy,60,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,5,0,8,20,20,180,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  function toASSTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const cs = Math.round((s % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  let events = '';
  for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
    const group = words.slice(i, i + WORDS_PER_LINE);
    const start = group[0].start;
    const end = group[group.length - 1].end;
    const text = group.map(w => w.word).join(' ');
    events += `Dialogue: 0,${toASSTime(start)},${toASSTime(end)},Default,,0,0,0,,${text}\n`;
  }

  await fs.writeFile(assPath, header + events, 'utf8');
}

function renderVideo({ concatPath, audioPath, assPath, outputPath, hasSubtitles }) {
  return new Promise((resolve, reject) => {
    const vf = [
      'scale=720:1280:force_original_aspect_ratio=increase',
      'crop=720:1280',
      ...(hasSubtitles ? [`subtitles='${assPath.replace(/'/g, "\\'")}':fontsdir=/app/fonts`] : [])
    ].join(',');

    ffmpeg()
      .input(concatPath).inputOptions(['-f concat', '-safe 0'])
      .input(audioPath)
      .videoFilter(vf)
      .videoCodec('libx264').outputOption('-preset ultrafast').outputOption('-crf 28')
      .outputOption('-threads 1')
      .audioCodec('aac').outputOption('-b:a 96k')
      .outputOptions(['-pix_fmt yuv420p', '-movflags +faststart', '-shortest'])
      .output(outputPath)
      .on('start', cmd => console.log('FFmpeg:', cmd.substring(0, 120)))
      .on('error', (err, _stdout, stderr) => reject(new Error(err.message + '\n' + (stderr || '').slice(-500))))
      .on('end', resolve)
      .run();
  });
}

async function uploadToCloudinary(filePath, cloudName, uploadPreset) {
  const form = new FormData();
  form.append('file', createReadStream(filePath));
  form.append('upload_preset', uploadPreset);

  const response = await axios.post(
    `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`,
    form,
    { headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 300000 }
  );

  const url = response.data?.secure_url;
  if (!url) throw new Error('Cloudinary upload failed: no secure_url in response');
  return url;
}

// Clean up jobs older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 7200000;
  for (const [id, job] of jobs) {
    if (job.created < cutoff) jobs.delete(id);
  }
}, 3600000);

fs.mkdir(TMP, { recursive: true }).catch(() => {});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg render server listening on port ${PORT}`));
