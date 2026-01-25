import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import ffmpegPath from 'ffmpeg-static'; 

const fastify = Fastify({ 
  logger: true,
  connectionTimeout: 600000,
  keepAliveTimeout: 600000
});

await fastify.register(cors, { origin: true });

// --- CONFIGURAÇÃO S3 ---
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || process.env.R2_BUCKET_NAME || '';
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_ENDPOINT = process.env.S3_ENDPOINT || process.env.R2_ENDPOINT || '';

const s3Client = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '',
  },
});

function getPublicUrl(fileName: string) {
  if (process.env.PUBLIC_MEDIA_URL) {
    return `${process.env.PUBLIC_MEDIA_URL}/${fileName}`;
  }
  return `${S3_ENDPOINT}/${S3_BUCKET_NAME}/${fileName}`;
}

// --- UTILITÁRIOS DE TEMPO ---
function timeToSeconds(timeString: string): number {
  // Formato FFmpeg: 00:00:10.50
  const parts = timeString.split(':');
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2]);
  return (h * 3600) + (m * 60) + s;
}

function formatTimeSRT(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

// --- INTERFACES ---
interface Word {
  start: number;
  end: number;
  word: string;
}

interface ProcessVideoBody {
  videoUrl: string;
  startTime: number;
  endTime: number;
  jobId: string;
  words: Word[];
}

const processSchema = {
  body: {
    type: 'object',
    required: ['videoUrl', 'startTime', 'endTime', 'jobId'],
    properties: {
      videoUrl: { type: 'string', format: 'uri' },
      startTime: { type: 'number' },
      endTime: { type: 'number' },
      jobId: { type: 'string' },
      words: { type: 'array' }
    }
  }
};

async function downloadFile(url: string, outputPath: string, onProgress: (pct: number) => void): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao baixar: ${response.statusText}`);
  
  const totalLength = Number(response.headers.get('content-length'));
  let downloaded = 0;
  
  const fileStream = fs.createWriteStream(outputPath);
  
  if (!response.body) throw new Error('No body');
  
  const reader = response.body.getReader();
  
  while(true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    downloaded += value.length;
    fileStream.write(value);
    
    // Progresso do Download (0 a 10%) do progresso total
    if (totalLength) {
        const percent = (downloaded / totalLength) * 10; 
        onProgress(percent);
    }
  }
  fileStream.end();
}

function generateSubtitleFile(words: Word[], cutStartTime: number, outputPath: string): void {
  const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,85,&H0000FFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,0,2,10,10,250,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  let assContent = ASS_HEADER;
  let currentGroup: Word[] = [];
  let currentCharCount = 0;

  const flushGroup = () => {
    if (currentGroup.length === 0) return;
    const startSeconds = Math.max(0, currentGroup[0].start - cutStartTime);
    const endSeconds = Math.max(0, currentGroup[currentGroup.length - 1].end - cutStartTime);
    
    const formatASS = (s: number) => {
        const date = new Date(0); date.setMilliseconds(s * 1000);
        return date.toISOString().substr(11, 10).replace('.', '.');
    };

    let karaokeText = '';
    currentGroup.forEach((w, i) => {
        const duration = Math.round((w.end - w.start) * 100);
        const space = i > 0 ? ' ' : '';
        karaokeText += `${space}{\\k${duration}}${w.word.toUpperCase()}`; 
    });

    assContent += `Dialogue: 0,${formatASS(startSeconds)},${formatASS(endSeconds)},Default,,0,0,0,,${karaokeText}\n`;
    currentGroup = [];
    currentCharCount = 0;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.end < cutStartTime) continue;
    const prevWord = words[i-1];
    const isBigGap = prevWord && (w.start - prevWord.end > 0.5);
    if ((currentCharCount + w.word.length > 25) || isBigGap) flushGroup();
    currentGroup.push(w);
    currentCharCount += w.word.length + 1;
  }
  flushGroup();
  fs.writeFileSync(outputPath, assContent);
}

function runFFmpeg(
  inputPath: string, 
  outputPath: string, 
  startTime: number, 
  endTime: number, 
  subtitlePath: string | undefined,
  onProgress: (pct: number) => void, // Callback de Progresso
  logger: any
): Promise<void> {
  return new Promise((resolve, reject) => {
    const duration = endTime - startTime;
    let videoFilter = 'scale=-2:1080,crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:0,setsar=1';
    
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      videoFilter += `,subtitles='${escapedPath}'`;
    }

    const fadeOutStart = Math.max(0, duration - 0.15);
    const audioFilter = `afade=t=in:st=0:d=0.08,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.15`;

    const args = [
      '-y', '-ss', startTime.toFixed(3), '-i', inputPath, '-t', duration.toFixed(3),
      '-map', '0:v:0', '-map', '0:a:0?', 
      '-vf', videoFilter, '-af', audioFilter,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
      '-threads', '4', outputPath
    ];

    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args, { timeout: 300000 });
    let stderrData = '';

    ffmpeg.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrData += chunk;
      
      // CAPTURA O TEMPO ATUAL E CALCULA %
      const timeMatch = chunk.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (timeMatch) {
        const currentTime = timeToSeconds(timeMatch[1]);
        let percent = (currentTime / duration) * 100;
        
        // Ajusta a escala: FFmpeg vai de 10% a 90% do progresso total (0-10 é download, 90-100 é upload)
        const globalPercent = 10 + (percent * 0.8); 
        onProgress(Math.min(90, globalPercent));
      }
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg error: ${stderrData.slice(-500)}`));
    });
    ffmpeg.on('error', (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
  });
}

// --- ROTA DE PROCESSAMENTO COM STREAMING ---
fastify.post<{ Body: ProcessVideoBody }>('/process-video', { 
  schema: processSchema 
}, async (request, reply) => {
  const { videoUrl, startTime, endTime, jobId, words } = request.body;
  
  // Define o Header para permitir Streaming (Chunked Transfer)
  reply.raw.setHeader('Content-Type', 'application/x-ndjson');
  reply.raw.setHeader('Connection', 'keep-alive');
  
  // Helper para enviar JSONs parciais para o frontend
  const sendProgress = (data: any) => {
    reply.raw.write(JSON.stringify(data) + '\n');
  };

  const tempDir = os.tmpdir();
  const executionId = randomUUID();
  const inputPath = path.join(tempDir, `input_${executionId}.mp4`);
  const outputPath = path.join(tempDir, `output_${executionId}.mp4`);
  const subtitlePath = path.join(tempDir, `sub_${executionId}.ass`);
  const finalFileName = `cuts/${jobId}_${Date.now()}_${executionId.slice(0, 5)}.mp4`;

  try {
    sendProgress({ status: 'starting', progress: 0 });

    // 1. Download (0% a 10%)
    await downloadFile(videoUrl, inputPath, (pct) => {
        sendProgress({ status: 'downloading', progress: Math.floor(pct) });
    });

    // 2. Legendas
    let subPathArg: string | undefined;
    if (words && words.length > 0) {
      generateSubtitleFile(words, startTime, subtitlePath);
      subPathArg = subtitlePath;
    }

    // 3. FFmpeg (10% a 90%)
    // O onProgress do FFmpeg já calcula considerando esse range
    await runFFmpeg(inputPath, outputPath, startTime, endTime, subPathArg, (pct) => {
        sendProgress({ status: 'rendering', progress: Math.floor(pct) });
    }, request.log);

    // 4. Upload (90% a 100%)
    sendProgress({ status: 'uploading', progress: 95 });
    
    const fileBuffer = fs.readFileSync(outputPath);
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: finalFileName,
      Body: fileBuffer,
      ContentType: 'video/mp4'
    }));

    const publicUrl = getPublicUrl(finalFileName);
    
    // ENVIA O RESULTADO FINAL
    sendProgress({ status: 'completed', progress: 100, url: publicUrl, success: true });
    
  } catch (err) {
    const error = err as Error;
    request.log.error(`Erro: ${error.message}`);
    // Envia erro no stream e fecha
    sendProgress({ status: 'error', error: error.message, success: false });
  } finally {
    [inputPath, outputPath, subtitlePath].forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    });
    // Encerra a conexão HTTP
    reply.raw.end();
  }
});

fastify.get('/health', async () => ({ status: 'ok' }));

const start = async () => {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`Worker Streaming rodando na porta ${port}`);
};

start();