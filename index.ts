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

// --- GERADOR DE LEGENDAS KARAOKÊ (.ASS) ---
// Substitui a antiga função SRT para dar o visual "Opus Clip"
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

    const firstWord = currentGroup[0];
    const lastWord = currentGroup[currentGroup.length - 1];

    const startSeconds = Math.max(0, firstWord.start - cutStartTime);
    const endSeconds = Math.max(0, lastWord.end - cutStartTime);

    const formatASS = (s: number) => {
        const date = new Date(0);
        date.setMilliseconds(s * 1000);
        return date.toISOString().substr(11, 10).replace('.', '.');
    };

    let karaokeText = '';
    
    currentGroup.forEach((w, i) => {
        // Duração em centisegundos para o efeito de pintura (\k)
        const duration = Math.round((w.end - w.start) * 100);
        const space = i > 0 ? ' ' : '';
        // Palavra em MAIÚSCULO
        karaokeText += `${space}{\\k${duration}}${w.word.toUpperCase()}`; 
    });

    assContent += `Dialogue: 0,${formatASS(startSeconds)},${formatASS(endSeconds)},Default,,0,0,0,,${karaokeText}\n`;
    
    currentGroup = [];
    currentCharCount = 0;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    
    // Ignora palavras fora do corte
    if (w.end < cutStartTime) continue;

    const prevWord = words[i-1];
    const isBigGap = prevWord && (w.start - prevWord.end > 0.5);

    // Agrupa palavras (max 25 chars ou quebra por pausa)
    if ((currentCharCount + w.word.length > 25) || isBigGap) {
        flushGroup();
    }

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
  logger: any
): Promise<void> {
  return new Promise((resolve, reject) => {
    const duration = endTime - startTime;
    
    // === FILTRO DE VÍDEO ===
    // Crop 9:16
    let videoFilter = 'scale=-2:1080,crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:0,setsar=1';
    
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      // Ajuste para .ASS: Caminho escapado + Filtro 'subtitles' sem force_style
      // (O estilo agora vem de dentro do arquivo .ass)
      const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      videoFilter += `,subtitles='${escapedPath}'`;
    }

    const fadeOutStart = Math.max(0, duration - 0.15);
    const audioFilter = `afade=t=in:st=0:d=0.08,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.15`;

    const args = [
      '-y',
      '-ss', startTime.toFixed(3),
      '-i', inputPath,
      '-t', duration.toFixed(3),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', videoFilter,
      '-af', audioFilter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-threads', '4',
      outputPath
    ];

    logger.info(`[FFmpeg] Iniciando: ${startTime.toFixed(2)}s -> ${endTime.toFixed(2)}s`);
    logger.info(`[FFmpeg] Comando: ffmpeg ${args.join(' ')}`);
    
    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args, { timeout: 300000 });

    let stderrData = '';
    
    ffmpeg.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        logger.info('[FFmpeg] Concluído');
        resolve();
      } else {
        const errorTail = stderrData.slice(-500);
        reject(new Error(`FFmpeg exit code ${code}: ${errorTail}`));
      }
    });

    ffmpeg.on('error', (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
  });
}

fastify.post<{ Body: ProcessVideoBody }>('/process-video', { 
  schema: processSchema,
  config: { requestTimeout: 300000 }
}, async (request, reply) => {
  const { videoUrl, startTime, endTime, jobId, words } = request.body;
  
  const tempDir = os.tmpdir();
  const executionId = randomUUID();
  
  const inputPath = path.join(tempDir, `input_${executionId}.mp4`);
  const outputPath = path.join(tempDir, `output_${executionId}.mp4`);
  // Mudança de extensão para .ass
  const subtitlePath = path.join(tempDir, `sub_${executionId}.ass`);
  
  const finalFileName = `cuts/${jobId}_${Date.now()}_${executionId.slice(0, 5)}.mp4`;
  const duration = endTime - startTime;

  try {
    request.log.info(`[${jobId}] ▶ Novo corte: ${duration.toFixed(1)}s`);
    
    await downloadFile(videoUrl, inputPath);

    let subPathArg: string | undefined;
    if (words && words.length > 0) {
      // Ajuste de delay de áudio (opcional, mantendo padrão)
      generateSubtitleFile(words, startTime, subtitlePath);
      subPathArg = subtitlePath;
    }

    await runFFmpeg(inputPath, outputPath, startTime, endTime, subPathArg, request.log);

    if (!fs.existsSync(outputPath)) throw new Error('Arquivo de saída não criado');

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
    request.log.error(`[${jobId}] ✗ Erro: ${error.message}`);
    reply.code(500);
    return { success: false, error: error.message };
  } finally {
    [inputPath, outputPath, subtitlePath].forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    });
  }
});

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

const start = async () => {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`Worker FFmpeg rodando na porta ${port}`);
};

start();