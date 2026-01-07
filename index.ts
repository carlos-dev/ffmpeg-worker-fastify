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

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: true });

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

interface ProcessVideoBody {
  videoUrl: string;
  startTime: string | number;
  duration: number;
  jobId: string;
}

const processSchema = {
  body: {
    type: 'object',
    required: ['videoUrl', 'startTime', 'duration', 'jobId'],
    properties: {
      videoUrl: { type: 'string', format: 'uri' },
      startTime: { type: ['string', 'number'] },
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

// Função para rodar FFmpeg nativamente
function runFFmpeg(input: string, output: string, start: string | number, duration: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Monta o comando: ffmpeg -ss 10 -t 5 -i input.mp4 -c copy output.mp4
    // DICA: Colocar -ss antes do -i é muito mais rápido (Input Seeking)
    const args = [
      '-y',              // Sobrescrever se existir
      '-ss', `${start}`, // Ponto de inicio
      '-t', `${duration}`, // Duração
      '-i', input,       // Arquivo de entrada
      '-c', 'copy',      // <--- IMPORTANTE: "Copy" não re-renderiza, é instantâneo!
                         // Se der erro no player, remova essa linha para re-codificar (mais lento).
      output             // Saída
    ];

    const ffmpegProcess = spawn('ffmpeg', args);

    // Opcional: Logar saída do FFmpeg para debug
    // ffmpegProcess.stderr.on('data', (data) => console.log(`FFmpeg: ${data}`));

    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg saiu com código ${code}`));
      }
    });

    ffmpegProcess.on('error', (err) => {
      reject(err);
    });
  });
}

fastify.post<{ Body: ProcessVideoBody }>('/process-video', { schema: processSchema }, async (request, reply) => {
  const { videoUrl, startTime, duration, jobId } = request.body;
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `input_${jobId}.mp4`);
  const outputPath = path.join(tempDir, `output_${jobId}.mp4`);
  const finalFileName = `cuts/${jobId}_${Date.now()}.mp4`;

  try {
    request.log.info(`[${jobId}] Baixando...`);
    await downloadFile(videoUrl, inputPath);

    request.log.info(`[${jobId}] Cortando (Nativo)...`);

    // Chama nossa função nativa
    await runFFmpeg(inputPath, outputPath, startTime, duration);

    request.log.info(`[${jobId}] Uploading...`);
    const fileBuffer = fs.readFileSync(outputPath);

    const { error: uploadError } = await supabase
      .storage
      .from('videos')
      .upload(finalFileName, fileBuffer, {
        contentType: 'video/mp4',
        upsert: true
      });

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