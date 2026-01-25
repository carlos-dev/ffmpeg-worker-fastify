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

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: true });

// --- CONFIGURAÇÃO S3 / R2 ---
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

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao baixar: ${response.statusText}`);
  await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(outputPath));
}

function formatTimeSRT(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

function generateSubtitleFile(words: Word[], cutStartTime: number, outputPath: string): void {
  let srtContent = '';

  words.forEach((w, index) => {
    // Tempo relativo ao início do corte
    const relStart = w.start - cutStartTime;
    const relEnd = w.end - cutStartTime;
    
    // Ignora palavras fora do range
    if (relStart < 0 || relEnd < 0) return;

    srtContent += `${index + 1}\n`;
    srtContent += `${formatTimeSRT(relStart)} --> ${formatTimeSRT(relEnd)}\n`;
    srtContent += `${w.word}\n\n`;
  });
  
  fs.writeFileSync(outputPath, srtContent);
}

function runFFmpeg(inputPath: string, outputPath: string, startTime: number, endTime: number, subtitlePath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const duration = endTime - startTime;
    
    let videoFilter = 'crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:(ih-oh)/2,setsar=1';
    
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const style = "Fontname=Arial Bold,FontSize=24,PrimaryColour=&H0000FFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=4,Shadow=0,MarginV=70,Alignment=2";
      videoFilter += `,subtitles='${escapedPath}':force_style='${style}'`;
    }

    // Fade de áudio suave nas bordas
    const fadeOutStart = Math.max(0, duration - 0.1);
    const audioFilter = `afade=t=in:st=0:d=0.05,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.1`;

    const args = [
      '-y',
      '-ss', startTime.toFixed(3),
      '-i', inputPath,
      '-t', duration.toFixed(3),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', videoFilter,
      '-af', audioFilter,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      outputPath
    ];

    console.log(`[FFmpeg] Corte: ${startTime.toFixed(3)}s -> ${endTime.toFixed(3)}s (${duration.toFixed(2)}s)`);
    
    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args);
    let stderrData = '';
    ffmpeg.stderr.on('data', d => stderrData += d.toString());
    ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg: ${stderrData}`)));
    ffmpeg.on('error', err => reject(err));
  });
}

fastify.post<{ Body: ProcessVideoBody }>('/process-video', { schema: processSchema }, async (request, reply) => {
  const { videoUrl, startTime, endTime, jobId, words } = request.body;
  
  const tempDir = os.tmpdir();
  const executionId = randomUUID();
  
  const inputPath = path.join(tempDir, `input_${executionId}.mp4`);
  const outputPath = path.join(tempDir, `output_${executionId}.mp4`);
  const subtitlePath = path.join(tempDir, `sub_${executionId}.srt`);
  
  const finalFileName = `cuts/${jobId}_${Date.now()}_${executionId.slice(0, 5)}.mp4`;

  try {
    request.log.info(`[${jobId}] Recebido: ${startTime.toFixed(2)}s -> ${endTime.toFixed(2)}s`);
    
    // 1. Download
    request.log.info(`[${jobId}] Baixando vídeo...`);
    await downloadFile(videoUrl, inputPath);

    // 2. Gera legenda se tiver palavras
    let subPathArg: string | undefined;
    if (words && words.length > 0) {
      generateSubtitleFile(words, startTime, subtitlePath);
      subPathArg = subtitlePath;
      request.log.info(`[${jobId}] Legenda: ${words.length} palavras`);
    }

    // 3. Corta o vídeo - usa os tempos EXATOS recebidos
    request.log.info(`[${jobId}] Cortando...`);
    await runFFmpeg(inputPath, outputPath, startTime, endTime, subPathArg);

    // 4. Upload
    request.log.info(`[${jobId}] Upload...`);
    const fileBuffer = fs.readFileSync(outputPath);

    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: finalFileName,
      Body: fileBuffer,
      ContentType: 'video/mp4'
    }));

    const publicUrl = getPublicUrl(finalFileName);
    request.log.info(`[${jobId}] ✓ ${publicUrl}`);
    
    return { success: true, url: publicUrl };

  } catch (err) {
    const error = err as Error;
    request.log.error(`[${jobId}] Erro: ${error.message}`);
    reply.code(500);
    return { success: false, error: error.message };
  } finally {
    [inputPath, outputPath, subtitlePath].forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    });
  }
});

const start = async () => {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`Worker FFmpeg rodando na porta ${port}`);
};

start();
