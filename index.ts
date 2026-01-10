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

interface ExtractAudioBody {
  videoUrl: string;
  jobId: string;
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

// Função para rodar FFmpeg nativamente
function runFFmpeg(input: string, output: string, start: string | number, duration: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Monta o comando: ffmpeg -ss 10 -t 5 -i input.mp4 -c copy output.mp4
    // DICA: Colocar -ss antes do -i é muito mais rápido (Input Seeking)
    const args = [
      '-y',                       // Sobrescrever arquivo se existir
      '-ss', `${start}`,          // Ponto de início
      '-t', `${duration}`,        // Duração do corte
      '-i', input,                // Arquivo de entrada

      // Filtro para cortar em 9:16 (Vertical) centralizado
      // Lógica: "A nova largura será a Altura * (9/16). A altura continua a mesma."
      '-vf', 'crop=ih*(9/16):ih', 
      
      // Codecs obrigatórios para aplicar o filtro e garantir compatibilidade
      '-c:v', 'libx264',          // Codec de vídeo padrão para web
      '-preset', 'fast',          // Velocidade vs Compressão (fast é bom para workers)
      '-c:a', 'aac',              // Codec de áudio padrão
      '-b:a', '128k',             // Qualidade de áudio
      '-movflags', '+faststart',  // Otimização para streaming (buffer carrega rápido)
      
      output                      // Arquivo de saída
    ];

    console.log('Comando FFmpeg:', 'ffmpeg', args.join(' ')); // Log para você ver o comando rodando

    const ffmpegProcess = spawn('ffmpeg', args);

    // Opcional: Logar saída do FFmpeg para debug
    ffmpegProcess.stderr.on('data', (data) => console.log(`FFmpeg: ${data}`));

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

// Função para verificar se o vídeo tem áudio usando ffprobe
function hasAudioStream(input: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const ffprobeProcess = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      input
    ]);

    let output = '';
    ffprobeProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffprobeProcess.on('close', (code) => {
      // Se encontrou stream de áudio, output será "audio"
      resolve(output.trim() === 'audio');
    });

    ffprobeProcess.on('error', () => {
      // Se ffprobe falhar, assumimos que não tem áudio
      resolve(false);
    });
  });
}

// Função para extrair áudio otimizado para IA (Whisper)
// Gera arquivos de ~15MB por hora de áudio (limite Whisper: 25MB)
function extractAudio(input: string, output: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Comando otimizado para Whisper (Mono, 32k bitrate)
    // Isso gera arquivos de ~15MB por hora de duração.
    const args = [
      '-y',                    // Sobrescrever arquivo se existir
      '-i', input,             // Arquivo de entrada
      '-vn',                   // Remove vídeo
      '-acodec', 'libmp3lame', // Codec MP3
      '-b:a', '32k',         // 32kbps é qualidade de podcast padrão, leve e compatível
      output                   // Arquivo de saída
    ];

    console.log('Comando FFmpeg (Audio):', 'ffmpeg', args.join(' '));

    const ffmpegProcess = spawn('ffmpeg', args);

    // Captura COMPLETA do stderr para debug
    let stderrOutput = '';
    ffmpegProcess.stderr.on('data', (data) => {
      const message = data.toString();
      stderrOutput += message;
      console.log(`FFmpeg Audio: ${message}`);
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Detecta se o erro é por falta de áudio
        if (stderrOutput.includes('does not contain any stream') ||
            stderrOutput.includes('Output file is empty')) {
          reject(new Error('O vídeo não contém áudio. Não é possível extrair áudio de um vídeo sem trilha sonora.'));
        } else {
          reject(new Error(`FFmpeg Audio saiu com código ${code}. Detalhes:\n${stderrOutput}`));
        }
      }
    });

    ffmpegProcess.on('error', (err) => {
      reject(new Error(`Erro ao executar FFmpeg: ${err.message}`));
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

// Rota para extrair áudio do vídeo (para IA/Whisper)
fastify.post<{ Body: ExtractAudioBody }>('/extract-audio', { schema: extractAudioSchema }, async (request, reply) => {
  const { videoUrl, jobId } = request.body;
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `input_audio_${jobId}.mp4`);
  const outputPath = path.join(tempDir, `audio_${jobId}.mp3`);
  const finalFileName = `audio/${jobId}_${Date.now()}.mp3`;

  try {
    request.log.info(`[${jobId}] Baixando vídeo para extração de áudio...`);
    await downloadFile(videoUrl, inputPath);

    request.log.info(`[${jobId}] Verificando se o vídeo tem áudio...`);
    const hasAudio = await hasAudioStream(inputPath);

    if (!hasAudio) {
      reply.code(400);
      return {
        success: false,
        error: 'O vídeo não contém áudio. Não é possível extrair áudio de um vídeo sem trilha sonora.'
      };
    }

    request.log.info(`[${jobId}] Extraindo áudio...`);
    await extractAudio(inputPath, outputPath);

    request.log.info(`[${jobId}] Fazendo upload do áudio...`);
    const fileBuffer = fs.readFileSync(outputPath);

    // Tenta fazer upload
    let uploadResult = await supabase
      .storage
      .from('audio')
      .upload(finalFileName, fileBuffer, {
        contentType: 'audio/mpeg',
        upsert: true
      });

    // Se o bucket não existir, tenta criar
    if (uploadResult.error && uploadResult.error.message.includes('Bucket not found')) {
      request.log.info(`[${jobId}] Bucket 'audio' não existe, criando...`);

      const { error: createBucketError } = await supabase
        .storage
        .createBucket('audio', {
          public: true,
          fileSizeLimit: 52428800 // 50MB
        });

      if (createBucketError && !createBucketError.message.includes('already exists')) {
        throw new Error(`Erro ao criar bucket: ${createBucketError.message}`);
      }

      // Tenta upload novamente
      uploadResult = await supabase
        .storage
        .from('audio')
        .upload(finalFileName, fileBuffer, {
          contentType: 'audio/mpeg',
          upsert: true
        });
    }

    if (uploadResult.error) throw uploadResult.error;

    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/audio/${finalFileName}`;

    request.log.info(`[${jobId}] Áudio extraído com sucesso: ${publicUrl}`);
    return { success: true, url: publicUrl };

  } catch (err) {
    const error = err as Error;
    request.log.error(`[${jobId}] Erro ao extrair áudio: ${error.message}`);
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