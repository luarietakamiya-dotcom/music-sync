# Dependency and license audit

Scope: Web/Core workspace through reference/album finishing v0.15.1 plus a static
inspection of the recovered impact.67 source/distribution and the user-supplied
impact.64 notification sound set. This is an engineering inventory, not proof of
ownership or a legal opinion. Legacy desktop code/binaries are not relicensed or
bundled here. Three separately identified, project-owned desktop notification
WAVs are included with the creator's authorization for public MIT redistribution.

## New Web workspace

The independently authored app/Core/analysis/DSP/UI/shared implementation is new
in this workspace under MIT. Test audio is synthesized. Core library workspaces
depend only on one another at runtime. The Web app additionally uses fflate 0.8.3
(MIT) for portable project archives and an optional, separately distributed
@breezystack/lamejs 1.2.7 encoder (LGPL-3.0) for local MP3 export. No native plugin,
DLL, legacy desktop executable, artwork or font is imported. Build/lint/test
dependencies and transitive versions are recorded in package-lock.

The encoder is unmodified and remains a replaceable runtime ES module under
`apps/web/public/vendor/lamejs`, outside the compiled application/Core package
bundles. That directory ships the upstream notice, full LGPLv3/GPLv3 texts,
replacement instructions and the corresponding source archive. Preserve these
files when deploying the static app. Generated MP3 files are not placed under the
encoder's source license by this feature. See the detailed
[third-party notices](../THIRD_PARTY_NOTICES.md).

The three notification WAVs copied from the user-supplied impact.64 distribution
retain their provenance. The creator confirmed that they made
`processing_loop.wav`, `success.wav` and `error.wav` and authorized their public
OSS release under this repository's MIT license. An exact copy of that license
and a scope-specific provenance note are shipped in `apps/web/public/sfx/`.
The historic sound-set README is preserved unchanged. This authorization does
not extend to other assets, desktop source, native code or dependencies from the
portable application.

Direct development dependencies: TypeScript (Apache-2.0), Vite/Vitest/ESLint and
typescript-eslint (MIT), @types/node (MIT), Playwright (Apache-2.0).
The checked-in [dependency inventory](dependency-inventory.json) records exact
installed package metadata, including transitive license strings. Inspect bundled
license notices when shipping toolchains, rather than assuming only direct licenses
matter. Browser binaries are test-only and excluded from the deliverable.

## Existing desktop — review before importing/releasing

| Component | Finding / action |
| --- | --- |
| Application/native_core | No clear root LICENSE found in recovered source. Establish authorship/permission before placing it under the new LICENSE. |
| NumPy / SciPy | BSD-style licensing; wheel-bundled BLAS and other native notices also need collection. Existing requirements only set minimum versions. |
| soundfile / libsndfile | Python wrapper BSD-3-Clause; libsndfile LGPL. The ZIP includes a COPYING file. Verify exact DLL version, source availability/relinking requirements and codec dependencies for any redistribution. |
| pyloudnorm | MIT. Optional runtime fallback to RMS must not be mistaken for measured LUFS. |
| sounddevice / PortAudio | Inspect wrapper and native library notices plus the exact ASIO build. A DLL named libportaudio64bit-asio.dll is present; a filename alone does not establish redistribution rights. |
| Tcl/Tk, TkDND, tkinterdnd2, Pillow | Collect exact version notices from the vendor/runtime build. Tk licenses exist in the ZIP; provenance of the copied vendor runtime needs documenting. |
| PyInstaller | Verify bootloader exception and bundled dependency notices for the actual build; don't apply its license wholesale to the application. |
| Artwork and SFX | Artwork and other sounds remain outside this grant. The creator authorized MIT redistribution of the three project-owned notification WAVs (`processing_loop.wav`, `success.wav`, `error.wav`), shipped with LICENSE, provenance and the original README. |
| VST3 / third-party plugins | No current host import found in audited native_core. SDK license and plugin license are separate. Current VST3 SDK is MIT, but historic SDK versions and individual plugin binaries need separate checking. No VST redistribution in Web. |

Before importing desktop: generate a pinned dependency lock for supported Python
versions, SBOM and license bundle; inventory every vendor binary and asset; record
owner approval; review any model/data dependencies if added. Do not publish user
sessions, generated masters, credentials, diagnostic logs or unlicensed media.

Official sources checked:

- [NumPy license](https://numpy.org/doc/stable/license)
- [SciPy source/license](https://github.com/scipy/scipy/blob/main/LICENSE.txt)
- [libsndfile COPYING](https://github.com/libsndfile/libsndfile/blob/master/COPYING)
- [pyloudnorm source](https://github.com/csteinmetz1/pyloudnorm)
- [VST3 licensing](https://steinbergmedia.github.io/vst3_dev_portal/pages/VST%2B3%2BLicensing/Index.html)
- Exact npm package licenses are available in the installed package metadata/license files.

Phase 3 adds no third-party runtime dependency. The peaking EQ implementation
uses the mathematical formulas documented in the [W3C Audio EQ Cookbook](https://www.w3.org/TR/audio-eq-cookbook/)
(Robert Bristow-Johnson). The code is newly implemented; no source or prose is copied.
