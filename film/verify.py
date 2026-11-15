# Automated checks of film/out/sounding-film.mp4 and its SRT. Writes film/out/verification.json.
# These are machine checks: no person has watched or listened to the film as part of them.
import json, pathlib, re, subprocess
import numpy as np
import whisper

root = pathlib.Path(__file__).parent
mp4, srt = root / 'out' / 'sounding-film.mp4', root / 'out' / 'sounding-film.srt'
run = lambda *a: subprocess.run(a, capture_output=True, text=True)
probe = json.loads(run('ffprobe', '-v', 'error', '-show_format', '-show_streams', '-count_frames', '-of', 'json', str(mp4)).stdout)
v = next(s for s in probe['streams'] if s['codec_type'] == 'video')
a = next(s for s in probe['streams'] if s['codec_type'] == 'audio')
dur = float(probe['format']['duration'])
decode_errors = run('ffmpeg', '-v', 'error', '-i', str(mp4), '-f', 'null', '-').stderr.strip()
loud = run('ffmpeg', '-hide_banner', '-nostats', '-i', str(mp4), '-af', 'ebur128', '-f', 'null', '-').stderr
lufs = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', loud)[-1])

def rgb(t):
    p = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', str(mp4), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    return np.frombuffer(p, np.uint8).reshape(1080, 1920, 3).astype(int)

end = rgb(dur - 1.2)
# The logo's teal (#6fc3b8) and its light strokes and wordmark (#e7f2f3) on the dark sea gradient.
teal = int(((abs(end[..., 0] - 111) < 30) & (abs(end[..., 1] - 195) < 30) & (abs(end[..., 2] - 184) < 30)).sum())
light = int(((end[..., 0] > 200) & (end[..., 1] > 215) & (end[..., 2] > 215)).sum())
start_black = float(rgb(0.0).mean())

cues = [b for b in srt.read_text(encoding='utf-8').strip().split('\n\n')]
def secs(s): h, m, rest = s.split(':'); x, ms = rest.split(','); return int(h) * 3600 + int(m) * 60 + int(x) + int(ms) / 1000
times = [tuple(secs(x) for x in c.split('\n')[1].split(' --> ')) for c in cues]
srt_ok = all(a0 < b0 for a0, b0 in times) and all(times[i][1] <= times[i + 1][0] for i in range(len(times) - 1)) and times[-1][1] <= dur

script = ' '.join(s['text'] for s in json.loads((root / 'narration.json').read_text(encoding='utf-8'))['segments'])
heard = whisper.load_model('small.en').transcribe(str(mp4), language='en', fp16=False, temperature=0)['text']
# Whisper writes numbers as digits; the script spells them out. Homophones it cannot tell apart are folded together.
ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split()
TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split()
def spell(n):
    n = int(n)
    if n < 20: return ONES[n]
    if n < 100: return TENS[n // 10 - 2] + ('' if n % 10 == 0 else ' ' + ONES[n % 10])
    return ONES[n // 100] + ' hundred' + ('' if n % 100 == 0 else ' and ' + spell(n % 100))
SAME = {'seated': 'seeded', 'cued': 'queued', 'canceled': 'cancelled'}
def words(s):
    s = re.sub(r'\d+', lambda m: spell(m.group()), s.lower().replace('-', ' ').replace("'", ''))
    return [SAME.get(w, w) for w in re.findall(r'[a-z0-9]+', s)]
r, h = words(script), words(heard)
d = np.zeros((len(r) + 1, len(h) + 1), int); d[:, 0] = range(len(r) + 1); d[0, :] = range(len(h) + 1)
for i in range(1, len(r) + 1):
    for j in range(1, len(h) + 1):
        d[i, j] = min(d[i - 1, j] + 1, d[i, j - 1] + 1, d[i - 1, j - 1] + (r[i - 1] != h[j - 1]))
wer = float(d[len(r), len(h)] / len(r))

checks = {
    'duration_89_to_90_s': 89.0 <= dur <= 90.0,
    'resolution_1920x1080': (v['width'], v['height']) == (1920, 1080),
    'fps_30': v['r_frame_rate'] == '30/1',
    'h264_yuv420p': v['codec_name'] == 'h264' and v['pix_fmt'] == 'yuv420p',
    'aac_audio': a['codec_name'] == 'aac',
    'decodes_without_errors': decode_errors == '',
    'srt_well_formed': srt_ok,
    'loudness_near_-16_lufs': abs(lufs + 16) <= 1.5,
    'narration_matches_script_wer_under_10pct': wer < 0.10,
    'logo_visible_on_end_card': teal > 3000 and light > 5000,  # the teal wave stroke alone is about 4 800 px at 1080p
}
report = {
    'file': str(mp4.relative_to(root.parent)).replace('\\', '/'), 'bytes': int(probe['format']['size']), 'duration_s': dur,
    'video': {k: v.get(k) for k in ('codec_name', 'profile', 'width', 'height', 'r_frame_rate', 'pix_fmt', 'nb_read_frames', 'color_range')},
    'audio': {k: a.get(k) for k in ('codec_name', 'sample_rate', 'channels')}, 'integrated_loudness_lufs': lufs,
    'captions': {'cues': len(cues), 'first': times[0], 'last': times[-1]},
    'end_card': {'teal_pixels': teal, 'light_pixels': light}, 'first_frame_mean': round(start_black, 1),
    'whisper_small_en': {'word_error_rate': round(wer, 4), 'heard': heard.strip()},
    'checks': checks, 'all_passed': all(checks.values()),
    'not_checked': 'No person has watched or listened to this file as part of these checks.',
}
(root / 'out' / 'verification.json').write_text(json.dumps(report, indent=1), encoding='utf-8')
print(json.dumps({'checks': checks, 'wer': round(wer, 4), 'lufs': lufs, 'teal': teal, 'light': light}, indent=1))
