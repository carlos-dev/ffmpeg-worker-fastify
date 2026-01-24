import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'; // R2 usa SDK do S3
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import ffmpegPath from 'ffmpeg-static'; 

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: true });

// --- CONFIGURAÇÃO R2 (CLOUDFLARE) ---
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || '';
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});

function getPublicUrl(fileName: string) {
  // Ajuste sua URL pública do R2 aqui se tiver domínio customizado
  const publicDomain = process.env.R2_PUBLIC_DOMAIN; 
  if (publicDomain) return `${publicDomain}/${fileName}`;
  return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${fileName}`;
}

// ... (RESTO DAS INTERFACES IGUAIS) ...
interface Word { start: number; end: number; word: string; }
interface ProcessVideoBody {
  videoUrl: string; startTime: string | number; duration: number; jobId: string; words: Word[];
}
const processSchema = {
  body: {
    type: 'object',
    required: ['videoUrl', 'startTime', 'duration', 'jobId'],
    properties: {
      videoUrl: { type: 'string', format: 'uri' },
      startTime: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      duration: { type: 'number' },
      jobId: { type: 'string' },
      words: { type: 'array' } // Opcional se não mandar
    }
  }
};

// ... (DOWNLOAD FILE, FORMAT TIME, GENERATE SUBTITLE MANTEM IGUAL) ...
async function downloadFile(url: string, outputPath: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Falha ao baixar: ${response.statusText}`);
    await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(outputPath));
}
function formatTimeSRT(seconds: number): string {
    const date = new Date(0); date.setMilliseconds(seconds * 1000);
    return date.toISOString().substr(11, 12).replace('.', ','); 
}
function generateSubtitleFile(words: Word[], globalStartTime: number, outputPath: string): void {
    let srtContent = ''; const syncOffset = 0.0; 
    words.forEach((w, index) => {
        const relStart = Math.max(0, w.start - globalStartTime + syncOffset);
        const relEnd = Math.max(0, w.end - globalStartTime + syncOffset);
        if (relEnd <= relStart) return;
        srtContent += `${index + 1}\n${formatTimeSRT(relStart)} --> ${formatTimeSRT(relEnd)}\n${w.word}\n\n`;
    });
    fs.writeFileSync(outputPath, srtContent);
}

// ... (RUN FFMPEG - LOOSE CUT MANTEM IGUAL) ...
function runFFmpeg(inputPath: string, outputPath: string, reqStart: number, reqDuration: number, subtitlePath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const PAD_START = 0.10; 
    const PAD_END = 0.25;
    const finalStart = Math.max(0, reqStart - PAD_START);
    const finalDuration = reqDuration + (reqStart - finalStart) + PAD_END;

    const s = finalStart.toFixed(3);
    const d = finalDuration.toFixed(3);
    let videoFilter = 'crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:(ih-oh)/2,setsar=1';
    
    if (subtitlePath) {
      const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const style = "Fontname=Arial Bold,FontSize=24,PrimaryColour=&H0000FFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=4,Shadow=0,MarginV=70,Alignment=2";
      videoFilter += `,subtitles='${escapedPath}':force_style='${style}'`;
    }
    const fadeOutStart = finalDuration - PAD_END;
    const audioFilter = `afade=t=in:st=0:d=${PAD_START},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${PAD_END}`;

    const args = [
      '-y', '-ss', s, '-i', inputPath, '-t', d, 
      '-map', '0:v:0', '-map', '0:a:0?', 
      '-vf', videoFilter, '-af', audioFilter, 
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',    
      '-c:a', 'aac', '-b:a', '192k',
      '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
      outputPath
    ];
    console.log(`[FFmpeg] Loose Cut: ${s} -> ${d}`);
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

    const numStart = Number(startTime);
    const numDuration = Number(duration);
    let subPathArg: string | undefined = undefined;

    if (words && words.length > 0) {
        const PAD_START = 0.10;
        generateSubtitleFile(words, Math.max(0, numStart - PAD_START), subtitlePath);
        subPathArg = subtitlePath;
    }

    request.log.info(`[${jobId}] Renderizando (Loose Cut)...`);
    await runFFmpeg(inputPath, outputPath, numStart, numDuration, subPathArg);

    request.log.info(`[${jobId}] Uploading to R2...`);
    const fileBuffer = fs.readFileSync(outputPath);

    // --- UPLOAD R2 ---
    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
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
    console.log(`Worker R2 rodando na porta ${port}`);
  } catch (err) { fastify.log.error(err); process.exit(1); }
};
start();