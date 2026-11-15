# Word timings and a transcript check for each narration segment, with OpenAI Whisper running locally.
# Writes film/tts/words.json: {segment: {"words": [{"w", "start", "end"}], "heard": transcript}}.
# Usage: film/.venv/Scripts/python film/captions.py [model]   (default small.en)
import json, pathlib, sys
import whisper

root = pathlib.Path(__file__).parent
cfg = json.loads((root / 'narration.json').read_text(encoding='utf-8'))
model = whisper.load_model(sys.argv[1] if len(sys.argv) > 1 else 'small.en')
out = {}
for seg in cfg['segments']:
    r = model.transcribe(str(root / 'tts' / f"{seg['id']}.wav"), language='en', word_timestamps=True, fp16=False, temperature=0)
    words = [{'w': w['word'].strip(), 'start': round(w['start'], 3), 'end': round(w['end'], 3)} for s in r['segments'] for w in s['words']]
    out[seg['id']] = {'words': words, 'heard': r['text'].strip()}
    print(seg['id'], '|', r['text'].strip())
(root / 'tts' / 'words.json').write_text(json.dumps(out, indent=1), encoding='utf-8')
