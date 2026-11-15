# Synthetic narration with Kokoro-82M (local, Apache-2.0). Writes film/tts/<id>.wav (24 kHz mono) and film/tts/durations.json.
import json, pathlib, sys
import numpy as np
import soundfile as sf
from kokoro import KPipeline

root = pathlib.Path(__file__).parent
cfg = json.loads((root / 'narration.json').read_text(encoding='utf-8'))
out = root / 'tts'; out.mkdir(exist_ok=True)
pipe = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M')
dur = {}
only = set(sys.argv[1:])
for seg in cfg['segments']:
    if only and seg['id'] not in only:
        continue
    parts = [a for _, _, a in pipe(seg['text'], voice=cfg['voice'], speed=cfg['speed'])]
    audio = np.concatenate([np.asarray(p) for p in parts])
    sf.write(out / f"{seg['id']}.wav", audio, 24000)
    dur[seg['id']] = round(len(audio) / 24000, 3)
    print(seg['id'], dur[seg['id']])
prev = json.loads((out / 'durations.json').read_text()) if (out / 'durations.json').exists() else {}
prev.update(dur)
(out / 'durations.json').write_text(json.dumps(prev, indent=1))
print('total', round(sum(prev.values()), 2))
