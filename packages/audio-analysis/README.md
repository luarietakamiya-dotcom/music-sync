# @music-sync/audio-analysis

Music Sync 0.13.0 — MIT-licensed local-first audio toolkit for AI musicians and
independent creators. This is an ESM library package used by Music Sync Web.

Install the local release tarballs together to resolve workspace dependencies.
For Core, supply shared, dsp, audio-analysis and core tarballs to one npm install
command. The repository distribution guide has the complete command. No registry
publication or ownership of the npm scope is claimed; private:true intentionally
blocks accidental npm publish while allowing local installation.

Core is the recommended entry point: `import { analyzeAudio } from '@music-sync/core'`.
It accepts planar Float32 PCM and needs no browser audio device or external service.
UI helpers alone require DOM/canvas; UI tokens are available as
`@music-sync/ui/tokens.css`. Use public root exports, never internal source paths.

See [API](docs/api.md), [compatibility](docs/compatibility.md),
[measurement](docs/measurement.md), [DSP](docs/processing.md),
[mastering](docs/mastering.md) and [comparison](docs/comparison.md).
In a source checkout, the same documentation is in the repository docs directory;
pack:local copies it into the installed package. LICENSE and CHANGELOG are included.

Adaptive AUTO / IMPACT / LIVE: see [automatic finishing](docs/auto-finishing.md).
