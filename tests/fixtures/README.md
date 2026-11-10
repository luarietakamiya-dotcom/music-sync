# Synthetic fixtures

`tone.flac.base64` contains a 1 second, 44.1 kHz, mono PCM16 FLAC of a generated
1 kHz sine at amplitude 0.1. SHA-256 after decoding:
`3a5fdb03312e0f52ef96d3f6c8ef92d2159d427a52d75b0f490bc7a4a2d19493`.
`npm run test:e2e` materializes it locally. No copyrighted music is included.

`loudness-reference.json` was calculated independently with pyloudnorm's DeMan
meter, numpy 2.0.2 float32 inputs. Each case is one second with the formula
`0.1 * sin(2 * pi * frequency * arange(sampleRate) / sampleRate)`.
The comparison tolerance is 0.01 LU. These tests are not an ITU conformance suite.
Fixtures are generated for this project and covered by the MIT license.
