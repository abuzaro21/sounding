// Builds film/out/sounding-film.mp4 (1920×1080, 30 fps, H.264/AAC, burned-in English captions) and sounding-film.srt
// from the recorded scenes (film/capture), the narration (film/tts) and Whisper's word timings. Usage: node film/assemble.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { timeline, TOTAL } from './timeline.ts';

const CAP = 'film/capture', OUT = 'film/out', TMP = `${OUT}/parts`;
mkdirSync(TMP, { recursive: true });
const ff = (args: string[], cwd?: string) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit', cwd });
const scenes = timeline();
const abs = (p: string) => path.resolve(p).replaceAll('\\', '/');

/** A concat list holding each painted frame for as long as it stayed on screen, cut to the scene's length. */
function frameList(name: string, len: number) {
  const { t0, frames } = JSON.parse(readFileSync(`${CAP}/${name}/frames.json`, 'utf8')) as { t0: number; frames: { f: string; ts: number }[] };
  const end = t0 + len, lines: string[] = [];
  const use = frames.filter((f, i) => f.ts < end && (frames[i + 1]?.ts ?? Infinity) > t0);
  use.forEach((f, i) => {
    const d = Math.min(use[i + 1]?.ts ?? end, end) - Math.max(f.ts, t0);
    if (d > 0) lines.push(`file '${abs(`${CAP}/${name}/${f.f}`)}'`, `duration ${d.toFixed(4)}`);
  });
  lines.push(lines.at(-2)!); // the concat demuxer needs the last file repeated for its duration to count
  const file = `${TMP}/${name}.txt`;
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
const enc = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-r', '30'];

// One continuous recording of the app covers every scene before the evidence card; the two cards are recorded alone.
const at = Object.fromEntries(scenes.map((s) => [s.id, s]));
const parts: string[] = [];
for (const [name, len] of [['app', at.evidence.start], ['evidence', at.evidence.len], ['end', at.end.len]] as const) {
  const out = `${TMP}/${name}.mp4`;
  ff(['-f', 'concat', '-safe', '0', '-i', frameList(name, len), '-vf', 'scale=1920:1080:flags=lanczos:in_range=full:out_range=tv,fps=30,format=yuv420p', '-t', String(len), ...enc, out]);
  parts.push(out);
}
writeFileSync(`${TMP}/parts.txt`, parts.map((p) => `file '${abs(p)}'`).join('\n') + '\n');
ff(['-f', 'concat', '-safe', '0', '-i', `${TMP}/parts.txt`, '-vf', `fade=t=in:st=0:d=0.5,fade=t=out:st=${(TOTAL - 0.7).toFixed(2)}:d=0.7`, '-t', String(TOTAL), ...enc, `${TMP}/video.mp4`]);

// Narration: each segment placed at its scene time, mixed, loudness-normalised for online video.
const segs = scenes.flatMap((s) => s.segs.map((g) => ({ ...g, t: s.start + g.at })));
ff([...segs.flatMap((g) => ['-i', `film/tts/${g.id}.wav`]),
  '-filter_complex', `${segs.map((g, i) => `[${i}:a]aresample=48000,adelay=${Math.round(g.t * 1000)}:all=1[a${i}]`).join(';')};${segs.map((_, i) => `[a${i}]`).join('')}amix=inputs=${segs.length}:normalize=0,apad,atrim=0:${TOTAL},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]`,
  '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', `${TMP}/audio.m4a`]);

// Captions: the script's own words, timed by mapping their letters onto Whisper's word timings.
const words = JSON.parse(readFileSync('film/tts/words.json', 'utf8')) as Record<string, { words: { w: string; start: number; end: number }[] }>;
const text = Object.fromEntries((JSON.parse(readFileSync('film/narration.json', 'utf8')).segments as { id: string; text: string }[]).map((s) => [s.id, s.text]));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
type Cue = { a: number; b: number; t: string };
const cues: Cue[] = [];
for (const g of segs) {
  const heard: number[][] = []; // per heard letter: [start, end]
  for (const w of words[g.id].words) { const n = norm(w.w).length; for (let i = 0; i < n; i++) heard.push([w.start + (w.end - w.start) * i / n, w.start + (w.end - w.start) * (i + 1) / n]); }
  const script = text[g.id].split(/\s+/);
  const total = script.reduce((k, w) => k + norm(w).length, 0);
  let seen = 0;
  const timed = script.map((w) => {
    const n = Math.max(1, norm(w).length), at = (i: number) => heard[Math.min(heard.length - 1, Math.floor(i * heard.length / total))];
    const x = { w, a: g.t + at(seen)[0], b: g.t + at(seen + n - 1)[1] }; seen += norm(w).length; return x;
  });
  let cur: typeof timed = [];
  const flush = () => { if (cur.length) cues.push({ a: cur[0].a, b: cur.at(-1)!.b, t: cur.map((x) => x.w).join(' ') }); cur = []; };
  for (const x of timed) {
    const len = [...cur, x].map((y) => y.w).join(' ').length;
    if (cur.length && len > 46) flush();
    cur.push(x);
    const line = cur.map((y) => y.w).join(' ');
    if (/[.!?]$/.test(x.w) || (/[,:;]$/.test(x.w) && line.length >= 26)) flush();
  }
  flush();
}
for (const c of cues) c.a = Math.max(0, c.a - 0.08); // appear just before the word is spoken
cues.forEach((c, i) => { const next = cues[i + 1]; c.b = Math.max(c.b + 0.25, c.a + 0.9); if (next && c.b > next.a - 0.04) c.b = next.a - 0.04; });
if (cues.some((c, i) => c.b <= c.a || (cues[i + 1] && c.b > cues[i + 1].a))) throw new Error('caption timings overlap');
const ts = (t: number) => { const ms = Math.round(t * 1000), h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
writeFileSync(`${OUT}/sounding-film.srt`, cues.map((c, i) => `${i + 1}\n${ts(c.a)} --> ${ts(c.b)}\n${c.t}\n`).join('\n'));

// Final: captions burned in; the SRT is also published next to the video.
const style = 'FontName=Segoe UI Semibold,FontSize=12,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BackColour=&H99000000,BorderStyle=4,Outline=1.6,Shadow=0,MarginV=16,Alignment=2';
ff(['-i', 'parts/video.mp4', '-i', 'parts/audio.m4a', '-vf', `subtitles=sounding-film.srt:force_style='${style}'`, ...enc, '-c:a', 'copy', '-movflags', '+faststart', '-shortest', 'sounding-film.mp4'], OUT);
console.log(existsSync(`${OUT}/sounding-film.mp4`) ? `wrote ${OUT}/sounding-film.mp4 and ${OUT}/sounding-film.srt (${cues.length} cues)` : 'no output');
