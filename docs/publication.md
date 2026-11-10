# Public source publication

The public repository has been created at
[luarietakamiya-dotcom/music-sync](https://github.com/luarietakamiya-dotcom/music-sync).
This checkout is prepared for its first source push. Publishing the repository
does not deploy the Web application or publish npm packages. No hosted Music Sync
Web URL is configured by this publication.

## Source and license scope

- The new Web/Core implementation and synthesized test fixtures use the root MIT
  license. The sound creator also confirmed authorship and authorized public MIT
  redistribution of the three notification files: `processing_loop.wav`,
  `success.wav` and `error.wav`. Their license, provenance and historic README are
  included in `apps/web/public/sfx/`.
- This permission does not relicense the rest of the desktop application. Legacy
  source, native executables/DLLs/plugins, artwork and other desktop sounds remain
  outside this release and retain their separate audit boundaries.
- Preserve the Web vendor notices: fflate's MIT license and the optional LAME
  encoder's LGPL/GPL texts, replacement instructions and corresponding source
  archive. That identified source archive is an intentional part of this release;
  desktop portable ZIPs and unrelated vendor binaries are not.

See [third-party notices](../THIRD_PARTY_NOTICES.md) and the
[license audit](licenses.md) for the exact component scope.

## First-push and repository checks

- Set repository/homepage/bugs metadata to the real GitHub source and issue URLs.
  Keep registry packages `private: true`; an npm scope and registry publication
  remain separate decisions. Local SDK tarball installation is already supported.
- Inspect the staged files and diff before committing: exclude private sessions,
  user music, exported masters, credentials, build caches, desktop distributions
  and machine-specific paths. `.gitignore` supplements that review.
- Use the repository's [Security page](https://github.com/luarietakamiya-dotcom/music-sync/security)
  for vulnerability reporting. Enable GitHub private vulnerability reporting and
  verify its availability before directing users to it. Follow [SECURITY](../SECURITY.md)
  for any fallback; no fictitious maintainer email is provided.
- Keep Actions token permissions read-only and do not run untrusted PR code with
  `pull_request_target`. After checks exist on GitHub, configure the desired branch
  protection and review requirements. Do not describe these settings as enabled
  until they have been verified in the repository.
- Check the first push's actual [Actions result](https://github.com/luarietakamiya-dotcom/music-sync/actions).
  The configured workflow covers `npm ci`, `npm run check`, package installation,
  SDK browser checks and Web E2E tests. Local test success does not establish that
  the first GitHub CI run passed. Review lockfile and transitive license changes.

`npm run release:local` prepares local tarballs, checksums and a browser module;
it does not publish to a registry. No npm publishing token or automated npm release
is required for source publication. Read [distribution instructions](distribution.md)
and the [API compatibility policy](compatibility.md) before a separate SDK release.

## Hosting is a separate step

To make a browser service available, build and publish `apps/web/dist` on a chosen
static host, preserve the vendor/source/license files and apply the documented
security headers. Test its actual HTTPS URL, Worker assets and supported browsers
before announcing a deployed app. Until then, developers can follow the
[local setup](development.md) to run the browser version on their own device.
