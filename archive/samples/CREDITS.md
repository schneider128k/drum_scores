# Drum sample credits

These nine MP3 files are derived from **Virtuosity Drums**, the KVR
Developer Challenge 2021 entry by **Versilian Studios** and **Karoryfer
Samples**.

- Source repository: <https://github.com/sfzinstruments/virtuosity_drums>
- License: **CC0 1.0 Universal** (public domain dedication)
  — see <https://creativecommons.org/publicdomain/zero/1.0/>
- Original samples are 24-bit FLAC at multiple velocity layers and
  microphone positions. The files here are single-velocity MP3s at
  128 kbps, extracted from the `mid` microphone position.

The exact source files (under `Samples/mid/<voice>/`) and our
filename mapping are encoded in `scripts/fetch_samples.py`. Re-running
that script regenerates this directory from the upstream repo.

## Sample → MIDI mapping (set in `player.js`)

| File           | GM MIDI numbers          |
|----------------|--------------------------|
| `kick.mp3`     | 35, 36                   |
| `snare.mp3`    | 38, 39, 40               |
| `sidestick.mp3`| 37                       |
| `tom_low.mp3`  | 41, 43, 45, 47           |
| `tom_high.mp3` | 48, 50                   |
| `hat_closed.mp3`| 42, 44                  |
| `hat_open.mp3` | 46, 92                   |
| `crash.mp3`    | 49, 52, 55, 57, 59       |
| `ride.mp3`     | 51, 53                   |

MIDI numbers 45 and 47 (low / low-mid tom) map to `tom_low` because the
upstream kit doesn't provide a separate "mid" tom — only high and low.
