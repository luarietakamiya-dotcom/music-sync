# Music Sync 0.13.0 local SDK distribution

This is a local, MIT-licensed release bundle for integrating the Core that powers
Music Sync Web. It is not an npm registry publication. The Web app remains a static
browser application; SDK installation is only for developers embedding its audio tools.

## Install into another Node/bundler application

Extract this SDK bundle and use actual paths to these four tarballs in one command:

```sh
npm install /path/music-sync-shared-0.13.0.tgz /path/music-sync-dsp-0.13.0.tgz /path/music-sync-audio-analysis-0.13.0.tgz /path/music-sync-core-0.13.0.tgz
```

Supply all four together so transitive @music-sync dependencies resolve locally.
Optionally include music-sync-ui-0.13.0.tgz for the DOM/canvas helper package.
With all tarballs present you can add `--offline --ignore-scripts`. No postinstall,
binary runtime, paid API or server service is needed. Keep generated package-lock
and tarballs accessible to future installs; file dependencies do not magically
become registry packages. Node 22.13+ (24 recommended), ESM/TypeScript supported.

```js
import { analyzeAudio, masterAudio, encodeFloatWav } from '@music-sync/core';
const input = { sampleRate: 48000, channels: [yourFloat32Samples] };
const report = analyzeAudio(input);
const result = masterAudio(input, { targetLufs: -14, ceilingDb: -1 });
if (result.processed) {
  const wav = encodeFloatWav(result.processed.audio);
  // Your host saves wav. Original samples are unchanged.
}
```

For analysis/DSP only, use the corresponding exports instead of masterAudio.
Installed packages include API, measurement, processing/mastering and compatibility
documentation in their docs folder, plus LICENSE and CHANGELOG.

## Use directly in a browser without a bundler

Serve the `browser/` directory over HTTP/HTTPS and open index.html. Do not use
file://. `music-sync-core.js` is a single self-contained ES module with the same
Core exports, bundled from these libraries. main.js demonstrates analysis and
ownership transfer to a module Worker; worker.js demonstrates mastering/export.
You can import that module in your own app or worker without a CDN/import map.
The example uses synthesized audio; file decoding/playback belong to the host.

## Reproduce from source

```sh
npm ci
npm run check
npm run test:package
npx playwright install chromium webkit
npm run test:sdk-browser
```

`npm run check` builds sources. `npm run test:package` packs that build and tests
an independent installation. `npm run release:local` rebuilds and prepares artifacts
under artifacts/v0.7.1. `manifest.json` lists package versions and local provenance;
SHA256SUMS covers package/browser/doc files. These hashes detect changes, not author
identity. No registry signature, hosted CI success or remote release is implied.
No script uploads, publishes, pushes or creates a GitHub release.
