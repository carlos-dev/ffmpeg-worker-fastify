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
import ffmpegPath from 'ffmpeg-static'; // Certifique-se de instalar: npm install ffmpeg-static

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

// --- INTELIGÊNCIA DE ÁUDIO (SMART CUT) ---

interface SilenceInterval {
  start: number;
  end: number;
  duration: number;
}

// 1. Scanner de Silêncio
const detectSilences = (filePath: string, noiseDb = -30, minDuration = 0.3): Promise<SilenceInterval[]> => {
  return new Promise((resolve, reject) => {
    const silences: SilenceInterval[] = [];
    
    // Comando para detectar silêncio sem gerar arquivo de saída
    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', [
      '-i', filePath,
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
      '-f', 'null',
      '-'
    ]);

    let logData = '';

    ffmpeg.stderr.on('data', (data) => {
      logData += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) return reject(new Error(`FFmpeg Silence Scanner failed: ${code}`));

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

// 2. Ajustador de Tempo (Magneto)
const snapToSilence = (targetTime: number, silences: SilenceInterval[], type: 'start' | 'end'): number => {
  // Procura silêncios num raio de 2 segundos
  const candidates = silences.filter(s => {
    const point = type === 'start' ? s.end : s.start;
    return Math.abs(point - targetTime) < 2.0;
  });

  // Fallback se não achar silêncio: Padding padrão conservador
  if (candidates.length === 0) {
    return type === 'start' ? Math.max(0, targetTime - 0.15) : targetTime + 0.15;
  }

  // Ordena pelo silêncio mais próximo matematicamente
  candidates.sort((a, b) => {
    const pA = type === 'start' ? a.end : a.start;
    const pB = type === 'start' ? b.end : b.start;
    return Math.abs(pA - targetTime) - Math.abs(pB - targetTime);
  });

  const best = candidates[0];

  if (type === 'start') {
    // INÍCIO: Queremos o FIM do silêncio (ataque da voz).
    // Cortamos 0.1s ANTES da voz começar.
    return Math.max(0, best.end - 0.1);
  } else {
    // FIM: Queremos o INÍCIO do silêncio (fim da voz).
    // Cortamos 0.1s DEPOIS do silêncio começar.
    return best.start + 0.1;
  }
};

// --- FUNÇÕES UTILITÁRIAS ---

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
  words.forEach((w, index) => {
    const relStart = Math.max(0, w.start - globalStartTime);
    const relEnd = Math.max(0, w.end - globalStartTime);
    
    if (relEnd <= relStart) return;

    srtContent += `${index + 1}\n`;
    srtContent += `${formatTimeSRT(relStart)} --> ${formatTimeSRT(relEnd)}\n`;
    srtContent += `${w.word}\n\n`;
  });
  fs.writeFileSync(outputPath, srtContent);
}

// FUNÇÃO FFmpeg REFORÇADA (Com Fade de Áudio)
function runFFmpeg(inputPath: string, outputPath: string, start: number, duration: number, subtitlePath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    
    // Formata para 3 casas decimais para o FFmpeg não reclamar
    const s = start.toFixed(3);
    const d = duration.toFixed(3);

    // Filtros de vídeo
    let videoFilter = 'crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:(ih-oh)/2,setsar=1';
    
    // Legendas
    if (subtitlePath) {
      const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const style = "Fontname=Arial Bold,FontSize=24,PrimaryColour=&H0000FFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=4,Shadow=0,MarginV=70,Alignment=2";
      videoFilter += `,subtitles='${escapedPath}':force_style='${style}'`;
    }

    // Filtro de áudio: Fade In/Out para evitar "ploc" no corte
    // afade=in no começo (0.1s) e afade=out no final (0.1s antes de acabar)
    const audioFilter = `afade=t=in:st=0:d=0.1,afade=t=out:st=${(duration - 0.1).toFixed(3)}:d=0.1`;

    const args = [
      '-y',
      '-ss', s,                 
      '-i', inputPath,          
      '-t', d,                  // Duration no input para precisão rápida, ou output para exatidão. Vamos manter aqui por enquanto.
      '-map', '0:v:0',          
      '-map', '0:a:0?',         
      '-vf', videoFilter,       
      '-af', audioFilter,       // NOVO: Filtro de áudio suave
      '-c:v', 'libx264',        
      '-preset', 'fast',        
      '-pix_fmt', 'yuv420p',    
      '-c:a', 'aac',            
      '-b:a', '128k',
      '-avoid_negative_ts', 'make_zero', // Garante sincronia
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
  // Recebe startTime e duration crus do n8n
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

    // --- SMART CUT INTELLIGENCE ---
    request.log.info(`[${jobId}] 🕵️‍♂️ Mapeando silêncios reais...`);
    
    // 1. Detecta Silêncios
    const silences = await detectSilences(inputPath);
    request.log.info(`[${jobId}] ✅ Encontrados ${silences.length} intervalos de silêncio.`);

    // 2. Calcula tempos otimizados
    const nStart = Number(rawStartTime);
    const nEnd = nStart + Number(rawDuration);

    const smartStart = snapToSilence(nStart, silences, 'start');
    const smartEnd = snapToSilence(nEnd, silences, 'end');
    
    const smartDuration = smartEnd - smartStart;

    request.log.info(`[${jobId}] ✂️ Ajuste de Tempo:`);
    request.log.info(`   Original: ${nStart} -> ${nEnd} (Dur: ${rawDuration})`);
    request.log.info(`   SmartCut: ${smartStart.toFixed(3)} -> ${smartEnd.toFixed(3)} (Dur: ${smartDuration.toFixed(3)})`);
    // ------------------------------

    // GERA LEGENDA (Ajustada para o novo tempo)
    let subPathArg: string | undefined = undefined;
    if (words && words.length > 0) {
        request.log.info(`[${jobId}] Gerando Legendas...`);
        // Importante: Passamos o smartStart para alinhar a legenda com o novo corte
        generateSubtitleFile(words, smartStart, subtitlePath);
        subPathArg = subtitlePath;
    }

    request.log.info(`[${jobId}] Renderizando (Smart Cut + Fade)...`);
    // Usa os tempos inteligentes
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
    console.log(`Worker Nativo (Smart Cut) rodando na porta ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();