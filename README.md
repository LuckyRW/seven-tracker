# 7K tracker

oss!idle add-on for 7K, which has no sim. It records every 7K play as it finishes, fails included (the game keeps no failed play), with your levels before it and how tired and warm you started it. Press **Ctrl+Shift+J** for the panel.

- **Base XP/s** per map and rate: mindblock, fatigue, medals, genetics, mods and your skill multipliers taken out, so prestiging never skews it.
- **Rule-outs**: a rate that gave 0 XP rules out the map's slower rates; a fail rules out its faster rates until a skill levels up.
- **Playlists** that test what is left: every map untested at x1, the screening grid, then refining the best maps between their screened rates.
- **Drift per play**: the warm-up bar change from one play's start to the next.
- **Song select box** (7K only): the selected difficulty's last play at the picked rate and mods, and whether the rate is still worth testing.

Plays are read off the game's socket and kept in localStorage. See `docs/7k-play-tracker.md` for the design.

```
npm ci
npm run verify   # typecheck, tests, build -> dist/seven-tracker.js
```
