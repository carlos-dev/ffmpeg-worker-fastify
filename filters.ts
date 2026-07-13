// filters.ts
// Monta o filtro de vídeo do FFmpeg. Função pura: sem fs, sem logger —
// o chamador (index.ts) resolve caminhos e decide se a watermark existe.

export interface FilterGraphOptions {
  /** Cadeia do estilo de render (blur/crop/face-track), no formato aceito por -vf */
  styleFilter: string;
  /** Termos aplicados após o estilo, na ordem: subtitles=..., drawtext=... (já escapados) */
  textFilters?: string[];
  /** Presente = aplica marca d'água (o PNG entra como segundo input do FFmpeg) */
  watermark?: {
    opacity: number; // 0..1
    yOffset: number; // px abaixo do centro vertical
  };
}

export interface FilterGraphResult {
  kind: '-vf' | '-filter_complex';
  filter: string;
  /** Valor para -map do vídeo: '0:v:0' (sem watermark) ou '[outv]' */
  videoMap: string;
}

export function buildFilterGraph(opts: FilterGraphOptions): FilterGraphResult {
  const text = (opts.textFilters ?? []).filter(Boolean);

  if (!opts.watermark) {
    // Caminho atual (-vf) intacto: zero regressão para renders sem marca
    return {
      kind: '-vf',
      filter: [opts.styleFilter, ...text].join(','),
      videoMap: '0:v:0',
    };
  }

  const { opacity, yOffset } = opts.watermark;
  const finalStage = text.length > 0 ? text.join(',') : 'null';
  const filter =
    `[0:v]${opts.styleFilter}[base];` +
    `[1:v]format=rgba,colorchannelmixer=aa=${opacity}[wm];` +
    `[base][wm]overlay=(W-w)/2:(H-h)/2+${yOffset}[marked];` +
    `[marked]${finalStage}[outv]`;

  return { kind: '-filter_complex', filter, videoMap: '[outv]' };
}
