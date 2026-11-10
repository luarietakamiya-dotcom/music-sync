# Windows impact.67 reference review

Inspected the requested `Music_Sync_v2.0.0-alpha.16.5-impact.67_Freeze_Guard_Windows_Portable.zip`.
Archive SHA-256: `cab57e43e6d638297dd40c6c3840b9c4af39881b7def3f2b2381207a59b4b7a9`.
The current archive hash matches the recorded Phase 1 baseline. It contains 1,286
entries, MusicSync.exe, bundled Python/native libraries and run_windows_safe.bat.
This was static inspection, not a new execution or subjective listening review of
the Windows GUI/binary.

Also inspected the previously recovered source matching that baseline:

- app.py exposes natural MUSICAL versus stronger IMPACT and a separate performance
  mode hub. Live venue choices include Club, multiple arena sizes and outdoor types.
- native_core/live_venue.py combines predelay, early reflection, filtered late
  ambience and normalization. This confirmed that a useful LIVE direction should
  preserve the foreground while managing space, not merely add an unbounded reverb.
- native_core/final_guard.py uses different reduction/crest policies for live,
  natural and impact profiles. Its desktop target/thresholds were not copied as
  Web guarantees or used to force high loudness on every input.
- run_windows_safe.bat limits DSP workers and numeric threads. Web uses one
  cancellable Worker and bounded sequential candidates, without numerical worker pools.

The Web implementation is new TypeScript code and uses no copied Python algorithms,
IR audio assets, desktop binaries or vendor plugins. In particular LIVE uses a new
small damped delay network, rather than copying desktop FFT convolution. The prior
98-file source manifest is rechecked before packaging. Desktop remains untouched.

Product direction retained: simple purpose selection, natural/impact distinction,
independent venue strategy, original preservation and measured safety checks.
Additional Web work: input-dependent problem detection, separate Mix/Master plans,
bounded retries, plain explanations and loudness-matched candidate comparison.
