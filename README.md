# Music Sync Web

**An open-source audio analysis and mastering toolkit for AI musicians / independent creators.**

音を知り、音づくりをもっと自由に。Music Sync Web is the browser workspace for
Music Sync Core: reusable audio tools that run on your own device, without an
account, upload, paid API, or cloud processing service.

**Use Music Sync Web:** [Open the browser app](https://luarietakamiya-dotcom.github.io/music-sync/).

**Source:** [luarietakamiya-dotcom/music-sync on GitHub](https://github.com/luarietakamiya-dotcom/music-sync).
Audio analysis, processing and export run in your browser; audio files are not
uploaded to GitHub Pages. Local development remains available through the
[setup below](#quick-start). The **Publish Web App** workflow builds and checks
the app on main, then deploys only `apps/web/dist` to GitHub Pages.

**Status: v0.16.0 — Local AI STEM and drum-part separation (PC).** Local analysis, A/B comparison, loudness matching,
manual DSP, experimental adaptive finishing, portable projects and WAV/MP3 export
are implemented. The existing impact.67 desktop application is preserved outside this
new workspace; it is not rewritten, replaced or redistributed here.

**Development checkout:** Single WAV files up to 20 minutes / 512 MiB can now be
finished locally in chunks using AUTO, IMPACT or LIVE. Choose an output target,
compare the measured candidate with Original and export WAV or MP3. [Long-audio migration and next steps](docs/long-audio.md).

## Separate a song into STEMs (PC only)

Open **STEM分離 / PC** to choose four music STEMs, vocals plus accompaniment,
all music with detailed drums (nine materials), or an existing drum recording
into six parts. The learned drum targets are kick, snare, hi-hat, toms and
percussion; the sixth is unassigned remaining drums. Ride and crash are not
individually identified. Listen to each result, save its Float32 WAV, or explicitly
stage it in the existing STEM workspace and build a mix for mastering.

All inference runs locally in a dedicated Worker. Self-hosted models are downloaded
only after you start: about 13 MB for SCNet and another 92 MB for drum separation,
plus the ONNX runtime. A supported hardware GPU is selected automatically, with a
CPU fallback; CPU drum separation can take much longer. Phones and tablets do not
start inference or download these assets. Other mobile workflows remain available.
Original files and the current A/B pair are retained. Cancellation or failed
separation cannot adopt partial outputs. This is experimental estimation, with
possible bleed and no promise of professional quality. See [architecture, model
licenses, limits, quality boundaries and the reusable Core API](docs/stem-separation.md).

## Beginner finish and save

Load a song (or an aligned STEM group), choose an optional destination and press
**おまかせで仕上げて保存**. Music Sync resets creative/extra finishing adjustments
to its visible AUTO defaults, measures the candidate and starts an audio download
in the selected export format only after that new result is accepted. The original and the new B
remain available for matched listening. This is a measured automatic candidate,
not a guarantee of musical preference or professional quality.

If material role/gain/include/repair selections are still staged, the same button
first rebuilds that group. A failed/cancelled rebuild, rejected candidate, Worker
error or a changed generation never downloads the previous B. Browser download
settings may require a retry using the processed-B save button; the app reports download
initiation rather than claiming a completed disk save.

## Keep your work and export

Use **素材込みでプロジェクトを保存** to download a `.musicsync.zip` with original
materials, current A/B, committed and pending STEM selections, finishing/export
settings, metadata and jacket. **プロジェクトを開く** validates the project and
re-measures its included audio before restoring the session, without automatically
mastering it again. Failed/cancelled opening preserves the current session.
In-progress jobs and a complete Undo history are not saved. Project archives
contain private music and filenames; review their contents before sharing.

Export the accepted B as **WAV Float32 / PCM24 / PCM16** or **MP3**. MP3 offers
128–320 kbps, title/artist/album and other ID3v2.3 tags, plus a JPEG/PNG jacket
(2 MiB maximum, 8,192 pixels per side). WAV retains source rate; a CD loudness
guide alone does not resample audio or create a CD master. Monitoring loudness
match and notification SE never enter exported audio.

The SE panel provides the desktop processing loop, completion and error sounds,
with independent enable/volume settings and trial playback. Preferences stay in
this browser. See [projects, export and SE](docs/project-and-export.md) for bounds,
format differences and privacy, and [third-party notices](THIRD_PARTY_NOTICES.md)
for the optional local MP3 encoder and supplied sound-set provenance.

## Reference-guided and album finishing

These optional workspaces start collapsed. Select their headings or the workspace links to open them.
Notification sound volume is always visible near the top, above audio import; header/sidebar SE links jump there.


Choose a favourite WAV/FLAC in **好きな曲の方向に仕上げる** to guide tone, low end and density.
Music Sync compares gain-normalized measurements and applies only bounded corrections that pass
post-analysis. The reference's loudness is not copied. Failed or unnecessary reference changes
keep the safe base candidate.

Use **複数曲をまとめて仕上げる** for up to 20 completed songs. Songs are finished sequentially,
then aligned to a common, peak-safe loudness with gain alone. A failed song does not stop the others.
Audition each result against its original and save individual files or an ordered WAV/MP3 ZIP.
Batch export uses the existing metadata and cover settings.

Reference source files and settings are included in project saves and analyzed again on reopen.
The batch queue and its temporary results are not project snapshots; download the results before
closing the page. See [the workflow, limits and Core example](docs/reference-and-batch.md).

## Quick start

After creating B, use **原音と仕上がりを伏せて聴く** in A/B listening to compare two hidden labels from the current position. Monitoring is loudness matched during the trial. Choose a preference and reveal the labels. A studio or adaptive stem mix with a measurable change also offers **調整前後を伏せて聴く** for an excerpt before mastering. Both trials leave the exported audio unchanged.

**STEM / ボーカル＋伴奏** accepts several WAV/FLAC files by drag/drop or file
selection. Drop together or add one at a time, check editable roles/gain/include,
and use the synchronized mix as A for existing automatic finishing. In
**ボーカル＋伴奏** mode, a default-on option measures both materials and
adjusts vocal level when the measured balance is clearly uneven and may lightly
reduce overlapping accompaniment frequencies when the vocal remains masked. Each
frequency adjustment is measured and discarded if it fails the safety gate; switch
the option off for manual summing. This is a bounded decision based on the roles
you assigned, not automatic vocal detection or full multitrack mixing. Same-rate
source files begin at zero; shorter tails are padded. Worker import uses bounded
WAV chunks (native FLAC stays within its source-PCM budget), protects the summed
peak and preserves A/B on failure or cancellation. Source separation, comprehensive masking correction and track-specific dynamics remain
future work. With 3+ STEMs, the new automatic mix option distinguishes editable
lead/backing roles and reduces competing bands only during masked singing, with
limited kick/bass overlap control. Short weak vocal phrases may also receive
bounded lead-only support, with a separate on/off control under automatic mix
details. A measured quality gate retries once at half
strength before rejecting unsafe changes. Keep the sources and disable/rebuild
for the dry mix. [Bounds and Core usage](docs/stem-input.md).

Each committed STEM offers **この素材を聴く** to identify its actual sound from the
original material, with a timeline and an aligned switch to the whole mix A.
Committed STUDIO_RESTORE sessions also offer matched before/after material repair
and per-material repair OFF with a transactional mix rebuild.
Filename/role guesses do not guarantee the contents of AI-generated STEMs.

Failed additions remain editable; rapid STEM drops queue all accepted files.
Single-file replacements also retain the previous A/B until success. Paired input
has separate vocal/instrumental targets when filenames are ambiguous. A named vocal/instrumental pair selects this mode automatically. Aligned WAV-only projects can use file-backed mixing up to 20 minutes and a 512 MiB stereo mix. Projects containing FLAC keep the in-memory budget (about 4 min 22 sec at 48 kHz).
Finishing reports default to anonymous sharing; uncheck the anonymous option only
when you want filenames and full explanations in the downloaded detailed report.

Choose **仕上がりを自分好みに** to combine vocal presence, bass, clarity,
warmth, punch, width and density without setting DSP numbers. Select Auto,
YouTube guide, streaming, CD loudness guide or retained dynamics as the output,
then press AUTO / IMPACT / LIVE (or **この調整で仕上げる**). The destination
goal is measured after colour and LIVE. The app shows requested and actual LUFS
when safety limits prevent reaching the goal. CD selection adjusts loudness only;
WAV export retains source rate with the selected Float32/PCM24/PCM16 format.
[Design and Core usage](docs/finishing-preferences.md).

Use **Node.js 24 LTS** and npm (minimum Node 22.13). From this repository root:

```sh
npm ci
npm run dev
```

Open http://localhost:5173. Drop a WAV / FLAC, choose a file, or select
**デモ音源を解析** to try a generated stereo example. Use the play button to listen
to the original. Start at a comfortable playback volume.

```sh
npm run check        # lint, types, unit tests, libraries + Web build, consumer example
npx playwright install chromium
npm run test:e2e     # real Chromium: file input, drag/drop, FLAC, playback, export, cancellation
npm run preview     # serve built app at http://localhost:4173
```

The first dependency/browser install needs internet access. After installation,
the basic app requires no external service. Audio is processed locally using
bounded memory and, where needed, temporary origin-private files. Closing or
refreshing discards the live session; explicitly save a project to reopen it later.
Offline reload/install via a PWA is not yet
implemented. Do not open `index.html` with `file://`; serve the build over HTTP or HTTPS.

## Included through Phase 8

- Local drag-and-drop/file-picker import: PCM WAV 8/16/24/32-bit, Float32 WAV;
  FLAC via the browser decoder (support varies by browser).
- Source-rate analysis, mono/stereo min/max waveform, original audio playback.
- Integrated LUFS (K weighting, absolute/relative gating), sample peak, **estimated**
  true peak (4× interpolation), RMS, crest factor, stereo correlation, side energy,
  DC offsets and samples at/above full scale.
- Worker-based analysis, cancel/replace behavior, file/PCM bounds and clear errors.
- Manual gain, one-band peaking EQ, linked offline limiter; processed B is re-analyzed.
- Float32/PCM24/PCM16 WAV and local MP3 export of processed B, MP3 metadata/jacket,
  portable project save/reopen and selected-source JSON analysis export.
- Deterministic local mastering: explain gain, re-measure output and accept only
  candidates meeting fixed quality gates; preserve A and prior B on rejection.
- Pure TypeScript Core that can also be consumed in Node; Core's runtime packages
  remain separate from the Web-only ZIP library and optional MP3 encoder.

For the main workflow: import a song, press **AUTO**, **IMPACT** or **LIVE**,
compare **Original / Processed**, then export if you prefer the result. The engine
adapts its Mix correction to measured input, analyzes the intermediate result,
masters it, then checks quality. Failed candidates are weakened/replanned up to
three attempts; A and prior B remain untouched. Accepted candidates enable loudness
match automatically. Technical controls are in collapsed **Advanced Settings**.
Phase 7 adds temporal eight-band features, confidence/evidence-based restraint,
conditional Dynamic EQ / three-band dynamics and objective-based re-evaluation.
The main AUTO / IMPACT / LIVE controls stay simple; Advanced explains both chosen
and skipped changes. See [perceptual intelligence](docs/perceptual-intelligence.md)
and [automatic finishing](docs/auto-finishing.md) for design and limits.

Choose **音色・演出イコライザー** for warm/clear/vocal/bass EQ or AM radio,
old record, cassette, telephone and next-room sound, with three simple strengths.
Apply colour alone from Original, or include it after AUTO / IMPACT / LIVE.
Selection preserves existing B until a measured candidate is accepted. See
[sound colour choices](docs/sound-color.md) for effects, gates and Core integration.

For **LIVE**, choose ライブハウス / ホール / アリーナ and 控えめ / 標準 /
はっきり. The default is ホール・はっきり with a denser venue response, filtered
wet bass and a preserved foreground. Selection alone keeps B. See
[venue LIVE](docs/live-venues.md) for its adaptive plan and unchanged safety gates.

Use **音量差デモを試す** or load a second file into B / After. Switch A/B while
playing, seek on the shared timeline, and enable **ラウドネスマッチ** to compare
at estimated equal loudness. Original measurements and PCM remain unchanged.
See [comparison behavior and limits](docs/comparison.md).

For optional manual processing, open **Advanced Settings**, adjust **音を整える** and press **AからBを生成**. Compare the
new B, then use the processed-B save button. Changes are always rendered from A.
Use **全体バイパス** for an exact copy. See [DSP behavior and bounds](docs/processing.md).

For optional numeric loudness adjustment, open **Advanced Settings** and choose a target in **自動で音量を整える** and
press **自動マスタリングしてBへ**. Accepted results become B; declined results
explain why. This does not automate EQ or repair distortion. See [mastering policy](docs/mastering.md).

Current finishing limits: 100 MiB per file, 10 minutes per file, 192 MiB combined
A/B decoded PCM, 1–2 channels, 8–192 kHz. Single-WAV chunked analysis/Original
preview and file-backed finishing have a separate 20-minute / 512 MiB input bound.
LUFS is unavailable for clips shorter than 400 ms or below the gate. Undefined
values serialize as `null`; they are never replaced by RMS. Dynamics means crest
factor, not LRA. Metering is experimental and not certified for broadcast delivery.
See [measurement definitions and limits](docs/measurement.md).

## Repository layout

```text
music-sync/
  apps/web/                 browser I/O, Worker, playback and workspace UI
  apps/desktop/             preserved desktop boundary and migration instructions
  packages/core/            host-independent analysis and comparison API
  packages/dsp/             measurement filters and offline processing kernels
  packages/audio-analysis/  deterministic PCM measurements
  packages/ui/              waveform rendering and visual tokens
  packages/shared/          PCM/report contracts, validation and limits
  docs/                     audit, design, migration, development and licensing
  examples/                 independent Core consumer
  tests/                    synthetic reference, unit and browser tests
```

## Use Core in another app

Build the workspace with `npm run build`, then run `npm run example`.

```js
import { analyzeAudio } from '@music-sync/core';

const report = analyzeAudio({
  sampleRate: 48000,
  channels: [leftFloat32Array, rightFloat32Array],
});
console.log(report.integratedLufs, report.truePeakDbtp);
```

Use `npm run release:local` to create installable tarballs and a direct-browser
ES module in `artifacts/v<version>`. Install all dependency tarballs together in another
app; see [distribution instructions](docs/distribution.md). Examples include Node,
browser bundler and plain module Worker consumers.

Packages are **not published on npm**. The source is available in the
[GitHub repository](https://github.com/luarietakamiya-dotcom/music-sync), while
the npm registry scope and publication remain undecided; `private: true` prevents
accidental registry publishing. The local SDK
works independently of this repository after installation. Read the [API
compatibility policy](docs/compatibility.md) and [API guide](docs/api.md).

## Incremental roadmap

| Phase | Deliverable | Status |
| --- | --- | --- |
| 1 | Import, waveform, basic measurements, results | Implemented |
| 2 | Time-aligned Before/After, loudness-matched listening | Implemented |
| 3 | Explicit DSP chain and processed WAV export | Implemented |
| 4 | Explainable automatic loudness mastering with quality gates | Implemented (experimental) |
| 5 | Local SDK packages, external app integration, compatibility policy | Implemented; registry publication pending |
| 6 | Adaptive Mix → Master, AUTO / IMPACT / LIVE, iterative quality gates | Implemented (experimental) |
| 7 | Temporal perceptual features, confidence-based correction and objective gates | Implemented (experimental) |
| 8 | Named EQ/vintage sound choices, strength, matched comparison and Core API | Implemented; desktop mode catalogue remains partial |

Each phase has its own validation gates in [the migration plan](docs/migration-plan.md).
VST3 and OS device integration remain desktop concerns.

## Contribute and publish

Start with [CONTRIBUTING](CONTRIBUTING.md), [development setup](docs/development.md),
[architecture](docs/architecture.md) and [the current desktop audit](docs/current-architecture.md).
Bug reports and feature proposals have [GitHub issue forms](https://github.com/luarietakamiya-dotcom/music-sync/issues/new/choose).
The GitHub Actions workflow defines lint/test/build checks for pushes and PRs;
inspect the [Actions run](https://github.com/luarietakamiya-dotcom/music-sync/actions)
for its current result. See [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md) and [SECURITY](SECURITY.md).

Source publication and hosting are separate. No hosted application, npm release or
audio-upload service is configured by this source publication. Maintainers should
review vulnerability reporting and branch protection in the
[publication checklist](docs/publication.md).

## License

New code, generated test assets and the three project-owned notification sounds
in this repository: [MIT](LICENSE).
The optional MP3 encoder retains LGPL-3.0, with notices, full license texts and
corresponding source included. The sound creator authorized release of
`processing_loop.wav`, `success.wav` and `error.wav` under the same MIT license;
their provenance and license are included beside the files. Legacy desktop source, DLLs, plugins and artwork remain
outside this workspace. See [third-party notices](THIRD_PARTY_NOTICES.md) and
[the license audit](docs/licenses.md).
