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

const extractAudioSchema = {
  body: {
    type: 'object',
    required: ['videoUrl', 'jobId'],
    properties: {
      videoUrl: { type: 'string', format: 'uri' },
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

// --- GERADOR DE SRT ---
function formatTimeSRT(seconds: number): string {
  const date = new Date(0);
  date.setMilliseconds(seconds * 1000);
  const iso = date.toISOString().substr(11, 12); // HH:mm:ss.sss
  return iso.replace('.', ','); // SRT usa vírgula
}

function generateSubtitleFile(words: Word[], globalStartTime: number, outputPath: string): void {
  let srtContent = '';
  
  // Como o vídeo foi cortado, o tempo "0" da legenda deve ser o inicio do corte
  // Se a palavra começa em 50s e o corte é em 50s, a legenda é em 0s.
  words.forEach((w, index) => {
    const relStart = Math.max(0, w.start - globalStartTime);
    const relEnd = Math.max(0, w.end - globalStartTime);
    
    // Filtra palavras que ficaram fora do corte (por segurança)
    if (relEnd <= relStart) return;

    srtContent += `${index + 1}\n`;
    srtContent += `${formatTimeSRT(relStart)} --> ${formatTimeSRT(relEnd)}\n`;
    srtContent += `${w.word}\n\n`;
  });

  fs.writeFileSync(outputPath, srtContent);
}

// FUNÇÃO FFmpeg MELHORADA (Para mostrar o erro real)
function runFFmpeg(inputPath: string, outputPath: string, start: string | number, duration: number, subtitlePath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const numStart = Number(start);
    const numDuration = Number(duration);
    
    const s = numStart.toFixed(3);
    const d = numDuration.toFixed(3);

    // 1. Crop Vertical
    let videoFilter = 'crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:(ih-oh)/2,setsar=1';
    
    // 2. Se tiver legenda, adiciona o filtro de subtitles
    // force_style: Define fonte, tamanho, cor (Amarelo primário), borda preta
    if (subtitlePath) {
        // Escapamos o caminho do arquivo para o FFmpeg não se perder
        const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
        
        // Estilo "Viral": Fonte Roboto/Arial, Amarelo Claro (&H00FFFF), Borda Preta Grossa
        const style = "Fontname=Arial,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=3,Shadow=0,MarginV=60,Alignment=2";
        videoFilter += `,subtitles='${escapedPath}':force_style='${style}'`;
    }

    const args = [
      '-y',
      '-ss', s,                 
      '-t', d,                  
      '-i', inputPath,          
      '-map', '0:v:0',          
      '-map', '0:a:0?',         
      '-vf', videoFilter,       
      '-c:v', 'libx264',        
      '-preset', 'fast',        
      '-pix_fmt', 'yuv420p',    
      '-c:a', 'aac',            
      '-b:a', '128k',           
      '-movflags', '+faststart',
      outputPath
    ];

    console.log('FFmpeg Command:', 'ffmpeg', args.join(' '));
    const ffmpeg = spawn('ffmpeg', args);
    
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
    request.log.info(`[${jobId}] Baixando...`);
    await downloadFile(videoUrl, inputPath);

    // GERA LEGENDA (Se houver palavras)
    let subPathArg: string | undefined = undefined;
    if (words && words.length > 0) {
        request.log.info(`[${jobId}] Gerando Legendas...`);
        // Usamos o startTime numerico para calcular o offset
        generateSubtitleFile(words, Number(startTime), subtitlePath);
        subPathArg = subtitlePath;
    }

    request.log.info(`[${jobId}] Renderizando com FFmpeg...`);
    await runFFmpeg(inputPath, outputPath, startTime, duration, subPathArg);

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
    console.log(`Worker Nativo rodando na porta ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();