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
  words: Word[];
}

const processSchema = {
  body: {
    type: 'object',
    required: ['videoUrl', 'startTime', 'duration', 'jobId'],
    properties: {
      videoUrl: { type: 'string', format: 'uri' },
      startTime: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      duration: { type: 'number' },
      jobId: { type: 'string' }
    }
  }
};

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
  // Pequeno offset visual para a legenda não aparecer antes do áudio
  const visualOffset = 0.0; 

  words.forEach((w, index) => {
    // Ajusta o tempo da legenda relativo ao novo corte
    const relStart = Math.max(0, w.start - globalStartTime + visualOffset);
    const relEnd = Math.max(0, w.end - globalStartTime + visualOffset);
    
    if (relEnd <= relStart) return;

    srtContent += `${index + 1}\n`;
    srtContent += `${formatTimeSRT(relStart)} --> ${formatTimeSRT(relEnd)}\n`;
    srtContent += `${w.word}\n\n`;
  });
  fs.writeFileSync(outputPath, srtContent);
}

// FUNÇÃO FFmpeg CORRIGIDA (Padding Aditivo)
function runFFmpeg(inputPath: string, outputPath: string, start: number, originalDuration: number, subtitlePath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    
    // 1. ESTRATÉGIA "OPUS CLIP":
    // Não cortamos no tempo exato. Nós expandimos.
    // - Recuamos 0.15s no início (para pegar a respiração/ataque)
    // - Avançamos 0.25s no final (para pegar o eco e dar espaço pro fade)
    
    const PAD_START = 0.15;
    const PAD_END = 0.25;

    // Garante que não recuamos para antes de 0
    const finalStart = Math.max(0, start - PAD_START);
    
    // O tempo de duração total aumenta com os paddings
    const finalDuration = originalDuration + (start - finalStart) + PAD_END;

    const s = finalStart.toFixed(3);
    const d = finalDuration.toFixed(3);

    // Filtros de vídeo
    let videoFilter = 'crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:(ih-oh)/2,setsar=1';
    
    if (subtitlePath) {
      const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      // Fonte Arial Bold, Amarela, Borda Grossa
      const style = "Fontname=Arial Bold,FontSize=24,PrimaryColour=&H0000FFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=4,Shadow=0,MarginV=70,Alignment=2";
      videoFilter += `,subtitles='${escapedPath}':force_style='${style}'`;
    }

    // FADE DE ÁUDIO "SAFE"
    // O Fade In acontece DURANTE o padding inicial (antes da palavra começar)
    // O Fade Out acontece DURANTE o padding final (depois da palavra acabar)
    // Resultado: A palavra fica 100% audível e limpa.
    const fadeOutStart = finalDuration - PAD_END; 
    const audioFilter = `afade=t=in:st=0:d=${PAD_START},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${PAD_END}`;

    const args = [
      '-y',
      '-ss', s,                 
      '-i', inputPath,          
      '-t', d,                  
      '-map', '0:v:0',          
      '-map', '0:a:0?',         
      '-vf', videoFilter,       
      '-af', audioFilter,       
      '-c:v', 'libx264',        // Re-encode para precisão
      '-preset', 'fast',        
      '-crf', '23',             
      '-pix_fmt', 'yuv420p',    
      '-c:a', 'aac',            
      '-b:a', '192k',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      outputPath
    ];

    console.log(`[FFmpeg] Processando: Start=${s}, Duration=${d} (Com Paddings)`);
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

    const numStart = Number(startTime);
    const numDuration = Number(duration);

    // GERA LEGENDA (Usando o padding para alinhar)
    let subPathArg: string | undefined = undefined;
    if (words && words.length > 0) {
        request.log.info(`[${jobId}] Gerando Legendas...`);
        // Precisamos compensar o padding inicial que o FFmpeg vai adicionar
        // Se o vídeo começa 0.15s antes, a legenda tem que "esperar" 0.15s para aparecer
        const PAD_START = 0.15;
        const adjustedStartForSubs = Math.max(0, numStart - PAD_START);
        generateSubtitleFile(words, adjustedStartForSubs, subtitlePath);
        subPathArg = subtitlePath;
    }

    request.log.info(`[${jobId}] Renderizando...`);
    
    // Passa os tempos ORIGINAIS. O runFFmpeg que vai calcular os paddings extras.
    await runFFmpeg(inputPath, outputPath, numStart, numDuration, subPathArg);

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
    console.log(`Worker Nativo (Safe Padding) rodando na porta ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();