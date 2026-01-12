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

// FUNÇÃO FFmpeg MELHORADA (Para mostrar o erro real)
function runFFmpeg(inputPath: string, outputPath: string, start: string | number, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // Garante que são strings para o array de argumentos
    const s = Number(start).toFixed(3); 
    const d = Number(duration).toFixed(3);

    const videoFilter = 'crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:(ih-oh)/2,setsar=1';

    const args = [
      '-y',                     // Sobrescreve output sempre (primeiro argumento é boa prática)
      '-i', inputPath,          // Input
      '-ss', s,                 // Start Time (antes do input ou logo depois é ok, aqui é preciso)
      '-t', d,                  // Duration
      '-vf', videoFilter,       // Filtro de Vídeo (Verticalização)
      '-c:v', 'libx264',        // Codec de Vídeo
      '-pix_fmt', 'yuv420p',    // Formato de Pixel (Essencial para navegadores)
      '-c:a', 'aac',            // Codec de Áudio
      '-movflags', '+faststart',// Otimização para Web
      outputPath                // Arquivo Final
    ];

    console.log(`COMMAND: ffmpeg ${args.join(' ')}`);

    const ffmpeg = spawn('ffmpeg', args);

    // CAPTURA O LOG DE ERRO DO FFMPEG
    let stderrData = '';
    
    ffmpeg.stderr.on('data', (data) => {
      stderrData += data.toString();
      // Descomente a linha abaixo se quiser ver o log em tempo real (pode ser muito texto)
      // console.log(data.toString()); 
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Loga o erro crítico
        console.error(`FFmpeg Falhou! Código: ${code}`);
        console.error(`Detalhes do Erro:\n${stderrData}`);
        
        // Tenta identificar o erro comum para ajudar no debug
        if (stderrData.includes('Invalid crop')) {
            reject(new Error('Erro de Crop: A resolução do vídeo original não permite este corte vertical.'));
        } else {
            reject(new Error(`FFmpeg erro ${code}: Verifique logs.`));
        }
      }
    });

    ffmpeg.on('error', (err) => {
      fastify.log.error(`Falha ao iniciar processo: ${err.message}`);
        reject(new Error(`Falha ao iniciar processo: ${err.message}`));
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
      '-y',
      '-i', input,
      '-vn',
      '-acodec', 'libmp3lame',
      '-ac', '1',       // Mono
      '-b:a', '24k',    // Target Bitrate
      '-ar', '22050',
      '-minrate', '24k', // Força o mínimo (Impede VBR)
      '-maxrate', '24k', // Força o máximo (Impede picos de tamanho)
      '-bufsize', '48k', // Buffer pequeno para manter controle estrito
      output
    ];

    const stats = fs.statSync(output);
    const sizeInMB = stats.size / (1024 * 1024);
    console.log(`TAMANHO DO ARQUIVO GERADO: ${sizeInMB.toFixed(2)} MB`);

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
  const executionId = randomUUID();
  const inputPath = path.join(tempDir, `input_${executionId}.mp4`);
  const outputPath = path.join(tempDir, `output_${executionId}.mp4`);
  const finalFileName = `cuts/${jobId}_${Date.now()}_${executionId.slice(0, 5)}.mp4`;

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