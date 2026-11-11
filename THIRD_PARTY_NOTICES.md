# Third-party notices

Music Sync's independently authored application and Core code use the root
[MIT license](LICENSE). Separately identified components below keep their own
terms. These notices do not transfer rights in imported music, project materials
or cover images.

## Local project archive

- **fflate 0.8.3**, MIT, by Arjun Barrett and contributors.
- Source and license: [101arrowz/fflate](https://github.com/101arrowz/fflate).
- Used by the Web application's local ZIP STORE project reader/writer. It is not
  a dependency of the separately packaged Music Sync Core libraries.
- The installed package includes its MIT license; preserve that notice when
  redistributing its code or a bundle containing it. A copy is shipped at [vendor/fflate/LICENSE](apps/web/public/vendor/fflate/LICENSE).

## Optional local MP3 encoder

- **@breezystack/lamejs 1.2.7**, a JavaScript port of LAME, LGPL-3.0.
- Upstream: [gideonstele/lamejs](https://github.com/gideonstele/lamejs);
  [LAME project](https://lame.sourceforge.io/).
- Package: [@breezystack/lamejs 1.2.7](https://www.npmjs.com/package/@breezystack/lamejs/v/1.2.7).

The browser receives an unmodified, separate ES module that is imported only when
MP3 is requested. It is not compiled into Music Sync application code or Core SDK
packages. An interface-compatible `Mp3Encoder` module can replace it. Music Sync
does not prevent reverse engineering for debugging modifications to this LGPL
component. The encoder's license terms apply to its code, not the music encoded
with it.

Files shipped alongside that module:

- [Component notice and replacement/source instructions](apps/web/public/vendor/lamejs/NOTICE.txt)
- [Upstream license notice](apps/web/public/vendor/lamejs/UPSTREAM-LICENSE.txt)
- [LGPLv3 full text](apps/web/public/vendor/lamejs/COPYING.LESSER)
- [GPLv3 full text](apps/web/public/vendor/lamejs/COPYING)
- [Corresponding source archive](apps/web/public/vendor/lamejs/lamejs-1.2.7-source.tar.gz)

The source archive corresponds to upstream commit
`1fb0ef5fa177413107e2e107d054a9b994e3f79c`; its exact origin and the pinned npm
package are recorded in the component notice. Static hosting must preserve the
notice, licenses, source archive and separately replaceable module together.

## Desktop notification sounds

`apps/web/public/sfx/processing_loop.wav`, `success.wav` and `error.wav` were
copied from the user-supplied Music Sync
`v2.0.0-alpha.16.5-impact.64_Creative_Mode_Hub_Portable` distribution's
`_internal/assets/sfx` directory for the requested Web notification behavior.
The accompanying [original sound-set README](apps/web/public/sfx/README.txt)
identifies the Music Sync v1.3 Live Producer UI Sound Set and its playback behavior.

The sound creator confirmed authorship and authorized public OSS redistribution
of these **three project-owned WAV files under the root MIT license**. Their
[local LICENSE](apps/web/public/sfx/LICENSE) is an exact copy of the root license;
the [provenance note](apps/web/public/sfx/PROVENANCE.md) records the included set
and keeps the original README separate from the current license grant.

This authorization covers `processing_loop.wav`, `success.wav` and `error.wav`.
It does not relicense other desktop code, sounds, artwork, plugins or vendor
binaries. The other filenames mentioned in the historic README are not included
in the Web sound set. No legacy executable, native plugin or DLL is copied or run
by this feature.

## Local AI separation (v0.16)

- **SCNet weights**: MIT, copyright starrytong. The model author explicitly confirms
  pretrained-weight and converted-model redistribution in
  https://github.com/starrytong/SCNet/issues/35 . The pinned audiojs conversion
  (12,900,277 bytes, SHA-256 98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845)
  is distributed with its full license and provenance under apps/web/public/models/scnet-small/.
- **Mega53 drum subset**: author permission covers commercial use, redistribution and
  conversion of the 53-STEM weights under MIT:
  https://github.com/ZFTurbo/Music-Source-Separation-Training/issues/245#issuecomment-5834608838 .
  The five-head, weight-compacted portable ONNX conversion is 91,762,503 bytes,
  SHA-256 2044dee8a8756b92bc92ae14a0069d744bc67457ba3a4f2a592f414a17eaa8b2.
  Full notices, pinned checkpoints, conversion provenance and measured limits are
  in apps/web/public/models/mega53-drums/. The computed remaining-drums output is
  not an extra learned cymbal/ride/crash classifier.
- **@audio/neural-separate 0.7.0** and its runtime/resampler/FFT helpers are MIT.
  Source: https://github.com/audiojs/neural . These perform host FFT/inverse FFT
  and resampling; Music Sync provides its own session, ownership and bounded rendering.
  Full original copyright/license texts and translated-code notices are copied to
  [vendor/audiojs/ThirdPartyNotices.txt](apps/web/public/vendor/audiojs/ThirdPartyNotices.txt).
- **ONNX Runtime Web 1.31.1**: MIT, copyright Microsoft Corporation.
  Source: https://github.com/microsoft/onnxruntime/tree/v1.31.1 .
  Full upstream LICENSE and ThirdPartyNotices.txt are also served under vendor/onnxruntime/.

Model permissions do not grant rights to an input recording or guarantee the
musical quality of a separated output. No non-commercial-only Demucs/DrumSep
checkpoint is silently substituted or automatically downloaded.
