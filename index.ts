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

// --- INTELIGÊNCIA DE ÁUDIO (SMART CUT V2 - EXPANSIVE) ---

interface SilenceInterval {
  start: number;
  end: number;
  duration: number;
}

// 1. Scanner de Silêncio
const detectSilences = (filePath: string, noiseDb = -30, minDuration = 0.2): Promise<SilenceInterval[]> => {
  return new Promise((resolve, reject) => {
    const silences: SilenceInterval[] = [];
    
    // Diminuímos minDuration para 0.2s para pegar pausas mais curtas de respiração
    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', [
      '-i', filePath,
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
      '-f', 'null',
      '-'
    ]);

    let logData = '';
    ffmpeg.stderr.on('data', d => logData += d.toString());

    ffmpeg.on('close', (code) => {
      if (code !== 0) return resolve([]); 

      const lines = logData.split('\n');
      let currentStart: number | null = null;

      for (const line of lines) {
        if (line.includes('silence_start')) {
          const match = line.match(/silence_start:\s+([0-9.]+)/);
          if (match) currentStart = parseFloat(match[1]);
        } 
        else if (line.includes('silence_end') && currentStart !== null) {
          const match = line.match(/silence_end:\s+([0-9.]+)/);
          if (match) {
            const end = parseFloat(match[1]);
            silences.push({ start: currentStart, end: end, duration: end - currentStart });
            currentStart = null;
          }
        }
      }
      resolve(silences);
    });
  });
};

// 2. Ajustador de Tempo (Expansivo)
const snapToSilence = (targetTime: number, silences: SilenceInterval[], type: 'start' | 'end'): number => {
  // CONFIGURAÇÕES DE FOLGA (PADDING)
  const START_BUFFER = 0.15; // 150ms antes da palavra começar (pega respiração)
  const END_BUFFER = 0.20;   // 200ms depois da palavra terminar (pega eco)

  if (type === 'start') {
    // LÓGICA DE INÍCIO:
    // Queremos encontrar o silêncio que termina ANTES do nosso targetTime.
    // Dentre eles, pegamos o que termina MAIS PERTO do targetTime (o último silêncio antes da fala).
    
    const previousSilences = silences.filter(s => s.end < targetTime);
    
    // Se não achou silêncio antes (é o começo do vídeo ou fala contínua), aplica buffer padrão
    if (previousSilences.length === 0) {
      return Math.max(0, targetTime - START_BUFFER);
    }

    // Pega o último silêncio antes da fala
    const bestSilence = previousSilences[previousSilences.length - 1];
    
    // Verifica a distância. Se o silêncio estiver muito longe (> 2s), ignora e usa buffer padrão
    if (targetTime - bestSilence.end > 2.0) {
       return Math.max(0, targetTime - START_BUFFER);
    }

    // O ponto de corte ideal é o FINAL desse silêncio - BUFFER.
    // Mas não podemos invadir o inicio desse mesmo silêncio.
    const idealStart = bestSilence.end - START_BUFFER;
    
    // Garante que não recuamos tanto a ponto de pegar a palavra anterior
    return Math.max(bestSilence.start + 0.05, idealStart); 
  } 
  else {
    // LÓGICA DE FIM:
    // Queremos encontrar o silêncio que começa DEPOIS do nosso targetTime.
    // Dentre eles, pegamos o que começa MAIS PERTO (o primeiro silêncio após a fala).
    
    const nextSilences = silences.filter(s => s.start > targetTime);

    if (nextSilences.length === 0) {
      return targetTime + END_BUFFER;
    }

    const bestSilence = nextSilences[0];

    // Se o silêncio estiver muito longe, ignora
    if (bestSilence.start - targetTime > 2.0) {
        return targetTime + END_BUFFER;
    }

    // O ponto de corte ideal é o INÍCIO desse silêncio + BUFFER.
    // Isso garante que pegamos o "rabo" da voz entrando no silêncio.
    const idealEnd = bestSilence.start + END_BUFFER;

    // Garante que não avançamos tanto a ponto de pegar a próxima palavra
    return Math.min(bestSilence.end - 0.05, idealEnd);
  }
};

// --- FUNÇÕES UTILITÁRIAS ---

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
  words.forEach((w, index) => {
    // Expande a janela da legenda levemente para garantir que não suma
    const wordStartAdjusted = w.start - 0.1;
    const wordEndAdjusted = w.end + 0.1;

    const relStart = Math.max(0, wordStartAdjusted - globalStartTime);
    const relEnd = Math.max(0, wordEndAdjusted - globalStartTime);
    
    // Se a palavra termina antes do corte começar, ignora
    if (relEnd <= 0) return;

    srtContent += `${index + 1}\n`;
    srtContent += `${formatTimeSRT(relStart)} --> ${formatTimeSRT(relEnd)}\n`;
    srtContent += `${w.word}\n\n`;
  });
  fs.writeFileSync(outputPath, srtContent);
}

// FUNÇÃO FFmpeg REFORÇADA (Audio Fade + Video Precision)
function runFFmpeg(inputPath: string, outputPath: string, start: number, duration: number, subtitlePath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    
    const s = start.toFixed(3);
    const d = duration.toFixed(3);

    // Crop Vertical para Shorts
    let videoFilter = 'crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:(ih-oh)/2,setsar=1';
    
    if (subtitlePath) {
      const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const style = "Fontname=Arial Bold,FontSize=24,PrimaryColour=&H0000FFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=4,Shadow=0,MarginV=70,Alignment=2";
      videoFilter += `,subtitles='${escapedPath}':force_style='${style}'`;
    }

    // FADE DE ÁUDIO MAIS CURTO E PRECISO
    // Fade IN: 0.05s (50ms) - Ultra rápido para não comer a primeira letra
    // Fade OUT: 0.1s (100ms) - Suave no final
    const audioFilter = `afade=t=in:st=0:d=0.05,afade=t=out:st=${(duration - 0.1).toFixed(3)}:d=0.1`;

    const args = [
      '-y',
      '-ss', s,                 
      '-i', inputPath,          
      '-t', d,                  
      '-map', '0:v:0',          
      '-map', '0:a:0?',         
      '-vf', videoFilter,       
      '-af', audioFilter,       
      '-c:v', 'libx264',        // Re-encoding obrigatório para precisão
      '-preset', 'fast',        
      '-crf', '23',             // Qualidade visual constante
      '-pix_fmt', 'yuv420p',    
      '-c:a', 'aac',            
      '-b:a', '192k',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      outputPath
    ];

    console.log('FFmpeg Command:', 'ffmpeg', args.join(' '));
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
  const { videoUrl, startTime: rawStartTime, duration: rawDuration, jobId, words } = request.body;
  const tempDir = os.tmpdir();
  const executionId = randomUUID();
  
  const inputPath = path.join(tempDir, `input_${executionId}.mp4`);
  const outputPath = path.join(tempDir, `output_${executionId}.mp4`);
  const subtitlePath = path.join(tempDir, `sub_${executionId}.srt`);
  
  const finalFileName = `cuts/${jobId}_${Date.now()}_${executionId.slice(0, 5)}.mp4`;

  try {
    request.log.info(`[${jobId}] Baixando vídeo original...`);
    await downloadFile(videoUrl, inputPath);

    // 1. Mapeia Silêncios
    request.log.info(`[${jobId}] 🕵️‍♂️ Mapeando silêncios (Smart Cut V2)...`);
    const silences = await detectSilences(inputPath);
    request.log.info(`[${jobId}] ✅ ${silences.length} intervalos de silêncio.`);

    // 2. Calcula tempos otimizados (EXPANSÃO)
    const nStart = Number(rawStartTime);
    const nEnd = nStart + Number(rawDuration);

    const smartStart = snapToSilence(nStart, silences, 'start');
    const smartEnd = snapToSilence(nEnd, silences, 'end');
    
    // Recalcula duração baseada no ajuste
    const smartDuration = smartEnd - smartStart;

    request.log.info(`[${jobId}] ✂️ Ajuste: ${nStart}->${smartStart.toFixed(2)} | Fim: ${nEnd}->${smartEnd.toFixed(2)}`);

    // 3. Gera Legenda (Com tempo ajustado)
    let subPathArg: string | undefined = undefined;
    if (words && words.length > 0) {
        request.log.info(`[${jobId}] Gerando Legendas...`);
        // Importante: passa o smartStart para sincronizar
        generateSubtitleFile(words, smartStart, subtitlePath);
        subPathArg = subtitlePath;
    }

    request.log.info(`[${jobId}] Renderizando com FFmpeg...`);
    await runFFmpeg(inputPath, outputPath, smartStart, smartDuration, subPathArg);

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
    console.log(`Worker Nativo (Smart Cut V2) rodando na porta ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();