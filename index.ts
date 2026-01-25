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
  endTime?: number;      // Novo: tempo exato do fim
  duration?: number;     // Mantido para compatibilidade
  jobId: string;
  words: Word[];
}

const processSchema = {
  body: {
    type: 'object',
    required: ['videoUrl', 'startTime', 'jobId', 'words'],
    properties: {
      videoUrl: { type: 'string', format: 'uri' },
      startTime: { type: 'number' },
      endTime: { type: 'number' },
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

// --- LÓGICA DE ALINHAMENTO PRECISO ---

// Encontra a primeira palavra que começa em ou após o tempo alvo
function findFirstWordAtOrAfter(targetTime: number, words: Word[]): Word | null {
  if (!words || words.length === 0) return null;
  
  // Ordena por tempo de início para garantir
  const sorted = [...words].sort((a, b) => a.start - b.start);
  
  // Encontra a primeira palavra que começa em ou após targetTime
  // Com tolerância de 0.05s para evitar problemas de precisão float
  const tolerance = 0.05;
  return sorted.find(w => w.start >= targetTime - tolerance) || null;
}

// Encontra a última palavra que termina em ou antes do tempo alvo
function findLastWordAtOrBefore(targetTime: number, words: Word[]): Word | null {
  if (!words || words.length === 0) return null;
  
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const tolerance = 0.05;
  
  // Filtra palavras que terminam antes ou no tempo alvo
  const candidates = sorted.filter(w => w.end <= targetTime + tolerance);
  
  // Retorna a última
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

// Calcula o ponto de corte ideal no SILÊNCIO entre palavras
function calculateSafeStartPoint(firstWord: Word, words: Word[]): number {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const idx = sorted.findIndex(w => w.start === firstWord.start);
  
  if (idx <= 0) {
    // É a primeira palavra - usa pequeno buffer antes
    return Math.max(0, firstWord.start - 0.15);
  }
  
  const prevWord = sorted[idx - 1];
  const silenceGap = firstWord.start - prevWord.end;
  
  // Ponto de corte: meio do silêncio, mas nunca mais que 0.3s antes da palavra
  const midSilence = prevWord.end + (silenceGap / 2);
  const maxBuffer = firstWord.start - 0.3;
  
  return Math.max(midSilence, maxBuffer, 0);
}

function calculateSafeEndPoint(lastWord: Word, words: Word[]): number {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const idx = sorted.findIndex(w => w.start === lastWord.start);
  
  if (idx === -1 || idx >= sorted.length - 1) {
    // É a última palavra - usa pequeno buffer depois
    return lastWord.end + 0.2;
  }
  
  const nextWord = sorted[idx + 1];
  const silenceGap = nextWord.start - lastWord.end;
  
  // Ponto de corte: meio do silêncio, mas nunca mais que 0.3s depois da palavra
  const midSilence = lastWord.end + (silenceGap / 2);
  const maxBuffer = lastWord.end + 0.3;
  
  return Math.min(midSilence, maxBuffer);
}

function generateSubtitleFile(words: Word[], videoStartTime: number, outputPath: string): void {
  let srtContent = '';

  words.forEach((w, index) => {
    // Tempo relativo ao início do vídeo cortado
    const relStart = Math.max(0, w.start - videoStartTime);
    const relEnd = Math.max(0, w.end - videoStartTime);
    
    if (relEnd <= relStart) return;

    srtContent += `${index + 1}\n`;
    srtContent += `${formatTimeSRT(relStart)} --> ${formatTimeSRT(relEnd)}\n`;
    srtContent += `${w.word}\n\n`;
  });
  
  fs.writeFileSync(outputPath, srtContent);
}

function runFFmpeg(inputPath: string, outputPath: string, cutStart: number, cutEnd: number, subtitlePath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const duration = cutEnd - cutStart;
    const s = cutStart.toFixed(3);
    const d = duration.toFixed(3);

    let videoFilter = 'crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:(ih-oh)/2,setsar=1';
    
    if (subtitlePath) {
      const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const style = "Fontname=Arial Bold,FontSize=24,PrimaryColour=&H0000FFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=4,Shadow=0,MarginV=70,Alignment=2";
      videoFilter += `,subtitles='${escapedPath}':force_style='${style}'`;
    }

    // Fade suave apenas nas bordas (0.1s)
    const fadeOutStart = Math.max(0, duration - 0.15);
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
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      outputPath
    ];

    console.log(`[FFmpeg] Corte preciso: ${s}s -> ${(parseFloat(s) + parseFloat(d)).toFixed(3)}s (duração: ${d}s)`);
    
    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args);
    let stderrData = '';
    ffmpeg.stderr.on('data', d => stderrData += d.toString());
    ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg error: ${stderrData}`)));
    ffmpeg.on('error', err => reject(err));
  });
}

fastify.post<{ Body: ProcessVideoBody }>('/process-video', { schema: processSchema }, async (request, reply) => {
  const { videoUrl, startTime, endTime, duration, jobId, words } = request.body;
  
  // Calcula o tempo final (suporta tanto endTime quanto duration para compatibilidade)
  const rawStart = Number(startTime);
  const rawEnd = endTime ? Number(endTime) : rawStart + Number(duration);
  
  const tempDir = os.tmpdir();
  const executionId = randomUUID();
  
  const inputPath = path.join(tempDir, `input_${executionId}.mp4`);
  const outputPath = path.join(tempDir, `output_${executionId}.mp4`);
  const subtitlePath = path.join(tempDir, `sub_${executionId}.srt`);
  
  const finalFileName = `cuts/${jobId}_${Date.now()}_${executionId.slice(0, 5)}.mp4`;

  try {
    request.log.info(`[${jobId}] Baixando vídeo...`);
    await downloadFile(videoUrl, inputPath);

    request.log.info(`[${jobId}] Tempos recebidos: início=${rawStart.toFixed(2)}s, fim=${rawEnd.toFixed(2)}s`);
    request.log.info(`[${jobId}] Palavras recebidas: ${words.length}`);

    // 1. ENCONTRA AS PALAVRAS ÂNCORA
    const firstWord = findFirstWordAtOrAfter(rawStart, words);
    const lastWord = findLastWordAtOrBefore(rawEnd, words);

    if (!firstWord || !lastWord) {
      throw new Error(`Não foi possível alinhar com palavras. Início: ${!!firstWord}, Fim: ${!!lastWord}`);
    }

    request.log.info(`[${jobId}] Primeira palavra: "${firstWord.word}" (${firstWord.start.toFixed(2)}s)`);
    request.log.info(`[${jobId}] Última palavra: "${lastWord.word}" (${lastWord.end.toFixed(2)}s)`);

    // 2. CALCULA PONTOS DE CORTE SEGUROS (no silêncio entre palavras)
    const safeStart = calculateSafeStartPoint(firstWord, words);
    const safeEnd = calculateSafeEndPoint(lastWord, words);

    request.log.info(`[${jobId}] Corte seguro: ${safeStart.toFixed(3)}s -> ${safeEnd.toFixed(3)}s`);

    // 3. FILTRA PALAVRAS PARA LEGENDA (apenas as que estão no corte)
    const wordsInCut = words.filter(w => w.start >= firstWord.start && w.end <= lastWord.end);
    
    // 4. GERA LEGENDA
    let subPathArg: string | undefined = undefined;
    if (wordsInCut.length > 0) {
      generateSubtitleFile(wordsInCut, safeStart, subtitlePath);
      subPathArg = subtitlePath;
      request.log.info(`[${jobId}] Legenda gerada com ${wordsInCut.length} palavras`);
    }

    // 5. EXECUTA FFMPEG
    request.log.info(`[${jobId}] Renderizando...`);
    await runFFmpeg(inputPath, outputPath, safeStart, safeEnd, subPathArg);

    // 6. UPLOAD
    request.log.info(`[${jobId}] Upload para S3...`);
    const fileBuffer = fs.readFileSync(outputPath);

    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: finalFileName,
      Body: fileBuffer,
      ContentType: 'video/mp4'
    }));

    const publicUrl = getPublicUrl(finalFileName);
    request.log.info(`[${jobId}] Concluído: ${publicUrl}`);
    
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
    console.log(`Worker FFmpeg (Corte Preciso) rodando na porta ${port}`);
  } catch (err) { 
    fastify.log.error(err); 
    process.exit(1); 
  }
};

start();
