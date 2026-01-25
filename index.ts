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
  // Aumenta timeout do servidor para 10 minutos
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
    const relStart = w.start - cutStartTime;
    const relEnd = w.end - cutStartTime;
    
    if (relStart < 0 || relEnd < 0) return;

    srtContent += `${index + 1}\n`;
    srtContent += `${formatTimeSRT(relStart)} --> ${formatTimeSRT(relEnd)}\n`;
    srtContent += `${w.word}\n\n`;
  });
  
  fs.writeFileSync(outputPath, srtContent);
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
    // 1. Escala para 1080p de altura (mantém aspect ratio) - MUITO mais rápido
    // 2. Crop para 9:16 vertical
    // 3. Aplica legendas se existirem
    let videoFilter = 'scale=-2:1080,crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:0,setsar=1';
    
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const style = "Fontname=Arial Bold,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=1,MarginV=60,Alignment=2";
      videoFilter += `,subtitles='${escapedPath}':force_style='${style}'`;
    }

    // Fade de áudio suave
    const fadeOutStart = Math.max(0, duration - 0.15);
    const audioFilter = `afade=t=in:st=0:d=0.08,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.15`;

    const args = [
      '-y',
      // Seek ANTES de abrir o input (muito mais rápido para arquivos grandes)
      '-ss', startTime.toFixed(3),
      '-i', inputPath,
      '-t', duration.toFixed(3),
      // Mapeia streams
      '-map', '0:v:0',
      '-map', '0:a:0?',
      // Filtros
      '-vf', videoFilter,
      '-af', audioFilter,
      // Codec de vídeo - preset mais rápido
      '-c:v', 'libx264',
      '-preset', 'veryfast',  // Mais rápido que 'fast'
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      // Codec de áudio
      '-c:a', 'aac',
      '-b:a', '128k',  // Reduzido de 192k
      // Otimizações
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      // Limita threads para não sobrecarregar
      '-threads', '4',
      outputPath
    ];

    logger.info(`[FFmpeg] Iniciando: ${startTime.toFixed(2)}s -> ${endTime.toFixed(2)}s (${duration.toFixed(1)}s)`);
    logger.info(`[FFmpeg] Comando: ffmpeg ${args.join(' ')}`);
    
    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args, {
      // Timeout de 5 minutos para o processo
      timeout: 300000
    });

    let stderrData = '';
    let lastProgress = '';
    
    ffmpeg.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrData += chunk;
      
      // Log de progresso a cada update significativo
      const timeMatch = chunk.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (timeMatch && timeMatch[1] !== lastProgress) {
        lastProgress = timeMatch[1];
        logger.info(`[FFmpeg] Progresso: ${lastProgress}`);
      }
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        logger.info('[FFmpeg] Concluído com sucesso');
        resolve();
      } else {
        // Pega apenas as últimas 500 chars do erro para não poluir
        const errorTail = stderrData.slice(-500);
        reject(new Error(`FFmpeg exit code ${code}: ${errorTail}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}

fastify.post<{ Body: ProcessVideoBody }>('/process-video', { 
  schema: processSchema,
  config: {
    // Timeout de 5 minutos para a request
    requestTimeout: 300000
  }
}, async (request, reply) => {
  const { videoUrl, startTime, endTime, jobId, words } = request.body;
  
  const tempDir = os.tmpdir();
  const executionId = randomUUID();
  
  const inputPath = path.join(tempDir, `input_${executionId}.mp4`);
  const outputPath = path.join(tempDir, `output_${executionId}.mp4`);
  const subtitlePath = path.join(tempDir, `sub_${executionId}.srt`);
  
  const finalFileName = `cuts/${jobId}_${Date.now()}_${executionId.slice(0, 5)}.mp4`;
  const duration = endTime - startTime;

  try {
    request.log.info(`[${jobId}] ▶ Novo corte: ${startTime.toFixed(2)}s -> ${endTime.toFixed(2)}s (${duration.toFixed(1)}s)`);
    request.log.info(`[${jobId}] Palavras: ${words?.length || 0}`);
    
    // 1. Download
    request.log.info(`[${jobId}] Baixando vídeo...`);
    const downloadStart = Date.now();
    await downloadFile(videoUrl, inputPath);
    request.log.info(`[${jobId}] Download: ${((Date.now() - downloadStart) / 1000).toFixed(1)}s`);

    // 2. Gera legenda se tiver palavras
    let subPathArg: string | undefined;
    if (words && words.length > 0) {
      generateSubtitleFile(words, startTime, subtitlePath);
      subPathArg = subtitlePath;
    }

    // 3. Corta o vídeo
    request.log.info(`[${jobId}] Processando com FFmpeg...`);
    const ffmpegStart = Date.now();
    await runFFmpeg(inputPath, outputPath, startTime, endTime, subPathArg, request.log);
    request.log.info(`[${jobId}] FFmpeg: ${((Date.now() - ffmpegStart) / 1000).toFixed(1)}s`);

    // Verifica se o arquivo foi criado
    if (!fs.existsSync(outputPath)) {
      throw new Error('Arquivo de saída não foi criado');
    }

    const outputStats = fs.statSync(outputPath);
    request.log.info(`[${jobId}] Arquivo gerado: ${(outputStats.size / 1024 / 1024).toFixed(2)} MB`);

    // 4. Upload
    request.log.info(`[${jobId}] Upload para S3...`);
    const uploadStart = Date.now();
    const fileBuffer = fs.readFileSync(outputPath);

    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: finalFileName,
      Body: fileBuffer,
      ContentType: 'video/mp4'
    }));
    request.log.info(`[${jobId}] Upload: ${((Date.now() - uploadStart) / 1000).toFixed(1)}s`);

    const publicUrl = getPublicUrl(finalFileName);
    request.log.info(`[${jobId}] ✓ Concluído: ${publicUrl}`);
    
    return { success: true, url: publicUrl };

  } catch (err) {
    const error = err as Error;
    request.log.error(`[${jobId}] ✗ Erro: ${error.message}`);
    reply.code(500);
    return { success: false, error: error.message };
  } finally {
    // Cleanup
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
