import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'crypto';
import ffmpegPath from 'ffmpeg-static';

// __dirname equivalente para ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastify = Fastify({
  logger: true,
  connectionTimeout: 600000,
  keepAliveTimeout: 600000
});

await fastify.register(cors, { origin: true });

// --- CONFIGURAÇÃO ---
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
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
  forcePathStyle: true
});

function getPublicUrl(fileName: string) {
  if (process.env.PUBLIC_MEDIA_URL) {
    return `${process.env.PUBLIC_MEDIA_URL}/${fileName}`;
  }
  return `${S3_ENDPOINT}/${S3_BUCKET_NAME}/${fileName}`;
}

// --- FUNÇÃO DE NOTIFICAÇÃO AO BACKEND ---
async function notifyBackend(jobId: string, payload: object) {
  try {
    const url = `${BACKEND_URL}/jobs/${jobId}/progress`;
    // Fire and forget - não bloqueia o processamento
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => console.error(`[Webhook Error] Falha ao notificar backend: ${err.message}`));
  } catch (err) {
    console.error(`[Webhook Error] ${err}`);
  }
}

// --- DIAGNÓSTICO FFMPEG ---
function getFFmpegVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath || 'ffmpeg', ['-version']);
    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => stdout += d.toString());
    proc.on('close', (code: number | null) => {
      if (code === 0) {
        resolve((stdout.split('\n')[0] || stdout).trim());
      } else {
        reject(new Error('Failed to get FFmpeg version'));
      }
    });
    proc.on('error', reject);
  });
}

// --- UTILITÁRIOS DE TEMPO ---
function timeToSeconds(timeString: string): number {
  const parts = timeString.split(':');
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2]);
  return (h * 3600) + (m * 60) + s;
}

// --- INTERFACES ---
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
  shouldWatermark?: boolean;
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
      words: { type: 'array' },
      shouldWatermark: { type: 'boolean' }
    }
  }
};

// Caminho absoluto para o asset de watermark
// Em dev: __dirname é a raiz do projeto
// Em prod: __dirname é dist/, então precisamos subir um nível
const WATERMARK_PATH = fs.existsSync(path.resolve(__dirname, 'assets', 'watermark.png'))
  ? path.resolve(__dirname, 'assets', 'watermark.png')
  : path.resolve(__dirname, '..', 'assets', 'watermark.png');

// Watermark pré-escalado (criado no startup para evitar reprocessar o PNG de 6MB a cada frame)
const WATERMARK_SCALED_PATH = path.join(os.tmpdir(), 'watermark_80.png');

async function prepareWatermark(): Promise<boolean> {
  if (!fs.existsSync(WATERMARK_PATH)) {
    console.error('[Startup] Watermark original não encontrado');
    return false;
  }

  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath || 'ffmpeg', [
      '-y', '-i', WATERMARK_PATH,
      '-vf', 'scale=80:-2',
      WATERMARK_SCALED_PATH
    ]);
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => stderr += d.toString());
    proc.on('close', (code: number | null) => {
      if (code === 0 && fs.existsSync(WATERMARK_SCALED_PATH)) {
        const size = fs.statSync(WATERMARK_SCALED_PATH).size;
        console.log(`[Startup] Watermark pré-escalado: ${WATERMARK_SCALED_PATH} (${size} bytes)`);
        resolve(true);
      } else {
        console.error(`[Startup] Falha ao pré-escalar watermark: ${stderr.slice(-300)}`);
        resolve(false);
      }
    });
    proc.on('error', (err) => {
      console.error(`[Startup] Erro ao pré-escalar: ${err.message}`);
      resolve(false);
    });
  });
}

async function downloadFile(
  url: string,
  outputPath: string,
  onProgress: (pct: number) => void
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao baixar: ${response.statusText}`);

  const totalLength = Number(response.headers.get('content-length'));
  let downloaded = 0;
  let lastReport = 0;

  const fileStream = fs.createWriteStream(outputPath);

  if (!response.body) throw new Error('No body');

  const reader = response.body.getReader();

  while(true) {
    const { done, value } = await reader.read();
    if (done) break;

    downloaded += value.length;
    fileStream.write(value);

    // Retorna percentual bruto (0-100), o caller faz o mapeamento
    if (totalLength) {
      const percent = (downloaded / totalLength) * 100;
      // Throttle: só notifica a cada 10% para download rápido do R2
      if (percent - lastReport > 10) {
        onProgress(percent);
        lastReport = percent;
      }
    }
  }

  // Aguarda o arquivo ser completamente gravado no disco antes de retornar
  await new Promise<void>((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
    fileStream.end();
  });
}

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
    const startSeconds = Math.max(0, currentGroup[0].start - cutStartTime);
    const endSeconds = Math.max(0, currentGroup[currentGroup.length - 1].end - cutStartTime);

    const formatASS = (s: number) => {
      const date = new Date(0);
      date.setMilliseconds(s * 1000);
      return date.toISOString().substr(11, 10).replace('.', '.');
    };

    let karaokeText = '';
    currentGroup.forEach((w, i) => {
      const duration = Math.round((w.end - w.start) * 100);
      const space = i > 0 ? ' ' : '';
      karaokeText += `${space}{\\k${duration}}${w.word.toUpperCase()}`;
    });

    assContent += `Dialogue: 0,${formatASS(startSeconds)},${formatASS(endSeconds)},Default,,0,0,0,,${karaokeText}\n`;
    currentGroup = [];
    currentCharCount = 0;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.end < cutStartTime) continue;
    const prevWord = words[i-1];
    const isBigGap = prevWord && (w.start - prevWord.end > 0.5);
    if ((currentCharCount + w.word.length > 25) || isBigGap) flushGroup();
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
  watermarkPath: string | undefined,
  onProgress: (pct: number) => void,
  logger: any
): Promise<void> {
  return new Promise((resolve, reject) => {
    const duration = endTime - startTime;
    const fadeOutStart = Math.max(0, duration - 0.15);
    const audioFilter = `afade=t=in:st=0:d=0.08,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.15`;

    let args: string[];

    // Se tiver watermark, usa filter_complex para combinar vídeo + marca d'água
    if (watermarkPath && fs.existsSync(watermarkPath)) {
      // Constrói o filtro base para o vídeo
      let videoFilter = 'scale=-2:1080,crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:0,setsar=1';

      if (subtitlePath && fs.existsSync(subtitlePath)) {
        const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
        videoFilter += `,subtitles='${escapedPath}'`;
      }

      // filter_complex: processa vídeo e faz overlay com watermark pré-escalado
      // Watermark já está em 80px (pré-escalado no startup), aplica 50% opacidade
      // eof_action=repeat: repete o último frame do watermark por toda a duração
      const wmPath = fs.existsSync(WATERMARK_SCALED_PATH) ? WATERMARK_SCALED_PATH : watermarkPath;
      const wmNeedsScale = wmPath !== WATERMARK_SCALED_PATH;
      const wmFilter = wmNeedsScale ? 'scale=80:-2,format=rgba,colorchannelmixer=aa=0.5' : 'format=rgba,colorchannelmixer=aa=0.5';
      const filterComplex = `[0:v]${videoFilter}[video];[1:v]${wmFilter}[wm];[video][wm]overlay=W-w-20:H-h-20:eof_action=repeat[outv]`;

      args = [
        '-y', '-ss', startTime.toFixed(3), '-i', inputPath,
        '-i', wmPath,
        '-t', duration.toFixed(3),
        '-filter_complex', filterComplex,
        '-map', '[outv]', '-map', '0:a:0?',
        '-af', audioFilter,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
        '-threads', '4', outputPath
      ];

      logger.info(`FFmpeg com watermark: ${watermarkPath}`);
      logger.info(`filter_complex: ${filterComplex}`);
      logger.info(`FFmpeg args: ${JSON.stringify(args)}`);
    } else {
      // Sem watermark - usa -vf simples (mais eficiente)
      let videoFilter = 'scale=-2:1080,crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:0,setsar=1';

      if (subtitlePath && fs.existsSync(subtitlePath)) {
        const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
        videoFilter += `,subtitles='${escapedPath}'`;
      }

      args = [
        '-y', '-ss', startTime.toFixed(3), '-i', inputPath, '-t', duration.toFixed(3),
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', videoFilter, '-af', audioFilter,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
        '-threads', '4', outputPath
      ];
    }

    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args, { timeout: 300000 });
    let stderrData = '';
    let lastReport = 0;

    ffmpeg.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrData += chunk;

      const timeMatch = chunk.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (timeMatch) {
        const currentTime = timeToSeconds(timeMatch[1]);
        // Retorna percentual bruto (0-100), o caller faz o mapeamento
        const percent = Math.min(100, (currentTime / duration) * 100);

        // Throttle: só notifica a cada 5% para economizar rede
        if (percent - lastReport > 5) {
          onProgress(percent);
          lastReport = percent;
        }
      }
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        // Log diagnóstico direcionado
        const hasInput1 = stderrData.includes('Input #1');
        const streamMapping = stderrData.match(/Stream mapping[\s\S]*?(?=frame|Output|$)/)?.[0]?.trim() || 'NOT FOUND';
        const outputInfo = stderrData.match(/Output #0[\s\S]*?(?=frame|Stream mapping|$)/)?.[0]?.slice(0, 500) || 'NOT FOUND';
        logger.info(`FFmpeg Input #1 detectado: ${hasInput1}`);
        logger.info(`FFmpeg Stream mapping: ${streamMapping.slice(0, 500)}`);
        logger.info(`FFmpeg Output: ${outputInfo}`);
        resolve();
      } else {
        logger.error(`FFmpeg falhou (code ${code}). Stderr completo: ${stderrData}`);
        reject(new Error(`FFmpeg error (code ${code}): ${stderrData.slice(-500)}`));
      }
    });
    ffmpeg.on('error', (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
  });
}

// --- ROTA PRINCIPAL ---
fastify.post<{ Body: ProcessVideoBody }>('/process-video', {
  schema: processSchema
}, async (request, reply) => {
  const { videoUrl, startTime, endTime, jobId, words, shouldWatermark } = request.body;

  const tempDir = os.tmpdir();
  const executionId = randomUUID();
  const inputPath = path.join(tempDir, `input_${executionId}.mp4`);
  const outputPath = path.join(tempDir, `output_${executionId}.mp4`);
  const subtitlePath = path.join(tempDir, `sub_${executionId}.ass`);
  const finalFileName = `cuts/${jobId}_${Date.now()}_${executionId.slice(0, 5)}.mp4`;

  // Determina se deve aplicar watermark
  request.log.info(`shouldWatermark recebido: ${shouldWatermark} (tipo: ${typeof shouldWatermark})`);
  request.log.info(`WATERMARK_PATH: ${WATERMARK_PATH}, Existe: ${fs.existsSync(WATERMARK_PATH)}`);
  const watermarkPathArg = shouldWatermark && fs.existsSync(WATERMARK_PATH) ? WATERMARK_PATH : undefined;
  request.log.info(`watermarkPathArg final: ${watermarkPathArg || 'NENHUM (sem watermark)'}`);


  // Nova escala de progresso:
  // n8n: 0% → 50% (transcrição, GPT, seleção de cortes)
  // Worker: 50% → 100% (download R2, renderização, upload)
  //   - Download R2: 50% → 55% (rápido)
  //   - Renderização: 55% → 95%
  //   - Upload: 95% → 100%

  try {
    // Notifica o backend que o Worker começou (50%)
    notifyBackend(jobId, { status: 'rendering', progress: 50, message: 'Worker iniciado' });

    // 1. Download do R2 (50% → 55%) - rápido pois é do próprio cloud
    await downloadFile(videoUrl, inputPath, (pct) => {
      // pct vai de 0 a 100, mapeia para 50 a 55
      const globalPct = 50 + (pct / 100) * 5;
      notifyBackend(jobId, { status: 'downloading', progress: Math.floor(globalPct) });
    });

    // 2. Legendas
    let subPathArg: string | undefined;
    if (words && words.length > 0) {
      generateSubtitleFile(words, startTime, subtitlePath);
      subPathArg = subtitlePath;
    }

    // 3. Renderização (55% → 95%)
    await runFFmpeg(inputPath, outputPath, startTime, endTime, subPathArg, watermarkPathArg, (pct) => {
      // pct vai de 0 a 100, mapeia para 55 a 95
      const globalPct = 55 + (pct / 100) * 40;
      notifyBackend(jobId, { status: 'rendering', progress: Math.floor(globalPct) });
    }, request.log);

    // 4. Upload (95% → 100%)
    notifyBackend(jobId, { status: 'uploading', progress: 95 });

    const fileBuffer = fs.readFileSync(outputPath);
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: finalFileName,
      Body: fileBuffer,
      ContentType: 'video/mp4'
    }));

    const publicUrl = getPublicUrl(finalFileName);

    // Notifica sucesso final
    const result = { status: 'completed', progress: 100, url: publicUrl, success: true };
    notifyBackend(jobId, result);

    // Retorna JSON para o n8n
    return result;

  } catch (err) {
    const error = err as Error;
    request.log.error(`Erro: ${error.message}`);

    // Notifica erro ao backend
    notifyBackend(jobId, { status: 'error', progress: 0, error: error.message });

    reply.code(500);
    return { success: false, error: error.message };
  } finally {
    // Limpa arquivos temporários
    [inputPath, outputPath, subtitlePath].forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    });
  }
});

// --- DIAGNÓSTICO: Testa watermark overlay no ambiente atual ---
fastify.get('/test-watermark', async (request, reply) => {
  const tempDir = os.tmpdir();
  const testId = randomUUID().slice(0, 8);
  const testInput = path.join(tempDir, `wm_test_in_${testId}.mp4`);
  const testOutput = path.join(tempDir, `wm_test_out_${testId}.mp4`);

  try {
    // 1. FFmpeg version
    const version = await getFFmpegVersion();

    // 2. Watermark file info
    const wmExists = fs.existsSync(WATERMARK_PATH);
    const wmSize = wmExists ? fs.statSync(WATERMARK_PATH).size : 0;

    if (!wmExists) {
      return { success: false, error: 'Watermark file not found', path: WATERMARK_PATH };
    }

    // 3. Gera vídeo de teste 1s (cor sólida 1920x1080)
    let genStderr = '';
    await new Promise<void>((resolve, reject) => {
      const gen = spawn(ffmpegPath || 'ffmpeg', [
        '-y', '-f', 'lavfi', '-i', 'color=c=darkgreen:size=1920x1080:d=1',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-t', '1', testInput
      ]);
      gen.stderr.on('data', (d: Buffer) => genStderr += d.toString());
      gen.on('close', (code: number | null) =>
        code === 0 ? resolve() : reject(new Error(`Gen failed (${code}): ${genStderr.slice(-300)}`))
      );
      gen.on('error', reject);
    });

    // 4. Overlay watermark (mesmo filter_complex do worker - usa pré-escalado se disponível)
    const wmTestPath = fs.existsSync(WATERMARK_SCALED_PATH) ? WATERMARK_SCALED_PATH : WATERMARK_PATH;
    const wmTestNeedsScale = wmTestPath !== WATERMARK_SCALED_PATH;
    const wmTestFilter = wmTestNeedsScale ? 'scale=80:-2,format=rgba,colorchannelmixer=aa=0.5' : 'format=rgba,colorchannelmixer=aa=0.5';
    const filterComplex = `[0:v]scale=-2:1080,crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:0,setsar=1[video];[1:v]${wmTestFilter}[wm];[video][wm]overlay=W-w-20:H-h-20:eof_action=repeat[outv]`;
    let overlayStderr = '';
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath || 'ffmpeg', [
        '-y', '-i', testInput, '-i', wmTestPath, '-t', '1',
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        testOutput
      ]);
      proc.stderr.on('data', (d: Buffer) => overlayStderr += d.toString());
      proc.on('close', (code: number | null) =>
        code === 0 ? resolve() : reject(new Error(`Overlay failed (${code}): ${overlayStderr.slice(-500)}`))
      );
      proc.on('error', reject);
    });

    // 5. Resultado
    const outputExists = fs.existsSync(testOutput);
    const outputSize = outputExists ? fs.statSync(testOutput).size : 0;

    const scaledExists = fs.existsSync(WATERMARK_SCALED_PATH);
    const scaledSize = scaledExists ? fs.statSync(WATERMARK_SCALED_PATH).size : 0;

    return {
      success: true,
      ffmpegVersion: version,
      ffmpegBinary: ffmpegPath,
      watermark: { path: WATERMARK_PATH, exists: wmExists, sizeBytes: wmSize },
      watermarkScaled: { path: WATERMARK_SCALED_PATH, exists: scaledExists, sizeBytes: scaledSize, usedInTest: wmTestPath === WATERMARK_SCALED_PATH },
      output: { exists: outputExists, sizeBytes: outputSize },
      filterComplex,
      overlayStderr: overlayStderr.slice(-1500)
    };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
      watermark: { path: WATERMARK_PATH, exists: fs.existsSync(WATERMARK_PATH), sizeBytes: fs.existsSync(WATERMARK_PATH) ? fs.statSync(WATERMARK_PATH).size : 0 }
    };
  } finally {
    [testInput, testOutput].forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    });
  }
});

fastify.get('/health', async () => ({ status: 'ok' }));

const start = async () => {
  // Startup diagnostics
  try {
    const version = await getFFmpegVersion();
    console.log(`[Startup] FFmpeg: ${version}`);
    console.log(`[Startup] FFmpeg binary: ${ffmpegPath}`);
  } catch (e) {
    console.error(`[Startup] FFmpeg não encontrado: ${(e as Error).message}`);
  }

  const wmExists = fs.existsSync(WATERMARK_PATH);
  const wmSize = wmExists ? fs.statSync(WATERMARK_PATH).size : 0;
  console.log(`[Startup] Watermark original: ${WATERMARK_PATH} | Existe: ${wmExists} | Tamanho: ${wmSize} bytes`);

  // Pré-escala o watermark para 80px (evita reprocessar 6MB a cada frame)
  if (wmExists) {
    await prepareWatermark();
  }

  const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`Worker rodando na porta ${port}`);
};

start();
