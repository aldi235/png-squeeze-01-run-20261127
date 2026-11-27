# PNG Squeeze — Smallest PNG, 27 November 2026

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/aldi235/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/aldi235/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A make.fun bounty entry: squeeze screenshots into the smallest PNG.

`main.ts` (Node stdlib only) reads screenshots from `/input` and writes
the squeezed PNGs to `/output`, deterministic and byte-identical across runs.
On the practice set it beats the fixed-paeth baseline on all 8 instances.

## Run it

```sh
node main.ts
```

No build step, no network requests, no libraries.
