import json
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


SITE_ROOT = Path(__file__).resolve().parents[1]
FFMPEG = Path(r"C:\Program Files (x86)\Labcenter Electronics\Proteus 8 Professional\BIN\ffmpeg.exe")
OUTPUT = SITE_ROOT / "JS" / "audio-durations.js"


def read_duration(audio_path: Path):
    result = subprocess.run(
        [str(FFMPEG), "-hide_banner", "-i", str(audio_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not match:
        raise RuntimeError(f"Cannot read duration: {audio_path}")
    hours, minutes, seconds = match.groups()
    duration = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    folder = audio_path.parent
    html_files = sorted(folder.glob("*.html"))
    if len(html_files) != 1:
        raise RuntimeError(f"Expected one question HTML in: {folder}")
    key = html_files[0].relative_to(SITE_ROOT).as_posix()
    return key, round(duration, 2)


def main():
    audio_files = sorted((SITE_ROOT / "普通").rglob("audio.mp3"))
    if not audio_files:
        raise RuntimeError("No audio files found")
    with ThreadPoolExecutor(max_workers=16) as executor:
        entries = dict(executor.map(read_duration, audio_files))
    payload = json.dumps(entries, ensure_ascii=False, separators=(",", ":"))
    OUTPUT.write_text(f"window.XIAHUA_AUDIO_DURATIONS={payload};\n", encoding="utf-8")
    print(f"Wrote {len(entries)} durations to {OUTPUT}")


if __name__ == "__main__":
    main()
