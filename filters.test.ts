// filters.test.ts
import { describe, it, expect } from 'vitest';
import { buildFilterGraph } from './filters.js';

const BLUR = 'split[bg][fg]; [bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:10,eq=brightness=-0.1[bg_blurred]; [fg]scale=1080:-1:flags=lanczos[fg_sharp]; [bg_blurred][fg_sharp]overlay=(W-w)/2:(H-h)/2,setsar=1';
const CROP = 'scale=-1:1920:flags=lanczos,crop=1080:1920:(iw-1080)/2:0,setsar=1';

describe('buildFilterGraph sem watermark (comportamento atual preservado)', () => {
  it('usa -vf com a cadeia intacta e map 0:v:0', () => {
    const r = buildFilterGraph({ styleFilter: CROP });
    expect(r.kind).toBe('-vf');
    expect(r.filter).toBe(CROP);
    expect(r.videoMap).toBe('0:v:0');
  });

  it('anexa legendas e drawtext com vírgula, na ordem recebida', () => {
    const r = buildFilterGraph({
      styleFilter: CROP,
      textFilters: ["subtitles='/tmp/s.ass'", "drawtext=text='T1'"],
    });
    expect(r.filter).toBe(`${CROP},subtitles='/tmp/s.ass',drawtext=text='T1'`);
    expect(r.kind).toBe('-vf');
  });
});

describe('buildFilterGraph com watermark', () => {
  const wm = { opacity: 0.4, yOffset: 200 };

  it('usa -filter_complex, rotula a entrada [0:v] e mapeia [outv]', () => {
    const r = buildFilterGraph({ styleFilter: CROP, watermark: wm });
    expect(r.kind).toBe('-filter_complex');
    expect(r.filter.startsWith(`[0:v]${CROP}[base];`)).toBe(true);
    expect(r.filter).toContain('[1:v]format=rgba,colorchannelmixer=aa=0.4[wm]');
    expect(r.filter).toContain('[base][wm]overlay=(W-w)/2:(H-h)/2+200[marked]');
    expect(r.videoMap).toBe('[outv]');
  });

  it('legendas entram DEPOIS do overlay da marca (texto sempre por cima)', () => {
    const r = buildFilterGraph({
      styleFilter: CROP,
      textFilters: ["subtitles='/tmp/s.ass'"],
      watermark: wm,
    });
    expect(r.filter.indexOf('overlay=(W-w)/2:(H-h)/2+200'))
      .toBeLessThan(r.filter.indexOf('subtitles='));
    expect(r.filter).toContain("[marked]subtitles='/tmp/s.ass'[outv]");
  });

  it('sem filtros de texto usa null como estágio final', () => {
    const r = buildFilterGraph({ styleFilter: CROP, watermark: wm });
    expect(r.filter).toContain('[marked]null[outv]');
  });

  it('funciona com o grafo multi-chain do estilo blur', () => {
    const r = buildFilterGraph({ styleFilter: BLUR, watermark: wm });
    expect(r.filter.startsWith('[0:v]split[bg][fg];')).toBe(true);
    expect(r.filter).toContain('setsar=1[base];');
  });
});
