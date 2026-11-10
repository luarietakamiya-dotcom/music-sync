# Projects, audio export and notification sounds

Music Sync processes music on your device. A project is an editable snapshot with
included audio; an audio export is a listening/delivery file made from the current
accepted B. Neither operation uploads files or uses a paid API.

## Save and reopen a project

Choose **素材込みでプロジェクトを保存** after importing audio. The downloaded
`.musicsync.zip` contains original materials, the actual current A/B audio, current
finishing/export controls, metadata and any selected jacket. STEM projects include
both the committed mix settings and staged role/gain/include/per-material-repair
selections, so a pending adjustment remains distinguishable from the current mix.

Use **プロジェクトを開く** to select that archive. Music Sync validates the
archive, application settings and audio, re-measures the included A/B, and restores
the current audio without automatically mastering it again. On the next automatic finish, a restored STEM mix with material repairs is rebuilt first to refresh its repair decisions and avoid applying the same repair twice. It commits the new
session only after preparation succeeds. Failure or cancellation keeps the
previous session. A saved DSP explanation is treated as descriptive state; fresh
audio measurements remain the evidence for the restored sound.

A project does not contain an in-progress Worker job, a resumable rendering
checkpoint or a complete Undo history. Notification sound preferences belong to
this browser and are not imported from somebody else's project. Closing or
refreshing the page does not automatically save your project: explicitly download
the archive first. Browser download initiation does not prove that a file was
saved to disk.

Projects contain private music, original filenames, metadata and images. They are
not the anonymized finishing report. Check their contents and distribution rights
before sharing them. No OS path is followed and no plugin or executable is loaded
when opening a project.

### Archive format and bounds

Version 1 is a restricted, uncompressed ZIP STORE archive: one `manifest.json`
and explicitly declared `assets/<id>.bin` entries. This is not a general-purpose
ZIP importer. `project-archive.ts` owns the container contract;
`project.worker.ts` performs its I/O away from the UI. The host owns the schema
and transactional restoration of Music Sync settings.

| Bound | Value |
| --- | --- |
| Included assets | Up to 64 |
| Each asset | Up to 512 MiB |
| Combined asset bytes | Up to 2 GiB |
| Manifest | Up to 8 MiB |
| Blob-only export fallback | Up to 256 MiB, including archive overhead |

Larger exports require available origin-private temporary storage and browser
support for that path. Source-audio/decoded-PCM limits still apply when reopening;
the archive bound is not a promise that every combination can be rendered on every
device. Reads are bounded and CRC-checked. Compressed/encrypted entries, ZIP64,
split archives, duplicate/unexpected paths, symlinks and inconsistent lengths are
rejected. JSON permits data only, with bounded size/depth and validated settings.

## Export the accepted result

Select a format, then use the processed-B save button. Export consumes the current
B audio, not the speaker mix. A/B loudness-match gains, solo monitoring volume and
notification sounds are never included. Changing an export format does not
reprocess or replace A/B. The beginner finish-and-save flow uses the selected
format only after accepting its new candidate.

| Format | Use and behavior |
| --- | --- |
| WAV Float32 | Keeps source rate and floating-point samples; no integer quantization or dither. Useful as a working master. |
| WAV PCM24 | Integer WAV at source rate; optional TPDF dither. |
| WAV PCM16 | Integer WAV at source rate; optional TPDF dither. Selecting a CD loudness guide does not create a CD-compliant sample rate or disc image. |
| MP3 | Local lossy encoding at 128 / 192 / 256 / 320 kbps; default 192 kbps. Optional metadata and front-cover jacket. |

Integer WAV and MP3 reject samples above full scale instead of silently clipping
them. Export does not add another limiter or guarantee encoded true-peak delivery
compliance. Float32 can represent over-range samples, so a player may still clip
such files. MP3's sample rate can differ from the input and encoder delay/padding
can affect decoded length. The app's B analysis describes B before lossy encoding;
it is not a measurement of a subsequently decoded MP3. Keep a WAV master when
further editing or delivery verification matters.

Audio conversion runs in `audio-export.worker.ts`. WAV sources can be read in
bounded chunks; encoded output and browser download buffers still use storage or
memory. Cancellation discards the pending export and keeps A/B and original files.

### MP3 metadata and jacket

The editor supports title, artist, album, album artist, year, track, genre and
comment. Tags use ID3v2.3 with UTF-16 text; the cover uses a front-cover APIC frame.
Fields are limited to 1,000 characters, year to four digits, and track to `1`–`999`
or a valid `1/10` form. Invalid/control text is rejected. These tags and the jacket
are added to MP3, not to the WAV audio stream, and are retained in project saves.

Choose a JPEG or PNG of at most **2 MiB** and **8,192 pixels per side** and **16,777,216 pixels total**. The browser
checks signatures and decoded dimensions before accepting it. An embedded image
can contain its own metadata; Music Sync does not promise to strip image metadata.
Title/artist/cover visibility depends on the destination player's tag support.

The optional LAME encoder is a local, separately replaceable LGPL component loaded
only for MP3 export. Its notice, full license texts and corresponding source are
shipped under `apps/web/public/vendor/lamejs/`. Music Sync Core remains independent
of this browser encoder. See [third-party notices](../THIRD_PARTY_NOTICES.md).

## Processing, completion and error sounds

The SE controls are always visible above audio import. Use the header or sidebar **SE音量** shortcut to find them.
The SE controls enable/mute sounds, set their independent volume from 0–100%, and
offer completion/error trial playback. Defaults are on at 25%. These preferences
are stored locally when browser storage is available; blocked storage is harmless.
No sound plays merely because the page loaded.

The three project-owned desktop sound-set files are `processing_loop.wav`,
`success.wav` and `error.wav`. Their creator authorized public distribution under
the [MIT license shipped with the sounds](../apps/web/public/sfx/LICENSE).
The processing loop stops on completion, error,
cancellation or page hide. Playback uses separate media elements from A/B, DSP and
export. A browser may require a user gesture to unlock sound; a blocked SE never
interrupts analysis, processing, project restoration or export. See
[sound-set provenance](../THIRD_PARTY_NOTICES.md#desktop-notification-sounds).
