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
// Ajuste conforme seu provedor (AWS S3, Cloudflare R2, DigitalOcean Spaces, etc)
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
  // Se tiver domínio público configurado
  if (process.env.PUBLIC_MEDIA_URL) {
    return `${process.env.PUBLIC_MEDIA_URL}/${fileName}`;
  }
  // Fallback genérico (pode precisar ajuste dependendo se é R2 ou AWS)
  return `${S3_ENDPOINT}/${S3_BUCKET_NAME}/${fileName}`;
}

interface Word {
  start: number;
  end: number;
  word: string;
}

interface ProcessVideoBody {
  videoUrl: string;
  startTime: string | number;
  duration: number;
  jobId: string;
  words: Word[];
}

const processSchema = {
  body: {
    type: 'object',
    required: ['videoUrl', 'startTime', 'duration', 'jobId', 'words'],
    properties: {
      videoUrl: { type: 'string', format: 'uri' },
      startTime: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      duration: { type: 'number' },
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
  const date = new Date(0);
  date.setMilliseconds(seconds * 1000);
  const iso = date.toISOString().substr(11, 12); 
  return iso.replace('.', ','); 
}

// --- LÓGICA DE ALINHAMENTO ---
function findExactWordStart(targetTime: number, words: Word[]): number {
    if (!words || words.length === 0) return targetTime;
    // Acha a palavra que cobre o targetTime
    const match = words.find(w => targetTime >= w.start && targetTime <= w.end);
    if (match) return match.start;
    // Se não achar (silêncio), pega a próxima
    const next = words.find(w => w.start > targetTime);
    return next ? next.start : targetTime;
}

function findExactWordEnd(targetTime: number, words: Word[]): number {
    if (!words || words.length === 0) return targetTime;
    const match = words.find(w => targetTime >= w.start && targetTime <= w.end);
    if (match) return match.end;
    // Se não achar (silêncio), pega a anterior
    const prev = words.filter(w => w.end < targetTime).pop();
    return prev ? prev.end : targetTime;
}

function generateSubtitleFile(words: Word[], globalStartTime: number, outputPath: string): void {
  let srtContent = '';
  // Pequeno ajuste para a legenda
  const syncOffset = 0.0; 

  words.forEach((w, index) => {
    const relStart = Math.max(0, w.start - globalStartTime + syncOffset);
    const relEnd = Math.max(0, w.end - globalStartTime + syncOffset);
    if (relEnd <= relStart) return;

    srtContent += `${index + 1}\n`;
    srtContent += `${formatTimeSRT(relStart)} --> ${formatTimeSRT(relEnd)}\n`;
    srtContent += `${w.word}\n\n`;
  });
  fs.writeFileSync(outputPath, srtContent);
}

// --- FFMPEG COM BUFFER GIGANTE ---
function runFFmpeg(inputPath: string, outputPath: string, wordStart: number, wordEnd: number, subtitlePath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    
    // MARGEM DE SEGURANÇA GIGANTE
    // Se a palavra começa em 10.0, começamos o vídeo em 9.7 (0.3s antes)
    // Se a palavra termina em 20.0, terminamos o vídeo em 20.4 (0.4s depois)
    const BUFFER_START = 0.30; 
    const BUFFER_END = 0.40;

    const finalStart = Math.max(0, wordStart - BUFFER_START);
    const finalEnd = wordEnd + BUFFER_END;
    const duration = finalEnd - finalStart;

    const s = finalStart.toFixed(3);
    const d = duration.toFixed(3);

    let videoFilter = 'crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:(ih-oh)/2,setsar=1';
    
    if (subtitlePath) {
      const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const style = "Fontname=Arial Bold,FontSize=24,PrimaryColour=&H0000FFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=4,Shadow=0,MarginV=70,Alignment=2";
      videoFilter += `,subtitles='${escapedPath}':force_style='${style}'`;
    }

    // LÓGICA DE ÁUDIO PROTEGIDA:
    // Fade In: Apenas nos primeiros 0.1s (sobram 0.2s de áudio limpo antes da palavra)
    // Fade Out: Apenas nos últimos 0.15s (sobram 0.25s de áudio limpo depois da palavra)
    const fadeOutStart = duration - 0.15;
    const audioFilter = `afade=t=in:st=0:d=0.1,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.15`;

    const args = [
      '-y',
      '-ss', s,                 
      '-i', inputPath,          
      '-t', d,                  
      '-map', '0:v:0',          
      '-map', '0:a:0?',         
      '-vf', videoFilter,       
      '-af', audioFilter,       
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',             
      '-pix_fmt', 'yuv420p',    
      '-c:a', 'aac', '-b:a', '192k',
      '-avoid_negative_ts', 'make_zero', // Garante sincronia
      '-movflags', '+faststart',
      outputPath
    ];

    console.log(`[FFmpeg] SAFE CUT: Palavra(${wordStart.toFixed(2)}-${wordEnd.toFixed(2)}) -> Video(${s}-${(parseFloat(s)+parseFloat(d)).toFixed(3)})`);
    
    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args);
    let stderrData = '';
    ffmpeg.stderr.on('data', d => stderrData += d.toString());
    ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg error: ${stderrData}`)));
    ffmpeg.on('error', err => reject(err));
  });
}

fastify.post<{ Body: ProcessVideoBody }>('/process-video', { schema: processSchema }, async (request, reply) => {
  const { videoUrl, startTime, duration, jobId, words } = request.body;
  const tempDir = os.tmpdir();
  const executionId = randomUUID();
  
  const inputPath = path.join(tempDir, `input_${executionId}.mp4`);
  const outputPath = path.join(tempDir, `output_${executionId}.mp4`);
  const subtitlePath = path.join(tempDir, `sub_${executionId}.srt`);
  
  const finalFileName = `cuts/${jobId}_${Date.now()}_${executionId.slice(0, 5)}.mp4`;

  try {
    request.log.info(`[${jobId}] Baixando...`);
    await downloadFile(videoUrl, inputPath);

    const rawStart = Number(startTime);
    const rawEnd = rawStart + Number(duration);

    // 1. ACHA OS LIMITES REAIS DA PALAVRA
    const exactStart = findExactWordStart(rawStart, words);
    const exactEnd = findExactWordEnd(rawEnd, words);

    request.log.info(`[${jobId}] Alinhamento: GPT(${rawStart}-${rawEnd}) -> REAL(${exactStart}-${exactEnd})`);

    // GERA LEGENDA
    // Compensamos o BUFFER_START (0.30s) que vamos adicionar no FFmpeg
    let subPathArg: string | undefined = undefined;
    if (words && words.length > 0) {
        const BUFFER_START = 0.30;
        const subOffset = Math.max(0, exactStart - BUFFER_START);
        generateSubtitleFile(words, subOffset, subtitlePath);
        subPathArg = subtitlePath;
    }

    request.log.info(`[${jobId}] Renderizando com Buffer Gigante...`);
    // Passamos os tempos EXATOS da palavra. O FFmpeg vai adicionar os 0.3s/0.4s extras.
    await runFFmpeg(inputPath, outputPath, exactStart, exactEnd, subPathArg);

    request.log.info(`[${jobId}] Uploading to S3...`);
    const fileBuffer = fs.readFileSync(outputPath);

    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: finalFileName,
      Body: fileBuffer,
      ContentType: 'video/mp4'
    }));

    const publicUrl = getPublicUrl(finalFileName);
    return { success: true, url: publicUrl };

  } catch (err) {
    const error = err as Error;
    request.log.error(`[${jobId}] Erro: ${error.message}`);
    reply.code(500);
    return { success: false, error: error.message };
  } finally {
    try {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (fs.existsSync(subtitlePath)) fs.unlinkSync(subtitlePath);
    } catch (e) {}
  }
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Worker S3 (Buffer Gigante) rodando na porta ${port}`);
  } catch (err) { fastify.log.error(err); process.exit(1); }
};
start();