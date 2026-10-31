# W1 results, 2026-10-29

9 cold runs per app and mode, median (min–max). Ratio = PandaCode / T3 Code (below 1: PandaCode used less).

## W1: 50,000 B streamed as 2,000 × 25 B deltas over 31.984 s

| Metric | PandaCode | T3 Code | Ratio |
| --- | ---: | ---: | ---: |
| Main-thread task time (ms) | 2947 (2395–3280) | 8332 (8279–9125) | 0.35 |
|   of which script (ms) | 288 (241–337) | 5632 (5571–6127) | 0.05 |
|   of which layout (ms) | 208 (178–241) | 222 (215–234) | 0.94 |
|   of which style recalc (ms) | 283 (228–334) | 403 (389–430) | 0.70 |
|   other: HTML parsing, paint, GC… (ms) | 2172 (1748–2423) | 2111 (2033–2334) | 1.03 |
| Wall time (ms) | 32034 (32021–32037) | 32020 (32011–32026) | 1.00 |
| Last delivery to final paint (ms) | 49 (37–52) | 27 (20–36) | 1.81 |
| Worst delivery lateness (ms) | 2 (2–2) | 7 (5–10) | 0.29 |
| JS heap before, after GC (MB) | 10.6 (10.6–10.8) | 35.4 (35.4–35.4) | 0.30 |
| JS heap after, after GC (MB) | 11.5 (11.5–11.6) | 54.2 (54.1–54.3) | 0.21 |
| DOM mutation records | 7114 (7114–7146) | 3960 (3944–3977) | 1.80 |
| Updates delivered to the UI | 667 (667–667) | 500 (500–500) | 1.33 |

## Idle baseline: same page state, same 31.984 s, nothing delivered

| Metric | PandaCode | T3 Code | Ratio |
| --- | ---: | ---: | ---: |
| Main-thread task time (ms) | 38 (31–47) | 133 (111–180) | 0.29 |
|   of which script (ms) | 4 (3–5) | 16 (12–25) | 0.25 |
| DOM mutation records | 198 (198–198) | 38 (33–39) | 5.21 |

Streaming cost above idle (median W1 task time minus median idle task time): PandaCode 2909 ms, T3 Code 8199 ms (ratio 0.35).

Spread of W1 task time, (max − min) / median: PandaCode 30%, T3 Code 10%.

Machine: Mac16,5, Apple M4 Max, 48 GB, macOS 27.0.1. Chrome 155.0.8059.85 (headless), 1440×940 at 2x. PandaCode 040eb62, T3 Code fe219c4. Raw numbers: 2026-10-29.json. Method: ../README.md.
