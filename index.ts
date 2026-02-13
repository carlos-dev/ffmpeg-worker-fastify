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

// --- SETUP INICIAL ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastify = Fastify({
  logger: true,
  connectionTimeout: 600000, // 10 minutos
  keepAliveTimeout: 600000,
  bodyLimit: 1048576 * 10 // 10MB para JSON payload
});

await fastify.register(cors, { origin: true });

// --- CONFIGURAÇÃO S3/R2 ---
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

// --- NOTIFICAÇÃO AO BACKEND ---
async function notifyBackend(jobId: string, payload: object) {
  try {
    // Tenta avisar o backend, mas não trava se falhar
    const url = `${BACKEND_URL}/jobs/${jobId}/progress`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => console.error(`[Webhook Warn] Falha ao notificar backend: ${err.message}`));
  } catch (err) {
    console.error(`[Webhook Error] ${err}`);
  }
}

// --- UTILS ---
function timeToSeconds(timeString: string): number {
  if (!timeString) return 0;
  const parts = timeString.split(':');
  try {
    const h = parseFloat(parts[0]);
    const m = parseFloat(parts[1]);
    const s = parseFloat(parts[2]);
    return (h * 3600) + (m * 60) + s;
  } catch (e) {
    return 0;
  }
}

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
  renderStyle?: 'blur' | 'crop';
  hasViralTitle?: boolean;
  viralHeadline?: string;
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
      renderStyle: { type: 'string', enum: ['blur', 'crop'], default: 'blur' },
      hasViralTitle: { type: 'boolean', default: false },
      viralHeadline: { type: 'string' }
    }
  }
};

// --- HELPERS PARA TÍTULO VIRAL ---

/**
 * Quebra o texto em múltiplas linhas inserindo \n a cada ~maxChars caracteres,
 * respeitando limites de palavra (não corta no meio).
 */
function wrapText(text: string, maxChars: number = 20): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word;
    } else if ((currentLine + ' ' + word).length <= maxChars) {
      currentLine += ' ' + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines.join('\n');
}

/**
 * Escapa caracteres especiais para o filtro drawtext do FFmpeg.
 * Como passamos via -vf (não via textfile), precisamos tratar os chars
 * que o FFmpeg usa como delimitadores no filtergraph e no drawtext.
 *
 * Nível 1: FFmpeg filtergraph escapes  -> ; , [ ] '
 * Nível 2: drawtext key=value escapes  -> : \
 * 
 * A abordagem mais segura: usar a opção text= com aspas simples
 * e escapar somente o mínimo necessário.
 */
function escapeDrawtext(text: string): string {
  // 1. Escapa barras invertidas primeiro (antes de qualquer outro replace)
  let escaped = text.replace(/\\/g, '\\\\');
  // 2. Escapa aspas simples para drawtext: ' -> '\''
  //    (fecha aspas, insere aspas escapada, reabre aspas)
  escaped = escaped.replace(/'/g, "'\\''");
  // 3. Escapa dois-pontos (delimitador key=value do drawtext)
  escaped = escaped.replace(/:/g, '\\:');
  // 4. Escapa percentuais (FFmpeg usa % para expressões)
  escaped = escaped.replace(/%/g, '%%');
  // 5. Escapa ponto-e-vírgula (delimitador de filtros no filtergraph)
  escaped = escaped.replace(/;/g, '\\;');
  return escaped;
}

// --- DOWNLOADER ---
async function downloadFile(
  url: string,
  outputPath: string,
  onProgress: (pct: number) => void
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao baixar vídeo: ${response.statusText}`);

  const totalLength = Number(response.headers.get('content-length'));
  let downloaded = 0;
  let lastReport = 0;

  const fileStream = fs.createWriteStream(outputPath);
  
  if (!response.body) throw new Error('Corpo da resposta vazio');
  const reader = response.body.getReader();

  while(true) {
    const { done, value } = await reader.read();
    if (done) break;

    downloaded += value.length;
    fileStream.write(value);

    if (totalLength) {
      const percent = (downloaded / totalLength) * 100;
      if (percent - lastReport > 10) { // Notifica a cada 10%
        onProgress(percent);
        lastReport = percent;
      }
    }
  }

  return new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
    fileStream.end();
  });
}

// --- GERADOR DE LEGENDAS (.ASS) ---
function generateSubtitleFile(words: Word[], cutStartTime: number, outputPath: string): void {
  // Configuração visual da legenda (Amarelo com borda preta, fonte Arial Black)
  const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,80,&H0000FFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,0,2,10,10,280,1
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

    // Efeito Karaoke simples (highlight palavra por palavra)
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
    if (w.end < cutStartTime) continue; // Pula palavras antes do corte

    const prevWord = words[i-1];
    // Quebra se houver silêncio grande ou muitas letras
    const isBigGap = prevWord && (w.start - prevWord.end > 0.5);
    
    // Ajuste aqui: max 25 caracteres por linha para caber no celular vertical
    if ((currentCharCount + w.word.length > 20) || isBigGap) flushGroup();

    currentGroup.push(w);
    currentCharCount += w.word.length + 1;
  }
  flushGroup();
  fs.writeFileSync(outputPath, assContent);
}

// --- ENGINE FFMPEG (O Coração) ---
function runFFmpeg(
  inputPath: string,
  outputPath: string,
  startTime: number,
  endTime: number,
  subtitlePath: string | undefined,
  onProgress: (pct: number) => void,
  logger: any,
  renderStyle: 'blur' | 'crop' = 'blur',
  viralHeadline?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const duration = endTime - startTime;
    // Fade in/out no áudio para não estourar os ouvidos
    const fadeOutStart = Math.max(0, duration - 0.5);
    const audioFilter = `afade=t=in:st=0:d=0.1,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.5`;

    let videoFilter: string;

    if (renderStyle === 'crop') {
      // --- MODO CROP: "Zoom" centralizado ---
      videoFilter = `scale=-1:1920:flags=lanczos,crop=1080:1920:(iw-1080)/2:0,setsar=1`;
    } else {
      // --- MODO BLUR (Padrão): "Blurred Background" ---
      videoFilter = `split[bg][fg]; [bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:10,eq=brightness=-0.1[bg_blurred]; [fg]scale=1080:-1:flags=lanczos[fg_sharp]; [bg_blurred][fg_sharp]overlay=(W-w)/2:(H-h)/2,setsar=1`;
    }

    // Remove quebras de linha da string de filtro (segurança)
    videoFilter = videoFilter.replace(/\n/g, '');

    // Adiciona legendas se existirem
    if (subtitlePath && fs.existsSync(subtitlePath)) {
      const escapedPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      videoFilter += `,subtitles='${escapedPath}'`;
    }

    // --- TÍTULO VIRAL (drawtext) ---
    // Aplicado APÓS scale/crop para ficar na resolução correta (1080x1920)
    if (viralHeadline && viralHeadline.trim().length > 0) {
      const wrappedText = wrapText(viralHeadline.trim(), 20);
      const escapedText = escapeDrawtext(wrappedText);
      const fontPath = path.join(__dirname, 'assets', 'fonts', 'Montserrat-ExtraBold.ttf')
        .replace(/\\/g, '/')
        .replace(/:/g, '\\:');

      logger.info(`Adicionando título viral: "${viralHeadline}" (escaped: "${escapedText}")`);

      videoFilter += `,drawtext=fontfile='${fontPath}':text='${escapedText}':fontcolor=white:fontsize=52:borderw=2:bordercolor=black:box=1:boxcolor=red@1.0:boxborderw=15:x=(w-text_w)/2:y=280`;
    }

    const args = [
      '-y',
      '-ss', startTime.toFixed(3),
      '-i', inputPath,
      '-t', duration.toFixed(3),
      
      // Usa threads baseadas no plano Pro (ajuda na velocidade)
      '-threads', '4',

      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', videoFilter,
      '-af', audioFilter,
      
      // --- QUALIDADE DE VÍDEO (Ajustado para Pro Plan) ---
      '-c:v', 'libx264',
      '-preset', 'fast',  // 'fast' é o equilíbrio perfeito. 'veryslow' é desnecessário.
      '-crf', '23',       // 23 = Alta qualidade visual, arquivo tamanho médio.
      
      // Limites de Bitrate (Segurança para Mobile)
      '-maxrate', '6000k',
      '-bufsize', '12000k',
      
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      
      // Áudio
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      
      '-movflags', '+faststart',
      
      outputPath
    ];

    logger.info(`Iniciando FFmpeg...`);
    
    const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args, { 
      timeout: 600000 // 10 minutos max de render
    });
    
    let stderrData = '';
    let lastReport = 0;

    ffmpeg.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrData += chunk;

      // Extrai tempo atual para calcular %
      const timeMatch = chunk.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (timeMatch) {
        const currentTime = timeToSeconds(timeMatch[1]);
        const percent = Math.min(100, (currentTime / duration) * 100);

        if (percent - lastReport > 5) {
          onProgress(percent);
          lastReport = percent;
        }
      }
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        logger.error(`FFmpeg falhou. Logs finais: ${stderrData.slice(-1000)}`);
        reject(new Error(`FFmpeg error code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => reject(new Error(`FFmpeg falhou ao iniciar: ${err.message}`)));
  });
}

// --- ROTA DA API ---
fastify.post<{ Body: ProcessVideoBody }>('/process-video', {
  schema: processSchema
}, async (request, reply) => {
  const { videoUrl, startTime, endTime, jobId, words, renderStyle, hasViralTitle, viralHeadline } = request.body;
  const style = renderStyle || 'blur';
  const headline = (hasViralTitle && viralHeadline) ? viralHeadline : undefined;
  const log = request.log;

  const tempDir = os.tmpdir();
  const executionId = randomUUID();
  const inputPath = path.join(tempDir, `in_${executionId}.mp4`);
  const outputPath = path.join(tempDir, `out_${executionId}.mp4`);
  const subtitlePath = path.join(tempDir, `sub_${executionId}.ass`);
  const finalFileName = `cuts/${jobId}_${Date.now()}.mp4`;

  try {
    // 1. Download (50% -> 60%)
    notifyBackend(jobId, { status: 'rendering', progress: 50, message: 'Baixando vídeo...' });
    await downloadFile(videoUrl, inputPath, (pct) => {
      const globalPct = 50 + (pct / 100) * 10;
      notifyBackend(jobId, { status: 'downloading', progress: Math.floor(globalPct) });
    });

    // 2. Legendas
    let subPathArg: string | undefined;
    if (words && words.length > 0) {
      log.info('Gerando arquivo de legendas...');
      generateSubtitleFile(words, startTime, subtitlePath);
      subPathArg = subtitlePath;
    }

    // 3. Renderização (60% -> 90%)
    log.info(`Iniciando renderização FFmpeg [${style}]${headline ? ' + Título Viral' : ''} High Quality...`);
    await runFFmpeg(inputPath, outputPath, startTime, endTime, subPathArg, (pct) => {
      const globalPct = 60 + (pct / 100) * 30;
      notifyBackend(jobId, { status: 'rendering', progress: Math.floor(globalPct) });
    }, log, style, headline);

    // 4. Upload (90% -> 100%)
    notifyBackend(jobId, { status: 'uploading', progress: 95, message: 'Enviando para nuvem...' });
    
    const fileBuffer = fs.readFileSync(outputPath);
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: finalFileName,
      Body: fileBuffer,
      ContentType: 'video/mp4'
    }));

    const publicUrl = getPublicUrl(finalFileName);

    log.info(`Job ${jobId} concluído com sucesso!`);

    const result = { status: 'completed', progress: 100, url: publicUrl, success: true };
    notifyBackend(jobId, result);
    return result;

  } catch (err) {
    const error = err as Error;
    log.error(`Erro fatal no Job ${jobId}: ${error.message}`);
    notifyBackend(jobId, { status: 'error', progress: 0, error: error.message });
    reply.code(500).send({ success: false, error: error.message });

  } finally {
    // Limpeza (sempre limpe o tmp!)
    [inputPath, outputPath, subtitlePath].forEach(p => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    });
  }
});

fastify.get('/health', async () => ({ status: 'ok' }));

const start = async () => {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`Worker rodando na porta ${port}`);
};

start();