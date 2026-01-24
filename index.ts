import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import ffmpegPath from 'ffmpeg-static'; 

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: true });

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

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
  words: Word[]; // Obrigatório ter a lista de palavras do Deepgram
}

const processSchema = {
  body: {
    type: 'object',
    required: ['videoUrl', 'startTime', 'duration', 'jobId', 'words'], // Words é obrigatório agora
    properties: {
      videoUrl: { type: 'string', format: 'uri' },
      startTime: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      duration: { type: 'number' },
      jobId: { type: 'string' },
      words: { type: 'array' }
    }
  }
};

// --- NOVA LÓGICA: SNAP TO WORD BOUNDARY ---

/**
 * Encontra o início exato da palavra mais próxima do tempo alvo.
 */
function findExactWordStart(targetTime: number, words: Word[]): number {
  if (!words || words.length === 0) return targetTime;

  // Encontra a palavra que contém o tempo alvo ou está mais próxima
  // Ex: Target 10.5. Palavra "Brasil" (10.2 -> 10.8). Retorna 10.2
  const match = words.find(w => targetTime >= w.start && targetTime <= w.end);
  
  if (match) {
    // Achou a palavra exata que está sendo falada neste segundo
    return match.start;
  }

  // Se o corte caiu num silêncio, pega a próxima palavra imediatamente
  const nextWord = words.find(w => w.start > targetTime);
  if (nextWord) return nextWord.start;

  return targetTime;
}

/**
 * Encontra o fim exato da palavra mais próxima do tempo alvo.
 */
function findExactWordEnd(targetTime: number, words: Word[]): number {
  if (!words || words.length === 0) return targetTime;

  // Encontra a palavra que contém o tempo alvo
  const match = words.find(w => targetTime >= w.start && targetTime <= w.end);
  
  if (match) {
    return match.end;
  }

  // Se caiu no silêncio, pega o fim da palavra anterior
  // Ordenamos reverso para achar a anterior mais próxima
  const prevWords = words.filter(w => w.end < targetTime);
  if (prevWords.length > 0) {
    return prevWords[prevWords.length - 1].end;
  }

  return targetTime;
}

// --- FIM DA LÓGICA ---

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao baixar: ${response.statusText}`);
  if (!response.body) throw new Error('Response body is null');
  await pipeline(Readable.fromWeb(response.body as any), fs.createWriteStream(outputPath));
}

function formatTimeSRT(seconds: number): string {
  const date = new Date(0);
  date.setMilliseconds(seconds * 1000);
  const iso = date.toISOString().substr(11, 12); 
  return iso.replace('.', ','); 
}

function generateSubtitleFile(words: Word[], globalStartTime: number, outputPath: string): void {
  let srtContent = '';
  // Pequeno ajuste para a legenda não "piscar" muito rápido
  const buffer = 0.0; 

  words.forEach((w, index) => {
    const relStart = Math.max(0, w.start - globalStartTime);
    const relEnd = Math.max(0, w.end - globalStartTime + buffer);
    
    if (relEnd <= relStart) return;

    srtContent += `${index + 1}\n`;
    srtContent += `${formatTimeSRT(relStart)} --> ${formatTimeSRT(relEnd)}\n`;
    srtContent += `${w.word}\n\n`;
  });
  fs.writeFileSync(outputPath, srtContent);
}

function runFFmpeg(inputPath: string, outputPath: string, start: number, end: number, subtitlePath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    
    // --- SEGURANÇA DE CORTE (BUFFER) ---
    // Agora que sabemos o tempo EXATO da palavra, damos um respiro minúsculo.
    // Start: Tira 0.1s para pegar a inspiração.
    // End: Adiciona 0.15s para pegar o "s" ou "r" final.
    const SAFE_START = Math.max(0, start - 0.10);
    const SAFE_END = end + 0.15;
    const duration = SAFE_END - SAFE_START;

    const s = SAFE_START.toFixed(3);
    const d = duration.toFixed(3);

    // Filtros
    let videoFilter = 'crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:(ih-oh)/2,setsar=1';
    
    if (subtitlePath) {
      const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const style = "Fontname=Arial Bold,FontSize=24,PrimaryColour=&H0000FFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=4,Shadow=0,MarginV=70,Alignment=2";
      videoFilter += `,subtitles='${escapedPath}':force_style='${style}'`;
    }

    // FADE SUAVE E CURTO
    // Como o corte já está na fronteira da palavra, um fade curto (0.05) tira o "click" digital sem comer a voz.
    const fadeOutStart = duration - 0.1;
    const audioFilter = `afade=t=in:st=0:d=0.05,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.1`;

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

    console.log(`[FFmpeg] Word-Snap: ${s} -> ${d} (Original Req: ${start.toFixed(2)}-${end.toFixed(2)})`);
    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args);
    
    let stderrData = '';
    ffmpeg.stderr.on('data', d => stderrData += d.toString());
    
    ffmpeg.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg error: ${stderrData}`));
    });
    ffmpeg.on('error', err => reject(err));
  });
}

// --- ROTA PRINCIPAL ---

fastify.post<{ Body: ProcessVideoBody }>('/process-video', { schema: processSchema }, async (request, reply) => {
  const { videoUrl, startTime, duration, jobId, words } = request.body;
  const tempDir = os.tmpdir();
  const executionId = randomUUID();
  
  const inputPath = path.join(tempDir, `input_${executionId}.mp4`);
  const outputPath = path.join(tempDir, `output_${executionId}.mp4`);
  const subtitlePath = path.join(tempDir, `sub_${executionId}.srt`);
  
  const finalFileName = `cuts/${jobId}_${Date.now()}_${executionId.slice(0, 5)}.mp4`;

  try {
    request.log.info(`[${jobId}] Baixando vídeo...`);
    await downloadFile(videoUrl, inputPath);

    // --- ALINHAMENTO POR PALAVRA (O PULO DO GATO) ---
    // Ignoramos a precisão do GPT e confiamos na precisão do Deepgram
    const rawStart = Number(startTime);
    const rawEnd = rawStart + Number(duration);

    // 1. Acha o INÍCIO REAL da palavra onde o GPT mandou cortar
    const snappedStart = findExactWordStart(rawStart, words);
    
    // 2. Acha o FIM REAL da palavra onde o GPT mandou parar
    const snappedEnd = findExactWordEnd(rawEnd, words);

    request.log.info(`[${jobId}] 🎯 Snap: GPT(${rawStart.toFixed(2)}-${rawEnd.toFixed(2)}) -> WORD(${snappedStart.toFixed(2)}-${snappedEnd.toFixed(2)})`);

    // GERA LEGENDA (Usando o tempo alinhado - 0.10s de buffer que o FFmpeg vai colocar)
    let subPathArg: string | undefined = undefined;
    if (words && words.length > 0) {
        // Compensamos o SAFE_START (0.10s) que vamos adicionar no FFmpeg
        const subOffset = Math.max(0, snappedStart - 0.10);
        generateSubtitleFile(words, subOffset, subtitlePath);
        subPathArg = subtitlePath;
    }

    request.log.info(`[${jobId}] Renderizando...`);
    // Passamos os tempos ALINHADOS. O runFFmpeg aplicará o buffer de segurança.
    await runFFmpeg(inputPath, outputPath, snappedStart, snappedEnd, subPathArg);

    request.log.info(`[${jobId}] Uploading...`);
    const fileBuffer = fs.readFileSync(outputPath);

    const { error: uploadError } = await supabase
      .storage
      .from('videos')
      .upload(finalFileName, fileBuffer, { contentType: 'video/mp4', upsert: true });

    if (uploadError) throw uploadError;

    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/videos/${finalFileName}`;
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
    console.log(`Worker Nativo (Word Snapping) rodando na porta ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();