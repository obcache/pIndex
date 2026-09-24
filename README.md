# pIndex

pIndex is an Electron + React + Vite + TypeScript desktop app for analyzing batches of audio files and creating momentum-based segment index files for adaptive game soundtracks.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Current index format

The app exports `.pindex.json` files containing source metadata, summary energy/momentum values, and segments with `in`, `out`, `duration`, `energy`, `momentum`, `band`, and `confidence` fields.
Loop 3
Loop 3
