"""Regenerate the bundled synthetic call on macOS. No network calls or microphone input."""
import json
from pathlib import Path
import subprocess
import tempfile
import wave

ASSETS = Path(__file__).resolve().parent
TURN = [
    ('opening', 'Intake agent', 'Samantha', 'This is the claims intake desk. Please give your name and tell me which incident you are calling about.'),
    ('worksite', 'Caller', 'Daniel', 'I work at Willow Harbor Supply. My incident was at Cedar Dock, loading bay three. The report number ends in 42.'),
    ('name', 'Intake agent', 'Samantha', 'Thank you. Could you give me the name on the report and the date, if you remember it?'),
    ('date', 'Caller', 'Daniel', 'My name is River Ellis. I think it was Monday, but it might have been Tuesday. I would need to check my shift record.'),
    ('callback', 'Caller', 'Daniel', 'I can take a call after my shift to confirm the date. Please attach my message to the Cedar Dock report.'),
    ('close', 'Intake agent', 'Samantha', 'I have taken your message. An examiner will check the report details and follow up.'),
]


def main():
    rate = 16000
    anchors = []
    with tempfile.TemporaryDirectory() as tmp, wave.open(str(ASSETS / 'IN-201-call.wav'), 'wb') as audio:
        audio.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        for key, speaker, voice, text in TURN:
            aiff = str(Path(tmp) / 'turn.aiff')
            wav = str(Path(tmp) / 'turn.wav')
            subprocess.run(['say', '-v', voice, '-r', '158', '-o', aiff, text], check=True)
            subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', aiff, wav], check=True)
            with wave.open(wav, 'rb') as turn:
                assert (turn.getframerate(), turn.getnchannels(), turn.getsampwidth()) == (rate, 1, 2)
                start = audio.getnframes() / rate
                audio.writeframes(turn.readframes(turn.getnframes()))
                end = audio.getnframes() / rate
                anchors.append({'id': key, 'label': speaker, 'text': text, 'startSeconds': round(start, 3), 'endSeconds': round(end, 3)})
                audio.writeframes(b'\x00\x00' * (rate // 3))
    (ASSETS / 'IN-201-transcript.json').write_text(json.dumps(anchors, indent=2) + '\n')


if __name__ == '__main__':
    main()
