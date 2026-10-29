# Changelog

## [2.8.0](https://github.com/directionally-local/autopilot/compare/v2.7.2...v2.8.0) (2026-10-29)


### Features

* **remote:** open the model picker for /model in remote sessions ([#1007](https://github.com/directionally-local/autopilot/issues/1007)) ([96be70b](https://github.com/directionally-local/autopilot/commit/96be70bd45c4a4e1324a5fd2e67b7ff8244334d7))
* **tools:** append post-edit diagnostics to edit/write results ([#1006](https://github.com/directionally-local/autopilot/issues/1006)) ([d897b61](https://github.com/directionally-local/autopilot/commit/d897b61684538c1747f9b54972fc169a5cf51805))


### Bug Fixes

* **ci:** create releases with GITHUB_TOKEN and PRs with the bot PAT ([#997](https://github.com/directionally-local/autopilot/issues/997)) ([f06fef8](https://github.com/directionally-local/autopilot/commit/f06fef89dc74696963b321cb3a0b3dfcc1394264))
* **git:** block commits and history rewrites on the default branch ([#1005](https://github.com/directionally-local/autopilot/issues/1005)) ([b7e42e0](https://github.com/directionally-local/autopilot/commit/b7e42e0185ed81c8cfbc15ba34a7bc60f7ad871a))
* **subagents:** remove abort listeners when workers finish or wake ([#1004](https://github.com/directionally-local/autopilot/issues/1004)) ([abf3ea7](https://github.com/directionally-local/autopilot/commit/abf3ea79619d22ae5f3987c247c22de1b01c7818)), closes [#967](https://github.com/directionally-local/autopilot/issues/967)

## [2.7.2](https://github.com/directionally-local/autopilot/compare/v2.7.1...v2.7.2) (2026-10-29)


### Bug Fixes

* **tools:** name the missing edit payload and stop blind retries ([#994](https://github.com/directionally-local/autopilot/issues/994)) ([ab57a0d](https://github.com/directionally-local/autopilot/commit/ab57a0d47abf7709321257ba3bd79d8d748f2067))

## [2.7.1](https://github.com/directionally-local/autopilot/compare/v2.7.0...v2.7.1) (2026-10-29)


### Bug Fixes

* **agent:** batch checklist updates with tool calls ([#989](https://github.com/directionally-local/autopilot/issues/989)) ([79955e0](https://github.com/directionally-local/autopilot/commit/79955e0cf45ce93cc18b05edb9a0c012833abc68))
* **agent:** name Hotcell gateway refusals instead of blaming OpenRouter ([#987](https://github.com/directionally-local/autopilot/issues/987)) ([88959fe](https://github.com/directionally-local/autopilot/commit/88959fe18124fdd97ac00e9f10afbc8a63b13467))
* recover repeated read calls with full output ([#988](https://github.com/directionally-local/autopilot/issues/988)) ([3b32e5a](https://github.com/directionally-local/autopilot/commit/3b32e5aa4df5a8a040429ac0f8875111a33f504c))
* **tools:** scale read output caps with model context ([#985](https://github.com/directionally-local/autopilot/issues/985)) ([fdb90c5](https://github.com/directionally-local/autopilot/commit/fdb90c57b2be1cf60afe605b0ba1b69280646f7b)), closes [#964](https://github.com/directionally-local/autopilot/issues/964)

## [2.7.0](https://github.com/directionally-local/autopilot/compare/v2.6.2...v2.7.0) (2026-10-29)


### Features

* add attach-remote, the interactive UI for Aster server conversations ([#982](https://github.com/directionally-local/autopilot/issues/982)) ([33e717e](https://github.com/directionally-local/autopilot/commit/33e717e6fc4f68c2471ddb1dccca689561f8a69b))


### Bug Fixes

* **aster:** start the repository-scoped GitHub proxy again, and log why provisioning fails ([#981](https://github.com/directionally-local/autopilot/issues/981)) ([c93e348](https://github.com/directionally-local/autopilot/commit/c93e3482a3118a505d4ddff38136b20d0c55f99c))

## [2.6.2](https://github.com/directionally-local/autopilot/compare/v2.6.1...v2.6.2) (2026-10-28)


### Bug Fixes

* **subagents:** avoid delegating trivial tasks ([#977](https://github.com/directionally-local/autopilot/issues/977)) ([078c636](https://github.com/directionally-local/autopilot/commit/078c6369eea8fd8bf91a32ce17b80b38e72745a2)), closes [#961](https://github.com/directionally-local/autopilot/issues/961)
* **tools:** handle early git ignore pipe closure ([#979](https://github.com/directionally-local/autopilot/issues/979)) ([96df311](https://github.com/directionally-local/autopilot/commit/96df31121c1cbfc3e1d18542391d0b3781e40a36))

## [2.6.1](https://github.com/directionally-local/autopilot/compare/v2.6.0...v2.6.1) (2026-10-28)


### Bug Fixes

* **agent:** retry transient network drops ([#973](https://github.com/directionally-local/autopilot/issues/973)) ([eb430b8](https://github.com/directionally-local/autopilot/commit/eb430b845ae5bd54ac5cc44c5b78b7817c9b13e3)), closes [#960](https://github.com/directionally-local/autopilot/issues/960)
* **tools:** harden grep fallback output handling ([#975](https://github.com/directionally-local/autopilot/issues/975)) ([be6ff3d](https://github.com/directionally-local/autopilot/commit/be6ff3d05c5e36608f547c7b339aa697e5fcf052))

## [2.6.0](https://github.com/directionally-local/autopilot/compare/v2.5.0...v2.6.0) (2026-10-28)


### Features

* **aster:** list credentials and runs from the server CLI, and point the pairing page at dl ([#969](https://github.com/directionally-local/autopilot/issues/969)) ([6ba7e36](https://github.com/directionally-local/autopilot/commit/6ba7e363b41561c2a7059b5547c69fea40527c77))


### Bug Fixes

* **subagents:** remove automatic worker spend caps ([#971](https://github.com/directionally-local/autopilot/issues/971)) ([ec24889](https://github.com/directionally-local/autopilot/commit/ec248891965e1b87e168a5b9c65234eb8d39a126)), closes [#959](https://github.com/directionally-local/autopilot/issues/959)

## [2.5.0](https://github.com/directionally-local/autopilot/compare/v2.4.4...v2.5.0) (2026-10-28)


### Features

* **storage:** stop auto-deleting sessions and traces; add `autopilot history` ([#957](https://github.com/directionally-local/autopilot/issues/957)) ([8b3b2a6](https://github.com/directionally-local/autopilot/commit/8b3b2a68cbeaf351bb1934ed448eab74b6a66e73))
* **tools:** guard edits with per-session file hashes ([#954](https://github.com/directionally-local/autopilot/issues/954)) ([2f50524](https://github.com/directionally-local/autopilot/commit/2f505245d78c7ad59f19d407fc06a48609fa893d)), closes [#949](https://github.com/directionally-local/autopilot/issues/949)

## [2.4.4](https://github.com/sinameraji/autopilot/compare/v2.4.3...v2.4.4) (2026-10-27)


### Bug Fixes

* **deps:** bump @hotcell/sdk ([#943](https://github.com/sinameraji/autopilot/issues/943)) ([aff1160](https://github.com/sinameraji/autopilot/commit/aff11602636a549107b92cd97526d23381572201))
* **deps:** bump the own-packages group with 2 updates ([#941](https://github.com/sinameraji/autopilot/issues/941)) ([83be6c0](https://github.com/sinameraji/autopilot/commit/83be6c092e86b645f047603172fd27540472fd13))

## [2.4.3](https://github.com/sinameraji/autopilot/compare/v2.4.2...v2.4.3) (2026-10-24)


### Bug Fixes

* **deps:** bump @hotcell/sdk ([#938](https://github.com/sinameraji/autopilot/issues/938)) ([83d830b](https://github.com/sinameraji/autopilot/commit/83d830b55fcca9d6c1d41aabf47e49db0cf05d05))
* **security:** refuse web_fetch on runtimes with the Brotli RCE (CVE-2026-111497) ([#940](https://github.com/sinameraji/autopilot/issues/940)) ([6e6fd62](https://github.com/sinameraji/autopilot/commit/6e6fd62c8b1976bc7c0a05821c5b8be0144e0cf2))

## [2.4.2](https://github.com/sinameraji/autopilot/compare/v2.4.1...v2.4.2) (2026-10-23)


### Bug Fixes

* **serve:** keep a malformed Host header from crashing the server ([#936](https://github.com/sinameraji/autopilot/issues/936)) ([a613f15](https://github.com/sinameraji/autopilot/commit/a613f15d0f2ee6fdc60106ee59428731585f4c64))

## [2.4.1](https://github.com/sinameraji/autopilot/compare/v2.4.0...v2.4.1) (2026-10-23)


### Bug Fixes

* **permissions:** stop bash allow rules matching chained commands ([#934](https://github.com/sinameraji/autopilot/issues/934)) ([3f405df](https://github.com/sinameraji/autopilot/commit/3f405dfca970b6f99668a289eea89889a89a72e9))
* **tools:** ask before web_fetch/browser_fetch reach private addresses ([#933](https://github.com/sinameraji/autopilot/issues/933)) ([913f3aa](https://github.com/sinameraji/autopilot/commit/913f3aacda86dc378444bad2a88249e9eff658e6))

## [2.4.0](https://github.com/sinameraji/autopilot/compare/v2.3.0...v2.4.0) (2026-10-22)


### ⚠ BREAKING CHANGES

* **hooks,lsp:** require trust before running a project's hooks or LSP servers ([#925](https://github.com/sinameraji/autopilot/issues/925))

### Bug Fixes

* **code-mode:** never run model code in node:vm; turn Code Mode off instead ([#930](https://github.com/sinameraji/autopilot/issues/930)) ([68ea9bc](https://github.com/sinameraji/autopilot/commit/68ea9bc6eb969cd2ad7fd3df098d0318e4efab73))
* **hooks,lsp:** require trust before running a project's hooks or LSP servers ([#925](https://github.com/sinameraji/autopilot/issues/925)) ([74bb908](https://github.com/sinameraji/autopilot/commit/74bb90878cc8ea91ae9b3d11af6d8dbea0470090))
* **permissions:** scope "allow for this session" to the exact command or file ([#928](https://github.com/sinameraji/autopilot/issues/928)) ([18a4cdd](https://github.com/sinameraji/autopilot/commit/18a4cdda3f2089dcef4b469dd6ff52dfb83c07a6))
* **plan-mode:** stop auto-allowing bash that runs programs or writes files ([#927](https://github.com/sinameraji/autopilot/issues/927)) ([543d085](https://github.com/sinameraji/autopilot/commit/543d085c4b7d6c9cb2bac691f4a48c31155ce122))
* **serve:** gate auth on the normalized request path ([#924](https://github.com/sinameraji/autopilot/issues/924)) ([1f66e15](https://github.com/sinameraji/autopilot/commit/1f66e159471634144c1f1788fdfa0a2de1364db4))
* **tools:** ask before reading credentials files ([#929](https://github.com/sinameraji/autopilot/issues/929)) ([b1ba529](https://github.com/sinameraji/autopilot/commit/b1ba529b3b0f0015c9e5c38c0dcab19cb89e10f5))

## [2.3.0](https://github.com/sinameraji/autopilot/compare/v2.2.0...v2.3.0) (2026-10-22)


### Features

* **serve:** serve the Aster API without a host provider key when Hotcell brings the model ([#918](https://github.com/sinameraji/autopilot/issues/918)) ([84a8bc9](https://github.com/sinameraji/autopilot/commit/84a8bc946414ae4bf7d4550eca863a112a1892fb))


### Bug Fixes

* **remote:** detach when Ctrl-C lands before the run starts streaming ([#923](https://github.com/sinameraji/autopilot/issues/923)) ([6bdc4a9](https://github.com/sinameraji/autopilot/commit/6bdc4a9e6c215b547ece5770d0efa7daabb60e9e))

## [2.2.0](https://github.com/sinameraji/autopilot/compare/v2.1.0...v2.2.0) (2026-10-21)


### Features

* **remote:** run tasks on your own server from the laptop ([#915](https://github.com/sinameraji/autopilot/issues/915)) ([fa21765](https://github.com/sinameraji/autopilot/commit/fa217659a0194b90c7581a9b679b62fec4bd4172))


### Bug Fixes

* **hooks:** prompt events in every host, session id first, and file diffs for Beacon ([#916](https://github.com/sinameraji/autopilot/issues/916)) ([9dfb06c](https://github.com/sinameraji/autopilot/commit/9dfb06ca12709ed04e221787c2d001edd5d0ab74))

## [2.1.0](https://github.com/sinameraji/autopilot/compare/v2.0.0...v2.1.0) (2026-10-21)


### Features

* **server:** device-code pairing, run listing, and local-patch upload for the Aster API ([#913](https://github.com/sinameraji/autopilot/issues/913)) ([5c4a25f](https://github.com/sinameraji/autopilot/commit/5c4a25fb9ef74fbb30408ab7cf904ae02b29b301))

## [2.0.0](https://github.com/sinameraji/autopilot/compare/v1.30.0...v2.0.0) (2026-10-21)


### ⚠ BREAKING CHANGES

* **ui:** `--ui ink`, `KIMIFLARE_UI=ink` and `/ui` are gone; the `--ui` option is now rejected as unknown. A saved `uiEngine` is ignored and dropped the next time the config is saved.

### Features

* **camouflage:** first-run onboarding ([#903](https://github.com/sinameraji/autopilot/issues/903)) ([71a6412](https://github.com/sinameraji/autopilot/commit/71a64125e1a03ba2f7c7a15d73a5466b788b84f0))
* **ui:** no Ink fallback; explain a missing renderer and restart a crashed one ([#904](https://github.com/sinameraji/autopilot/issues/904)) ([f9798e5](https://github.com/sinameraji/autopilot/commit/f9798e54db63fd46de6991b9b15e5856d15c4973))


### Bug Fixes

* **camouflage:** queue plan picker, working resume, deny with feedback, richer status line ([#906](https://github.com/sinameraji/autopilot/issues/906)) ([e17dd5d](https://github.com/sinameraji/autopilot/commit/e17dd5dc1e05b00e6b5ae3caa9d0055d8f115956))
* **cost-debug:** never let a failed debug write end the session ([#905](https://github.com/sinameraji/autopilot/issues/905)) ([a96eab0](https://github.com/sinameraji/autopilot/commit/a96eab063c7fddf6f887e2d2fe9b2bded08e3e15))


### Code Refactoring

* **ui:** remove the Ink UI route; Camouflage is the only interface ([#908](https://github.com/sinameraji/autopilot/issues/908)) ([28b55c1](https://github.com/sinameraji/autopilot/commit/28b55c107b25256d29beb76c5e1f745e7854b279))

## [1.30.0](https://github.com/sinameraji/autopilot/compare/v1.29.0...v1.30.0) (2026-10-20)


### Features

* **aster:** add repo-scoped coding sessions and PR lifecycle ([#865](https://github.com/sinameraji/autopilot/issues/865)) ([8841061](https://github.com/sinameraji/autopilot/commit/884106120d7174826d88b28e5d7f9500780e24a6))
* **hooks:** read hooks from autopilot paths and match Claude tool names ([#896](https://github.com/sinameraji/autopilot/issues/896)) ([7054e01](https://github.com/sinameraji/autopilot/commit/7054e0154faf7b7ac52b991049dfe68deaca9aaa))
* **hooks:** surface hook failures, add failClosed, PostToolUseFailure and PermissionRequest ([#900](https://github.com/sinameraji/autopilot/issues/900)) ([b0bd92e](https://github.com/sinameraji/autopilot/commit/b0bd92e71d9b9ac0f169518ef13242b6fc813254))
* **hooks:** write a Claude Code-style JSONL transcript at transcript_path ([#898](https://github.com/sinameraji/autopilot/issues/898)) ([1b09311](https://github.com/sinameraji/autopilot/commit/1b09311794b439b970f7c2cdff34689029d776ed)), closes [#892](https://github.com/sinameraji/autopilot/issues/892)
* **package:** ship dependencies unbundled ([#902](https://github.com/sinameraji/autopilot/issues/902)) ([0a65dec](https://github.com/sinameraji/autopilot/commit/0a65dec979fa5a8e6b29d4633c3b757b83270b1e))
* **sdk:** end live sessions when the host process exits without dispose() ([#897](https://github.com/sinameraji/autopilot/issues/897)) ([f63292b](https://github.com/sinameraji/autopilot/commit/f63292bcb53c75fb91a37d112aeebca71d6c5e10))


### Bug Fixes

* **serve:** print startup failures as a message, not a stack trace ([#886](https://github.com/sinameraji/autopilot/issues/886)) ([1491c96](https://github.com/sinameraji/autopilot/commit/1491c96375f2844fc568c5bd0744a9faf8336b14))

## [1.29.0](https://github.com/sinameraji/autopilot/compare/v1.28.0...v1.29.0) (2026-10-20)


### ⚠ BREAKING CHANGES

* **hooks:** hook exit codes changed ([#880](https://github.com/sinameraji/autopilot/issues/880)). Only **exit code 2** blocks a tool call or prompt; stderr becomes the reason. Any other non-zero exit, a timeout or a hook that can't start (e.g. missing binary) is now logged and the call is **allowed**. Before 1.29.0, any failure blocked. A custom guard that blocks with `exit 1` silently stops blocking after you upgrade. **Migration:** change it to `echo "reason" >&2; exit 2`, or print `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"…"}}` and exit 0. The bundled recommended hooks are upgraded automatically. See [Blocking and exit codes](https://github.com/sinameraji/autopilot#blocking-and-exit-codes).


### Features

* **hooks:** Beacon-compatible tool names, result shapes, Stop reply and OTel harness name ([#881](https://github.com/sinameraji/autopilot/issues/881)) ([dfdd4e7](https://github.com/sinameraji/autopilot/commit/dfdd4e78daba27ab668fa1e23c08a1406b99e39e))


### Bug Fixes

* **hooks:** fail open on hook errors, honour JSON decisions, send payload on stdin ([#880](https://github.com/sinameraji/autopilot/issues/880)) ([29ad789](https://github.com/sinameraji/autopilot/commit/29ad789b916669e6aa0cb6fd2eb37a9d54a0ea15))
* **hooks:** fire SessionEnd and flush OTel on every exit path ([#883](https://github.com/sinameraji/autopilot/issues/883)) ([c8cf36a](https://github.com/sinameraji/autopilot/commit/c8cf36ad1ac2e373364a57aaaaeb660d5f524bb0))
* **server:** refuse cross-origin and DNS-rebinding requests to the local API ([#878](https://github.com/sinameraji/autopilot/issues/878)) ([89e97c5](https://github.com/sinameraji/autopilot/commit/89e97c5956ba4e5e0cb9472f2a77c0ee2ddc6d83))

## [1.28.0](https://github.com/sinameraji/autopilot/compare/v1.27.1...v1.28.0) (2026-10-20)


### Features

* **hooks:** Agent Beacon support — Claude-Code-compatible hooks, session lifecycle, OTel GenAI events ([#875](https://github.com/sinameraji/autopilot/issues/875)) ([6f4706e](https://github.com/sinameraji/autopilot/commit/6f4706e663fe4e159346737d3ed1d14e88a7784a))


### Bug Fixes

* **edit:** accept edits[] when the model also sends empty old_string/new_string ([#873](https://github.com/sinameraji/autopilot/issues/873)) ([7d96b12](https://github.com/sinameraji/autopilot/commit/7d96b12b96216fbcebe4b1aaa0704d191855efbf))
* **subagents:** stop announcing the default auto policy every turn ([#872](https://github.com/sinameraji/autopilot/issues/872)) ([b1126ff](https://github.com/sinameraji/autopilot/commit/b1126ff1ab0285b27b7dde31c9203f69c894a49f))

## [1.27.1](https://github.com/sinameraji/autopilot/compare/v1.27.0...v1.27.1) (2026-10-20)


### Bug Fixes

* **camouflage:** the verified [#862](https://github.com/sinameraji/autopilot/issues/862) fixes that [#867](https://github.com/sinameraji/autopilot/issues/867) lost ([#870](https://github.com/sinameraji/autopilot/issues/870)) ([1854db8](https://github.com/sinameraji/autopilot/commit/1854db8700186125e52e4aa035c8e9e6423bd1ae))
* **deps:** require camouflage-tui 2.8.1 ([#868](https://github.com/sinameraji/autopilot/issues/868)) ([7cbeb5e](https://github.com/sinameraji/autopilot/commit/7cbeb5e426c9eea69322a18723721c2d75200243))

## [1.27.0](https://github.com/sinameraji/autopilot/compare/v1.26.0...v1.27.0) (2026-10-20)


### Features

* **client:** log request body size and split upload time from model latency ([#858](https://github.com/sinameraji/autopilot/issues/858)) ([bf30ed9](https://github.com/sinameraji/autopilot/commit/bf30ed97930d49c4faad06c20820cd51bf653671))
* **edit:** several replacements per edit call, applied atomically ([#859](https://github.com/sinameraji/autopilot/issues/859)) ([f530da7](https://github.com/sinameraji/autopilot/commit/f530da7112a671311b8c524c3bf3e0f93536e807))
* **images:** downscale and re-encode images when they're attached ([#855](https://github.com/sinameraji/autopilot/issues/855)) ([2f37a18](https://github.com/sinameraji/autopilot/commit/2f37a18c460e238a1b3a27b7491c6abc57f1e843))
* **providers:** /provider is a step-by-step picker, like /model and onboarding ([#857](https://github.com/sinameraji/autopilot/issues/857)) ([4fd188d](https://github.com/sinameraji/autopilot/commit/4fd188d4b2f6646b58034cfb2c5e937f23450fcc))
* **runs:** an unattended run whose turn outgrows the context pauses for a decision ([#860](https://github.com/sinameraji/autopilot/issues/860)) ([8f158c0](https://github.com/sinameraji/autopilot/commit/8f158c0dffce11cbfe50e95c290274c73ca3c433))
* **runs:** concurrency limit, operator kill switch, systemd unit and server guide ([#864](https://github.com/sinameraji/autopilot/issues/864)) ([6d1b623](https://github.com/sinameraji/autopilot/commit/6d1b623b1f582a057f540f8f470eef53246e568d))
* **runs:** decide a paused run by replying to its email ([#866](https://github.com/sinameraji/autopilot/issues/866)) ([7e65ce2](https://github.com/sinameraji/autopilot/commit/7e65ce2d628b5a88754af315d2581ce01e671c7d))
* **runs:** email the operator when an unattended run finishes, fails or needs input ([#863](https://github.com/sinameraji/autopilot/issues/863)) ([5766e6a](https://github.com/sinameraji/autopilot/commit/5766e6ac061594b38ea1b00f2fc7c640947d4d0c))


### Bug Fixes

* **deps:** camouflage-tui 2.8.0; drop the node_modules symlink committed in [#858](https://github.com/sinameraji/autopilot/issues/858) ([#861](https://github.com/sinameraji/autopilot/issues/861)) ([a085a28](https://github.com/sinameraji/autopilot/commit/a085a287b2d799dcde0684d75d08b243e66386d7))

## [1.26.0](https://github.com/sinameraji/autopilot/compare/v1.25.1...v1.26.0) (2026-10-20)


### Features

* **client:** per-provider request quirks and provider-aware errors ([#830](https://github.com/sinameraji/autopilot/issues/830)) ([da08d05](https://github.com/sinameraji/autopilot/commit/da08d05cb412ab0d6fda502d2fe1a00c37bddcc0))
* **cost:** final cost estimates for providers without cost confirmation ([#832](https://github.com/sinameraji/autopilot/issues/832)) ([07ceda9](https://github.com/sinameraji/autopilot/commit/07ceda948c4721f6563b655a010fa8e7fef5b600))
* land the stacked work from [#836](https://github.com/sinameraji/autopilot/issues/836)–[#851](https://github.com/sinameraji/autopilot/issues/851) onto main ([#854](https://github.com/sinameraji/autopilot/issues/854)) ([a4a4c37](https://github.com/sinameraji/autopilot/commit/a4a4c37c4901050e8e6bf5580e5ad52577afea11))
* **memory:** embeddings follow the active provider ([#828](https://github.com/sinameraji/autopilot/issues/828)) ([89c7154](https://github.com/sinameraji/autopilot/commit/89c7154c1f782874effb5419452d0c7cb4fe0486))
* **models:** catalogs for non-OpenRouter providers via models.dev ([#829](https://github.com/sinameraji/autopilot/issues/829)) ([ad9fa06](https://github.com/sinameraji/autopilot/commit/ad9fa062b26ae190e5f1b73e54f020a280a5294a))
* **onboarding:** choose a provider at first run; add /provider and per-provider keys ([#831](https://github.com/sinameraji/autopilot/issues/831)) ([3a98cd3](https://github.com/sinameraji/autopilot/commit/3a98cd3fda2e9e0a7a54ba2742dfb1cc7f7a468c))
* **providers:** add a provider registry that every LLM call follows ([#827](https://github.com/sinameraji/autopilot/issues/827)) ([e8c62f5](https://github.com/sinameraji/autopilot/commit/e8c62f514e8ea907d1908a1f479474ddd899e9fe))
* **providers:** name the active provider everywhere; update docs and ACP ([#833](https://github.com/sinameraji/autopilot/issues/833)) ([7f07946](https://github.com/sinameraji/autopilot/commit/7f07946df75c9a2e8f06caf2afbd7a233684ddde))
* **providers:** native Anthropic Messages adapter ([#835](https://github.com/sinameraji/autopilot/issues/835)) ([76a1507](https://github.com/sinameraji/autopilot/commit/76a1507d4f8dd1ed6516dd7a800f73d227f42645))


### Bug Fixes

* **server:** restore Aster API code accidentally reverted in [#777](https://github.com/sinameraji/autopilot/issues/777) ([#820](https://github.com/sinameraji/autopilot/issues/820)) ([c0fd310](https://github.com/sinameraji/autopilot/commit/c0fd31004a33df0353a8a1176d87f22cf3c7b1dc))

## [1.25.1](https://github.com/sinameraji/autopilot/compare/v1.25.0...v1.25.1) (2026-10-19)


### Bug Fixes

* **tools:** serialize same-file edits and actually load the isolated-vm sandbox ([#800](https://github.com/sinameraji/autopilot/issues/800)) ([aa3755f](https://github.com/sinameraji/autopilot/commit/aa3755f31fc2e68a69d6d6949b8354348ad6b749))
* **ui:** show checklists for multi-step tasks ([#798](https://github.com/sinameraji/autopilot/issues/798)) ([1fdb435](https://github.com/sinameraji/autopilot/commit/1fdb435611108c2ec8fdd576f96b162a3a3afa60))

## [1.25.0](https://github.com/sinameraji/autopilot/compare/v1.24.2...v1.25.0) (2026-10-18)


### Features

* add robust HTML artifact workflow ([#796](https://github.com/sinameraji/autopilot/issues/796)) ([943f03b](https://github.com/sinameraji/autopilot/commit/943f03bf45930c07adbf2c14acf76d318dbdab52))

## [1.24.2](https://github.com/sinameraji/autopilot/compare/v1.24.1...v1.24.2) (2026-10-18)


### Bug Fixes

* **ui:** resume draining queued prompts after turns ([#794](https://github.com/sinameraji/autopilot/issues/794)) ([8bce24f](https://github.com/sinameraji/autopilot/commit/8bce24fac3c549b99b5d4f46c33db2d52086398f))

## [1.24.1](https://github.com/sinameraji/autopilot/compare/v1.24.0...v1.24.1) (2026-10-18)


### Bug Fixes

* **release:** verify npm package availability ([#792](https://github.com/sinameraji/autopilot/issues/792)) ([589671f](https://github.com/sinameraji/autopilot/commit/589671ffebc23d8b1e4dd982b54f71fe51895a5a))

## [1.24.0](https://github.com/sinameraji/autopilot/compare/v1.23.0...v1.24.0) (2026-10-18)


### Features

* bundle runtime dependencies for offline installers ([#790](https://github.com/sinameraji/autopilot/issues/790)) ([729589c](https://github.com/sinameraji/autopilot/commit/729589ca5dc5cc5b9cee7f423d639468f4768b9a))

## [1.23.0](https://github.com/sinameraji/autopilot/compare/v1.22.2...v1.23.0) (2026-10-17)


### Features

* show session topic in terminal title ([#783](https://github.com/sinameraji/autopilot/issues/783)) ([3693271](https://github.com/sinameraji/autopilot/commit/3693271501e37a1527b8183042e9082ed9948b96))


### Bug Fixes

* **deps:** require camouflage-tui 2.6.1 ([#788](https://github.com/sinameraji/autopilot/issues/788)) ([dbdf6db](https://github.com/sinameraji/autopilot/commit/dbdf6db976d6951021ad71cece91d0a49bc300ee))
* shorten subagent activity summaries ([#787](https://github.com/sinameraji/autopilot/issues/787)) ([b945779](https://github.com/sinameraji/autopilot/commit/b9457791a38ec7e592aee6a0a232015116b419ea))
* **subagents:** start hotcell non-interactively ([#786](https://github.com/sinameraji/autopilot/issues/786)) ([abf82fa](https://github.com/sinameraji/autopilot/commit/abf82faa8cfbb074b9d97274d226d5076e497c2d))

## [1.22.2](https://github.com/sinameraji/autopilot/compare/v1.22.1...v1.22.2) (2026-10-17)


### Bug Fixes

* resolve npm audit vulnerabilities ([#781](https://github.com/sinameraji/autopilot/issues/781)) ([ba30dc2](https://github.com/sinameraji/autopilot/commit/ba30dc21c5705ed710fba64b8770f4014b3d3bd6))

## [1.22.1](https://github.com/sinameraji/autopilot/compare/v1.22.0...v1.22.1) (2026-10-17)


### Bug Fixes

* use stable Camouflage release in Autopilot ([#779](https://github.com/sinameraji/autopilot/issues/779)) ([9d9e73e](https://github.com/sinameraji/autopilot/commit/9d9e73e399548f2a10746e0098374b9638aad27b))

## [1.22.0](https://github.com/sinameraji/autopilot/compare/v1.21.0...v1.22.0) (2026-10-12)


### Features

* disable inline subagent notices (compact region handles them) ([#777](https://github.com/sinameraji/autopilot/issues/777)) ([375fe81](https://github.com/sinameraji/autopilot/commit/375fe81d1903a8fe4fdca82c00709bb1f0579867))

## [1.21.0](https://github.com/sinameraji/autopilot/compare/v1.20.1...v1.21.0) (2026-10-11)


### Features

* **aster:** stream progress events ([#773](https://github.com/sinameraji/autopilot/issues/773)) ([6884196](https://github.com/sinameraji/autopilot/commit/68841963f7d7a55243bff6798b2aea293b77d0ba))
* **eval:** headless task runner, autopilot-bench seed set, paired compare ([#774](https://github.com/sinameraji/autopilot/issues/774)) ([d7c04a4](https://github.com/sinameraji/autopilot/commit/d7c04a4e5d834728bedebea7cc8feb7b14b9705c))

## [1.20.1](https://github.com/sinameraji/autopilot/compare/v1.20.0...v1.20.1) (2026-10-11)


### Bug Fixes

* **session:** give interrupted tool calls a (stopped) result before saving ([#771](https://github.com/sinameraji/autopilot/issues/771)) ([cda8b9e](https://github.com/sinameraji/autopilot/commit/cda8b9e699eed3babf24ee09e12c83cc1e6c7e6f))

## [1.20.0](https://github.com/sinameraji/autopilot/compare/v1.19.3...v1.20.0) (2026-10-11)


### Features

* **trace:** append-only session trace recorder and blob store ([#767](https://github.com/sinameraji/autopilot/issues/767)) ([bd8ca3a](https://github.com/sinameraji/autopilot/commit/bd8ca3a089e81a215cda7a3769b598d110790ec3))
* **trace:** outcome signals (git delta, verification, ratings, corrections) ([#770](https://github.com/sinameraji/autopilot/issues/770)) ([b5a008d](https://github.com/sinameraji/autopilot/commit/b5a008d98b097cae7a5a476cebd4f8f85be6e8b5))
* **trace:** record requests, responses, tool calls, permissions, turn ends ([#769](https://github.com/sinameraji/autopilot/issues/769)) ([5bc3e1d](https://github.com/sinameraji/autopilot/commit/5bc3e1d12991c98de004f3c43c6914297aee1934))

## [1.19.3](https://github.com/sinameraji/autopilot/compare/v1.19.2...v1.19.3) (2026-10-07)


### Bug Fixes

* **aster:** migrate existing Hotcell runtime bundles ([710e5d5](https://github.com/sinameraji/autopilot/commit/710e5d514b7f0aa462c4d4e1784ab73e055b95de))

## [1.19.2](https://github.com/sinameraji/autopilot/compare/v1.19.1...v1.19.2) (2026-10-06)


### Bug Fixes

* **aster:** chunk large Hotcell control payloads ([6125fe3](https://github.com/sinameraji/autopilot/commit/6125fe3691c2ffaf29d46a41620eb50838ae22ce))
* **aster:** chunk large Hotcell control payloads ([0cdb9f3](https://github.com/sinameraji/autopilot/commit/0cdb9f307c6ca3aac2ffced34e641acb55298207))

## [1.19.1](https://github.com/sinameraji/autopilot/compare/v1.19.0...v1.19.1) (2026-10-06)


### Bug Fixes

* **aster:** accept long messages (up to 500k characters) ([83005c7](https://github.com/sinameraji/autopilot/commit/83005c7c703ca377cdcdeda56f53162f4cffcdeb))
* keep Jev output visible in the TUI ([d112432](https://github.com/sinameraji/autopilot/commit/d112432e2e68cd05c46548203503aa550002ac8f))
* keep Jev output visible in the TUI ([8f99329](https://github.com/sinameraji/autopilot/commit/8f993299d8371e3924e87fcd15b23087d4012d93))
* **ui:** reduce agent activity noise ([1a94b53](https://github.com/sinameraji/autopilot/commit/1a94b5363ef347e3104e62bbf7d153bcf19946e8))
* **ui:** reduce agent activity noise ([0bb8281](https://github.com/sinameraji/autopilot/commit/0bb8281aa48c9259eb6839b80ee71d4451ffa615))

## [1.19.0](https://github.com/sinameraji/autopilot/compare/v1.18.0...v1.19.0) (2026-10-06)


### Features

* **agent:** use Jev for the end-of-turn finish check and auto delegation ([811bc2d](https://github.com/sinameraji/autopilot/commit/811bc2d6a85e3c4f768003ef1875946eb0baa6e2))
* **agent:** use Jev for the end-of-turn finish check and auto delegation ([270c160](https://github.com/sinameraji/autopilot/commit/270c16006572097f19ed5e967b840293c36edfc6))


### Bug Fixes

* **subagents:** stream the working tree in so private repos work ([59b773c](https://github.com/sinameraji/autopilot/commit/59b773c6abf5e8fdb11d817d7781caa989bc67f6))
* **subagents:** stream the working tree in so private repos work ([8a0d836](https://github.com/sinameraji/autopilot/commit/8a0d836a1661958abf0936f9a90d4d802fbfe2e7))

## [1.18.0](https://github.com/sinameraji/autopilot/compare/v1.17.0...v1.18.0) (2026-10-04)


### Features

* **subagents:** record usage locally and add /subagents stats ([34f6734](https://github.com/sinameraji/autopilot/commit/34f67346f9dc47d62ac6d25b2415739fec8eedfb))
* **subagents:** record usage locally and add /subagents stats ([baa9a44](https://github.com/sinameraji/autopilot/commit/baa9a44e2f97eef3c798ed37f13e76a771457b90))

## [1.17.0](https://github.com/sinameraji/autopilot/compare/v1.16.0...v1.17.0) (2026-10-04)


### Features

* **subagents:** see uncommitted work and start in seconds ([dc0d894](https://github.com/sinameraji/autopilot/commit/dc0d89483adcf38a8374b21623953e7fe895503d))
* **subagents:** see uncommitted work and start in seconds ([fd2b893](https://github.com/sinameraji/autopilot/commit/fd2b893ebdb302c782b676c5452481c34f89a836))

## [1.16.0](https://github.com/sinameraji/autopilot/compare/v1.15.0...v1.16.0) (2026-10-04)


### Features

* **server:** bind each Aster conversation to its own Hotcell microVM ([276a77d](https://github.com/sinameraji/autopilot/commit/276a77d7f5718688c13a9ab4160fb287d3123783))
* **server:** bind each Aster conversation to its own Hotcell microVM ([e5bc8b7](https://github.com/sinameraji/autopilot/commit/e5bc8b76597d7f16d301e4501fb7ad6b0a022d69))
* **subagents:** make subagents reachable and visible ([a681518](https://github.com/sinameraji/autopilot/commit/a68151858bd91b95eb1164ddc169b2e82e3812da))
* **subagents:** make subagents reachable and visible ([ceedc8d](https://github.com/sinameraji/autopilot/commit/ceedc8da803fac205524bd9c0773a0a2911a0b2b))


### Bug Fixes

* **subagents:** install the full worker CLI and lazy-load resvg ([0d86532](https://github.com/sinameraji/autopilot/commit/0d865321e9fbd806236d31989e43b5688af2ea93))

## [1.15.0](https://github.com/sinameraji/autopilot/compare/v1.14.0...v1.15.0) (2026-10-04)


### Features

* **subagents:** list and cancel individual running subagents ([e8683ae](https://github.com/sinameraji/autopilot/commit/e8683aed2f5c91ba453af6fec459cc55d58c682a))
* **subagents:** list and cancel individual running subagents ([a7cc80c](https://github.com/sinameraji/autopilot/commit/a7cc80c66d89d63d83e7711fe022386957d0129a))
* **tui:** triage messages sent while the agent is working ([ba79e4c](https://github.com/sinameraji/autopilot/commit/ba79e4c55e2bddf5125e78b212281ed7bf773d8a))
* **tui:** triage messages sent while the agent is working ([b2ba597](https://github.com/sinameraji/autopilot/commit/b2ba597820352e2d455b555f1c521bf2882dc496)), closes [#725](https://github.com/sinameraji/autopilot/issues/725)

## [1.14.0](https://github.com/sinameraji/autopilot/compare/v1.13.0...v1.14.0) (2026-10-04)


### Features

* **agent:** run parallel subagent calls concurrently with one approval ([56e7226](https://github.com/sinameraji/autopilot/commit/56e7226fc085bbc4fa64a6e3aedbaf2f0777cebf))
* **agent:** run parallel subagent calls concurrently with one approval ([29deb87](https://github.com/sinameraji/autopilot/commit/29deb873ddaa76d5f83266f383507689e3ed5fbe)), closes [#723](https://github.com/sinameraji/autopilot/issues/723)
* **worker:** size research budgets from spend cap and return structured findings ([7660837](https://github.com/sinameraji/autopilot/commit/76608378e3d8b65f80b149fbaac7d490ccc5edfe))
* **worker:** size research budgets from spend cap and return structured findings ([500eb16](https://github.com/sinameraji/autopilot/commit/500eb16f3c9951a7b5031d00b7a47c90dffe996e)), closes [#727](https://github.com/sinameraji/autopilot/issues/727)


### Bug Fixes

* **agent:** compact history against the model budget in every host ([2febee7](https://github.com/sinameraji/autopilot/commit/2febee74c9e6794b214ed8862fc4ad4458958f88))
* **agent:** compact history against the model budget in every host ([aec5164](https://github.com/sinameraji/autopilot/commit/aec5164ddf9ad21606d28c3e050a0b2c05359fab)), closes [#717](https://github.com/sinameraji/autopilot/issues/717)
* **agent:** send the subagent directive per request, never persist it ([6e094a8](https://github.com/sinameraji/autopilot/commit/6e094a8313e1e5fa84b260497b7954e1e42c798a))
* **agent:** send the subagent directive per request, never persist it ([773797d](https://github.com/sinameraji/autopilot/commit/773797de7d6ae84d6e49aad14629331f3e8750ca)), closes [#724](https://github.com/sinameraji/autopilot/issues/724)
* **bash:** keep co-author values out of generated shell source ([b43c6ba](https://github.com/sinameraji/autopilot/commit/b43c6ba54c4e241a9c976444a361ed1e555f0e7c))
* **bash:** keep co-author values out of generated shell source ([d622192](https://github.com/sinameraji/autopilot/commit/d6221921e62634272246cf3cca6fb40b39221089)), closes [#716](https://github.com/sinameraji/autopilot/issues/716)
* quiet repeated-call guardrails ([ead1b0a](https://github.com/sinameraji/autopilot/commit/ead1b0a89a2c403d2b57da182dcc70b02b9b57d2))
* reduce noisy loop guardrail feedback ([8552596](https://github.com/sinameraji/autopilot/commit/8552596a14414b75014e603c47f040322ac126e1))
* **sdk:** persist errored turns, deliver late steers, run follow-ups ([c40aa89](https://github.com/sinameraji/autopilot/commit/c40aa899653561491b6eeadb0f337274b9fa2de4))
* **sdk:** persist errored turns, deliver late steers, run follow-ups ([0aafe3f](https://github.com/sinameraji/autopilot/commit/0aafe3f38067a299bc2ab2b71d2b93ad9793be29)), closes [#637](https://github.com/sinameraji/autopilot/issues/637) [#725](https://github.com/sinameraji/autopilot/issues/725)
* **ui:** keep spinner animation in sync with elapsed time ([da36f53](https://github.com/sinameraji/autopilot/commit/da36f53f9b9bf90c5c0303b266219d8af053c7de))
* **ui:** keep spinner animation in sync with elapsed time ([bcb59ca](https://github.com/sinameraji/autopilot/commit/bcb59ca06dec691d36fe5f65cc2f61f1cc9ca113))
* **worker:** run the pinned Autopilot CLI in Hotcell cells ([7cff17a](https://github.com/sinameraji/autopilot/commit/7cff17a5ea0fdea25b4b765c2bf6c53acf55d8e3))
* **worker:** run the pinned Autopilot CLI in Hotcell cells ([0d4ce96](https://github.com/sinameraji/autopilot/commit/0d4ce961948cf73323a7cb382ae5912ac8ace7f5)), closes [#722](https://github.com/sinameraji/autopilot/issues/722)

## [1.13.0](https://github.com/sinameraji/autopilot/compare/v1.12.2...v1.13.0) (2026-10-03)


### Features

* **subagents:** use local Hotcell workers only ([bec8486](https://github.com/sinameraji/autopilot/commit/bec848677b9e1f772b4baea8d6609a52c334be19))
* **subagents:** use local Hotcell workers only ([c6f2da2](https://github.com/sinameraji/autopilot/commit/c6f2da2dc82e4bc426aa6b2434c8c9bedc7fb87b))


### Bug Fixes

* **agent:** preserve complete turns during compaction ([bdd3233](https://github.com/sinameraji/autopilot/commit/bdd32336c4f3fe1c49a5c3eef2f8f6c3f3bcc70c))
* **agent:** preserve complete turns during compaction ([29011cd](https://github.com/sinameraji/autopilot/commit/29011cd8508cddbe18b195975442101b15e69f2d))

## [1.12.2](https://github.com/sinameraji/autopilot/compare/v1.12.1...v1.12.2) (2026-10-03)


### Bug Fixes

* **agent:** provide actionable blocker handoffs ([d0d6f3f](https://github.com/sinameraji/autopilot/commit/d0d6f3fcf17b2476d1118baa0b9eec52e93ea09c))
* **agent:** provide actionable blocker handoffs ([6052531](https://github.com/sinameraji/autopilot/commit/6052531823e19aa2baf9650756b36c1507773b60))

## [1.12.1](https://github.com/sinameraji/autopilot/compare/v1.12.0...v1.12.1) (2026-10-03)


### Bug Fixes

* **ui:** deduplicate Camouflage events ([798161e](https://github.com/sinameraji/autopilot/commit/798161e7d4ce5d41c3fa175c38de0a26b9436d83))
* **ui:** deduplicate Camouflage UI events ([8e21e7f](https://github.com/sinameraji/autopilot/commit/8e21e7f1b7052cf8d8658e1c0def43164d0e7a2a))

## [1.12.0](https://github.com/sinameraji/autopilot/compare/v1.11.0...v1.12.0) (2026-10-03)


### Features

* **ui:** browse background jobs and agents ([944da72](https://github.com/sinameraji/autopilot/commit/944da726c8472da95f877fa58c22cce35dbfd187))
* **ui:** browse background jobs and agents ([04da3dd](https://github.com/sinameraji/autopilot/commit/04da3dda9b857a2ef934cfcf879c57cf3a63b083))


### Bug Fixes

* **ui:** edit the latest submitted prompt ([e9d4f79](https://github.com/sinameraji/autopilot/commit/e9d4f79d587b8f2d3591862ab811ee5a8e626e5e))
* **ui:** edit the latest submitted prompt ([8238d7d](https://github.com/sinameraji/autopilot/commit/8238d7d85eded65cac2e533e746e2bb6d6fcd29b))

## [1.11.0](https://github.com/sinameraji/autopilot/compare/v1.10.1...v1.11.0) (2026-10-01)


### Features

* **runs:** support long-running unattended tasks ([ea88965](https://github.com/sinameraji/autopilot/commit/ea889657d245833de01c08779f330e898a77ba7e))
* **runs:** support long-running unattended tasks ([4c903de](https://github.com/sinameraji/autopilot/commit/4c903de4e43f3a45b243ab83af6493c2c3b5922f))

## [1.10.1](https://github.com/sinameraji/autopilot/compare/v1.10.0...v1.10.1) (2026-10-01)


### Bug Fixes

* **ui:** ! commands get the real terminal under Camouflage ([69f33f1](https://github.com/sinameraji/autopilot/commit/69f33f1fbb35439d1e3b2da4a2d920bc747a72b1))
* **ui:** ! commands get the real terminal under Camouflage ([08831b4](https://github.com/sinameraji/autopilot/commit/08831b4d7d0d69504e493b991d170278d6b1a6a6))

## [1.10.0](https://github.com/sinameraji/autopilot/compare/v1.9.0...v1.10.0) (2026-10-01)


### Features

* **server:** add Aster control plane API ([eb99aa0](https://github.com/sinameraji/autopilot/commit/eb99aa0c3e59191ab72149a963940acba3366542))
* **server:** support legacy and idempotent Aster turns ([0f0641c](https://github.com/sinameraji/autopilot/commit/0f0641cf4dc0b00dfa8687ec3cdf526b95e28996))
* **server:** support legacy and idempotent Aster turns ([2a020bf](https://github.com/sinameraji/autopilot/commit/2a020bf57f964579a94e4348d23ddbb20c444ded))

## [1.9.0](https://github.com/sinameraji/autopilot/compare/v1.8.0...v1.9.0) (2026-10-01)


### Features

* **init:** generate AGENTS.md project context ([8d147ab](https://github.com/sinameraji/autopilot/commit/8d147ab95d8c5cd6dbc4ded8c588173a7cc7d4a4))
* **init:** generate AGENTS.md project context ([ed784d2](https://github.com/sinameraji/autopilot/commit/ed784d2357ebd73e79035a88a716a05c40409a40))

## [1.8.0](https://github.com/sinameraji/autopilot/compare/v1.7.1...v1.8.0) (2026-10-01)


### Features

* **agent:** delegate useful parallel work by default ([b7e0ddd](https://github.com/sinameraji/autopilot/commit/b7e0dddc88540a446af8d99c6541ef20ec08eaa5))
* **agent:** delegate useful parallel work by default ([18f75ba](https://github.com/sinameraji/autopilot/commit/18f75babba4b1389e207348b8bebee813bf31f9b))
* **ui:** Camouflage is the default UI for everyone ([897dd8f](https://github.com/sinameraji/autopilot/commit/897dd8f46a1d6025735d03167e89dc90d6529548))
* **ui:** Camouflage is the default UI for everyone ([736b49f](https://github.com/sinameraji/autopilot/commit/736b49f302f0b2abd2c8271479051e1dfcc97846))

## [1.7.1](https://github.com/sinameraji/autopilot/compare/v1.7.0...v1.7.1) (2026-10-01)


### Bug Fixes

* **ui:** no mode badge in the Camouflage footer when modes are off ([0740150](https://github.com/sinameraji/autopilot/commit/0740150507766f32ef35df0dd885b20f21f369ac))
* **ui:** no mode badge in the Camouflage footer when modes are off ([68d6d00](https://github.com/sinameraji/autopilot/commit/68d6d008fcb0a3aaaa18e109ba0b10bc173ba875))

## [1.7.0](https://github.com/sinameraji/autopilot/compare/v1.6.0...v1.7.0) (2026-10-01)


### Features

* **ui:** settings dialogs and editors in the Camouflage UI ([631d69e](https://github.com/sinameraji/autopilot/commit/631d69edf899a693824ab63ab0320bab4bbb602a))

## [1.6.0](https://github.com/sinameraji/autopilot/compare/v1.5.0...v1.6.0) (2026-10-01)


### Features

* **runs:** add isolated worktree manager ([37382b7](https://github.com/sinameraji/autopilot/commit/37382b781c3e91558d853a111aab6ec2e0c1a28d))
* **runs:** add isolated worktree manager ([6909ebd](https://github.com/sinameraji/autopilot/commit/6909ebd64217c173aa3d5b1e799f5649c2554e50))
* **runs:** enforce token and cost budgets ([4b82b0c](https://github.com/sinameraji/autopilot/commit/4b82b0c1b6c4a523f41ea425f44a0c5ebad78905))
* **runs:** enforce token and cost budgets ([cd3b416](https://github.com/sinameraji/autopilot/commit/cd3b4168f8562614273ab1d0533b4acf3d10a112))
* **server:** isolate unattended runs in worktrees ([9763143](https://github.com/sinameraji/autopilot/commit/9763143d98b1a250ffd18bd8d21e57d281d39745))
* **server:** isolate unattended runs in worktrees ([02638ee](https://github.com/sinameraji/autopilot/commit/02638ee136d0e3e7397d276b7d5607b05ead2fa9))
* **ui:** browse folders from @ in the Camouflage UI ([4694bef](https://github.com/sinameraji/autopilot/commit/4694befa11b110b26c1b60c1748fc3170fca2afa))
* **ui:** Ink-quality model and resume pickers in the Camouflage UI, plus /ui ([4154107](https://github.com/sinameraji/autopilot/commit/4154107cff79d803134f65ee9430ec60d5c93ddd))
* **ui:** Ink-quality pickers and dialogs in the Camouflage UI ([0ab0384](https://github.com/sinameraji/autopilot/commit/0ab0384e70aef73285aa0cec6e31367f5baff120))
* **ui:** run the full App in the Camouflage UI for slash-command parity ([7413582](https://github.com/sinameraji/autopilot/commit/741358287c34e1bcf8b8f8074f196d1d662089ad))
* **ui:** run the full App in the Camouflage UI for slash-command parity ([0bb1a4b](https://github.com/sinameraji/autopilot/commit/0bb1a4b28a6a14cc29a244d492d0f19876831d0a))
* **ui:** theme, shell, help, memory, skills and command dialogs in Camouflage ([812d392](https://github.com/sinameraji/autopilot/commit/812d3923ed7164f00aa8f4e52e7866ff42c49e7d))

## [1.5.0](https://github.com/sinameraji/autopilot/compare/v1.4.0...v1.5.0) (2026-10-01)


### Features

* **jobs:** add durable managed background jobs ([#673](https://github.com/sinameraji/autopilot/issues/673)) ([2085302](https://github.com/sinameraji/autopilot/commit/2085302812dfec5efdb58ed4b7542d968a669cac))
* **requesty:** land gateway changes from [#655](https://github.com/sinameraji/autopilot/issues/655) ([80a8af9](https://github.com/sinameraji/autopilot/commit/80a8af9691a8ae361407bb84f6ba737ac1875404))
* **server:** add authenticated durable run APIs ([#681](https://github.com/sinameraji/autopilot/issues/681)) ([4f652eb](https://github.com/sinameraji/autopilot/commit/4f652eb2654006b4ad85d04a55d46735fe00503f))
* **ui:** bring back --ui camouflage on the new inline renderer ([#672](https://github.com/sinameraji/autopilot/issues/672)) ([b02b31d](https://github.com/sinameraji/autopilot/commit/b02b31d5ecebc7d7a59345e35b48694e2a2d6f0e))
* update autopilot logo ([#679](https://github.com/sinameraji/autopilot/issues/679)) ([268a630](https://github.com/sinameraji/autopilot/commit/268a6309d51ad6aa4f81f611a5af3513b51ce7c6))


### Bug Fixes

* rename default co-author to autopilot ([#680](https://github.com/sinameraji/autopilot/issues/680)) ([65a920a](https://github.com/sinameraji/autopilot/commit/65a920aa811a1bdd9506a05d6694aa10c95d8430))
* **requesty:** cover code paths added on main since [#655](https://github.com/sinameraji/autopilot/issues/655) branched ([d95dca4](https://github.com/sinameraji/autopilot/commit/d95dca4ed5df1a014b3133192e429286f093a009))
* **ui:** restore input after ! commands ([#675](https://github.com/sinameraji/autopilot/issues/675)) ([1fdb155](https://github.com/sinameraji/autopilot/commit/1fdb155111a9f3813c78d75796d7c02d7162da16))

## [1.4.0](https://github.com/sinameraji/autopilot/compare/v1.3.0...v1.4.0) (2026-09-29)


### Features

* **ui:** coordinate queued follow-ups ([#669](https://github.com/sinameraji/autopilot/issues/669)) ([275ab3a](https://github.com/sinameraji/autopilot/commit/275ab3aae13b9b963ffe124b65f25ba5644d7ce8))

## [1.3.0](https://github.com/sinameraji/autopilot/compare/v1.2.2...v1.3.0) (2026-09-29)


### Features

* **agent:** add effort-aware subagent routing ([#664](https://github.com/sinameraji/autopilot/issues/664)) ([72bcb2c](https://github.com/sinameraji/autopilot/commit/72bcb2c9f5487a123603d8c9c1762f45e3435b29))
* **ui:** add `!` shell commands and teach the agent when to suggest them ([#665](https://github.com/sinameraji/autopilot/issues/665)) ([6c57ab7](https://github.com/sinameraji/autopilot/commit/6c57ab758ccd36f0e2f598bf40f7c7815d1cdcdf))
* **worker:** add opt-in Hotcell research backend ([#659](https://github.com/sinameraji/autopilot/issues/659)) ([5e520a3](https://github.com/sinameraji/autopilot/commit/5e520a39f83b2be02ec55f0c1b5d77a56f3a7bf0))

## [1.2.2](https://github.com/sinameraji/autopilot/compare/v1.2.1...v1.2.2) (2026-09-29)


### Bug Fixes

* **agent:** never pause unattended runs on loop or iteration-cap guardrails ([#661](https://github.com/sinameraji/autopilot/issues/661)) ([db94c23](https://github.com/sinameraji/autopilot/commit/db94c232ddf300c64d0e148bd412702ab921867c))


### Performance Improvements

* **ui:** stop idle sessions from burning CPU ([#663](https://github.com/sinameraji/autopilot/issues/663)) ([654c6f2](https://github.com/sinameraji/autopilot/commit/654c6f27330f96028de2bb3698a12ce91a41dc68))

## [1.2.1](https://github.com/sinameraji/autopilot/compare/v1.2.0...v1.2.1) (2026-09-26)


### Bug Fixes

* **ui:** drop "(formerly kimiflare)" from chat label ([#656](https://github.com/sinameraji/autopilot/issues/656)) ([3ca908a](https://github.com/sinameraji/autopilot/commit/3ca908a30f33ef58535ad71bdeafaf9b4f7dd090))

## [1.2.0](https://github.com/sinameraji/autopilot/compare/v1.1.0...v1.2.0) (2026-09-25)


### Features

* **docs:** redesign site for Autopilot ([#651](https://github.com/sinameraji/autopilot/issues/651)) ([62f7388](https://github.com/sinameraji/autopilot/commit/62f738837cf1974ca39ac1e60e715a72c7e0b754))
* **jev:** provide scoped context and disclose request data ([#653](https://github.com/sinameraji/autopilot/issues/653)) ([b6cd366](https://github.com/sinameraji/autopilot/commit/b6cd3661b0d8c19dbd379e08bd654e7bea652ae6))

## [1.1.0](https://github.com/sinameraji/autopilot/compare/v1.0.0...v1.1.0) (2026-09-25)


### Features

* **file-picker:** support parent and home navigation ([#650](https://github.com/sinameraji/autopilot/issues/650)) ([ebe133d](https://github.com/sinameraji/autopilot/commit/ebe133db33c5de7d71730b544e873423daf1bc50))
* **jev:** add one-shot decisions command ([#649](https://github.com/sinameraji/autopilot/issues/649)) ([579a1d0](https://github.com/sinameraji/autopilot/commit/579a1d091866019f235f3aba6e345da9933eee3d))
* sign in with OpenRouter (OAuth PKCE) — no API key to copy ([#645](https://github.com/sinameraji/autopilot/issues/645)) ([48ecc2e](https://github.com/sinameraji/autopilot/commit/48ecc2ee321433a54e6f10a7b045451637bc83cd))
* **ui:** clarify model switch timing ([#648](https://github.com/sinameraji/autopilot/issues/648)) ([376bf3e](https://github.com/sinameraji/autopilot/commit/376bf3e7a46d2c59d63101748e4459a251647926))

## [1.0.0](https://github.com/sinameraji/autopilot/compare/v0.99.0...v1.0.0) (2026-09-25)


### ⚠ BREAKING CHANGES

* publish as `autopilot-ai` (command: `autopilot`); the final `kimiflare` release forwards to it
* replace Cloudflare with OpenRouter as the sole model provider (bring your own OpenRouter key)

### Features

* /key and `autopilot auth openrouter` for managing the OpenRouter key; onboarding validates the key before saving ([e9293df](https://github.com/sinameraji/autopilot/commit/e9293dfd4131d61a34408cc70d2238e8b65a9823))
* `cost --verify` checks recorded tokens and cost against OpenRouter's billing records; per-turn billed cost in the status bar ([e9293df](https://github.com/sinameraji/autopilot/commit/e9293dfd4131d61a34408cc70d2238e8b65a9823))
* model picker opens on the best & latest models (ranked by live benchmarks) with fuzzy search over the full OpenRouter catalog ([e9293df](https://github.com/sinameraji/autopilot/commit/e9293dfd4131d61a34408cc70d2238e8b65a9823))
* plan/edit/auto modes behind a feature flag (off by default); /settings to turn them on ([e9293df](https://github.com/sinameraji/autopilot/commit/e9293dfd4131d61a34408cc70d2238e8b65a9823))
* publish as `autopilot-ai` (command: `autopilot`); the final `kimiflare` release forwards to it ([adcedc8](https://github.com/sinameraji/autopilot/commit/adcedc8d5022ed79435d002d7c29b8a42d99c662))
* replace Cloudflare with OpenRouter as the sole model provider (bring your own OpenRouter key) ([e9293df](https://github.com/sinameraji/autopilot/commit/e9293dfd4131d61a34408cc70d2238e8b65a9823))
* show the app as "autopilot (formerly kimiflare)" and drop the logo artwork ([e9293df](https://github.com/sinameraji/autopilot/commit/e9293dfd4131d61a34408cc70d2238e8b65a9823))


### Bug Fixes

* fast typing no longer drops characters in the model and resume pickers ([e9293df](https://github.com/sinameraji/autopilot/commit/e9293dfd4131d61a34408cc70d2238e8b65a9823))
* only send request parameters each model supports (no-endpoint 404s) ([e9293df](https://github.com/sinameraji/autopilot/commit/e9293dfd4131d61a34408cc70d2238e8b65a9823))

## [0.99.0](https://github.com/sinameraji/kimiflare/compare/v0.98.1...v0.99.0) (2026-08-20)


### Features

* custom OpenAI-compatible gateway endpoint (KIMIFLARE_BASE_URL / KIMIFLARE_API_KEY) ([#635](https://github.com/sinameraji/kimiflare/issues/635)) ([ba9ff81](https://github.com/sinameraji/kimiflare/commit/ba9ff81140de22e3692fc060202b8e6af61e813b))

## [0.98.1](https://github.com/sinameraji/kimiflare/compare/v0.98.0...v0.98.1) (2026-08-20)


### Bug Fixes

* **sdk:** non-blocking RPC loop, settle blocked turns on abort, session resume ([#633](https://github.com/sinameraji/kimiflare/issues/633)) ([1bad5ad](https://github.com/sinameraji/kimiflare/commit/1bad5ad224eb4d073ce9cef03b627dc991f32b0d))

## [0.98.0](https://github.com/sinameraji/kimiflare/compare/v0.97.0...v0.98.0) (2026-08-19)


### Features

* **onboarding:** Log in with Cloudflare, hide KimiFlare Cloud, fix Kimi K3 routing ([#630](https://github.com/sinameraji/kimiflare/issues/630)) ([9b62351](https://github.com/sinameraji/kimiflare/commit/9b62351ae01805a8a2d3a83937d2e8079868b5ba))

## [0.97.0](https://github.com/sinameraji/kimiflare/compare/v0.96.1...v0.97.0) (2026-07-17)


### Features

* **demos:** add VHS terminal recordings for marketing ([#627](https://github.com/sinameraji/kimiflare/issues/627)) ([cc2a76f](https://github.com/sinameraji/kimiflare/commit/cc2a76fdcf83c4fba459ada817a39aabde833134))
* **models:** add Moonshot Kimi K3 support as AI Gateway BYOK provider ([#629](https://github.com/sinameraji/kimiflare/issues/629)) ([757bc7d](https://github.com/sinameraji/kimiflare/commit/757bc7d3565bb2b75fb9189f2ebad771764837d9))

## [0.96.1](https://github.com/sinameraji/kimiflare/compare/v0.96.0...v0.96.1) (2026-07-11)


### Bug Fixes

* **plan-mode:** defer fresh start until execution mode is picked ([#625](https://github.com/sinameraji/kimiflare/issues/625)) ([d6ec8c9](https://github.com/sinameraji/kimiflare/commit/d6ec8c9d411b17e2c3c0afa9fa2df4d52d9fc112))

## [0.96.0](https://github.com/sinameraji/kimiflare/compare/v0.95.0...v0.96.0) (2026-07-11)


### Features

* **cloud:** default to Kimi-K2.7 in cloud mode ([#623](https://github.com/sinameraji/kimiflare/issues/623)) ([4a1b7ed](https://github.com/sinameraji/kimiflare/commit/4a1b7edb032afccda9e1b1fea87be5cdb3e0274f))

## [0.95.0](https://github.com/sinameraji/kimiflare/compare/v0.94.0...v0.95.0) (2026-07-09)


### Features

* **cloud:** hide model name and picker in cloud mode ([#621](https://github.com/sinameraji/kimiflare/issues/621)) ([4a62580](https://github.com/sinameraji/kimiflare/commit/4a62580f8dbc6e2c264e182a36198c9739b30960))
* **onboarding:** press Enter to open the Cloud sign-in URL ([#620](https://github.com/sinameraji/kimiflare/issues/620)) ([da231c5](https://github.com/sinameraji/kimiflare/commit/da231c5eca3d8d3cddc3c0bd07fb71399284d2ab))

## [0.94.0](https://github.com/sinameraji/kimiflare/compare/v0.93.1...v0.94.0) (2026-07-09)


### Features

* **cloud:** /topup and /manage membership commands ([#618](https://github.com/sinameraji/kimiflare/issues/618)) ([59b4fab](https://github.com/sinameraji/kimiflare/commit/59b4fab39763bf17e8d4da4c7940548e414f400b))

## [0.93.1](https://github.com/sinameraji/kimiflare/compare/v0.93.0...v0.93.1) (2026-07-09)


### Bug Fixes

* slash-command crash + restore self-hosted onboarding + Cloud /upgrade UX ([#616](https://github.com/sinameraji/kimiflare/issues/616)) ([a51d7e9](https://github.com/sinameraji/kimiflare/commit/a51d7e9182a16132fd883174c7a09f5258d350f8))

## [0.93.0](https://github.com/sinameraji/kimiflare/compare/v0.92.0...v0.93.0) (2026-07-09)


### Features

* **session:** hybrid auto-compact + auto-fresh based on in-memory token thresholds ([#614](https://github.com/sinameraji/kimiflare/issues/614)) ([f1f97aa](https://github.com/sinameraji/kimiflare/commit/f1f97aac1401701291702f195f498f970749775a))

## [0.92.0](https://github.com/sinameraji/kimiflare/compare/v0.91.0...v0.92.0) (2026-07-08)


### Features

* **commands:** clean up slash command picker ([#612](https://github.com/sinameraji/kimiflare/issues/612)) ([cd15099](https://github.com/sinameraji/kimiflare/commit/cd150991fdee378617c5c0ca70f2f441bb21a708))
* make @cf/moonshotai/kimi-k2.6 the default model ([#610](https://github.com/sinameraji/kimiflare/issues/610)) ([a77e5c6](https://github.com/sinameraji/kimiflare/commit/a77e5c6a4521934e7b2fa3d5808c54ef97452bd1))
* remove multi-agent-experimental from mode cycle ([#609](https://github.com/sinameraji/kimiflare/issues/609)) ([e54ed48](https://github.com/sinameraji/kimiflare/commit/e54ed48c4728ea849c3e4c9754b4fb9cf516259e))
* **tools:** layered PR-preferred workflow for git pushes ([#603](https://github.com/sinameraji/kimiflare/issues/603)) ([3a5af2b](https://github.com/sinameraji/kimiflare/commit/3a5af2b1464d54e9dab15eed92d8bde758b2e71f))
* **ui:** add moving progress bar during session resume ([#607](https://github.com/sinameraji/kimiflare/issues/607)) ([1026b7e](https://github.com/sinameraji/kimiflare/commit/1026b7ef033a2b7e1a42eb5debedada048f00f4c))
* **ui:** add Try again button to retryable API errors ([#611](https://github.com/sinameraji/kimiflare/issues/611)) ([f85a9d1](https://github.com/sinameraji/kimiflare/commit/f85a9d1aa360e6be98d20167bd6f8709ca17bdff))

## [0.91.0](https://github.com/sinameraji/kimiflare/compare/v0.90.1...v0.91.0) (2026-07-08)


### Features

* **cloud:** restore KimiFlare Cloud adapter with K2.7 free tokens ([#586](https://github.com/sinameraji/kimiflare/issues/586)) ([634406d](https://github.com/sinameraji/kimiflare/commit/634406deac5347baff1cfb49405a9053b1327b7f))

## [0.90.1](https://github.com/sinameraji/kimiflare/compare/v0.90.0...v0.90.1) (2026-07-04)


### Bug Fixes

* **ui:** show loading state while resuming session and auto-display summary ([#604](https://github.com/sinameraji/kimiflare/issues/604)) ([87bda6b](https://github.com/sinameraji/kimiflare/commit/87bda6b636a64096ef21cc975e69621a4d2f9a8f))

## [0.90.0](https://github.com/sinameraji/kimiflare/compare/v0.89.1...v0.90.0) (2026-07-01)


### Features

* **ui:** show session context summary on /resume ([#601](https://github.com/sinameraji/kimiflare/issues/601)) ([0c56f8e](https://github.com/sinameraji/kimiflare/commit/0c56f8e97e839fa1e334f9ecab9d8ae8db099e82))

## [0.89.1](https://github.com/sinameraji/kimiflare/compare/v0.89.0...v0.89.1) (2026-06-30)


### Bug Fixes

* **agent:** remove per-turn tier/skl from gateway metadata to restore cache hits ([#600](https://github.com/sinameraji/kimiflare/issues/600)) ([ad1bb84](https://github.com/sinameraji/kimiflare/commit/ad1bb84391254d7744dacfa4fddea938c1facb6a))
* **ui:** prevent ghost text when input wraps across multiple lines ([#598](https://github.com/sinameraji/kimiflare/issues/598)) ([cde20ac](https://github.com/sinameraji/kimiflare/commit/cde20acc6d8a346501a12eec719cdd74db1d0b60))

## [0.89.0](https://github.com/sinameraji/kimiflare/compare/v0.88.4...v0.89.0) (2026-06-30)


### Features

* **models:** add GLM 5.2 (Zhipu AI on Workers AI) to registry ([#594](https://github.com/sinameraji/kimiflare/issues/594)) ([e02f3bc](https://github.com/sinameraji/kimiflare/commit/e02f3bc0784eb458fa5fa7c75ac359e41766ae35))


### Bug Fixes

* **ui:** auto-start execution after plan-complete picker chooses auto/edit ([#595](https://github.com/sinameraji/kimiflare/issues/595)) ([5f81874](https://github.com/sinameraji/kimiflare/commit/5f81874776ade0440f778846d599542270c4c04d))

## [0.88.4](https://github.com/sinameraji/kimiflare/compare/v0.88.3...v0.88.4) (2026-06-20)


### Performance Improvements

* **tokens:** cache-safe recall + Code Mode enforcement (+ dump tooling) ([#592](https://github.com/sinameraji/kimiflare/issues/592)) ([f05207f](https://github.com/sinameraji/kimiflare/commit/f05207fceef079954424f29958c39705f95a4256))

## [0.88.3](https://github.com/sinameraji/kimiflare/compare/v0.88.2...v0.88.3) (2026-06-15)


### Bug Fixes

* **agent:** preserve original plan across /fresh in plan mode ([#589](https://github.com/sinameraji/kimiflare/issues/589)) ([ed14cc6](https://github.com/sinameraji/kimiflare/commit/ed14cc612f60a7bca0a591922ccadacce386ed32))

## [0.88.2](https://github.com/sinameraji/kimiflare/compare/v0.88.1...v0.88.2) (2026-06-15)


### Bug Fixes

* **memory:** route embeddings through AI Gateway /compat/embeddings ([#587](https://github.com/sinameraji/kimiflare/issues/587)) ([4648b9b](https://github.com/sinameraji/kimiflare/commit/4648b9b4def647299647878dae5cdbe5d5d4afbd))

## [0.88.1](https://github.com/sinameraji/kimiflare/compare/v0.88.0...v0.88.1) (2026-06-13)


### Bug Fixes

* **ui:** default to React Ink, update K2.6 to K2.7 branding, bump v0.88.1 ([#584](https://github.com/sinameraji/kimiflare/issues/584)) ([17c144e](https://github.com/sinameraji/kimiflare/commit/17c144e24ad9782ec1b294d18a9e7cca0e9126de))

## [0.88.0](https://github.com/sinameraji/kimiflare/compare/v0.87.0...v0.88.0) (2026-06-13)


### Features

* **models:** add Kimi K2.7 Code as default model ([#582](https://github.com/sinameraji/kimiflare/issues/582)) ([ce1f51d](https://github.com/sinameraji/kimiflare/commit/ce1f51df078dbc4edaaf748b4258368d5b8937b3))

## [0.87.0](https://github.com/sinameraji/kimiflare/compare/v0.86.0...v0.87.0) (2026-06-12)


### Features

* **headless:** full headless/CI parity with OpenCode ([#581](https://github.com/sinameraji/kimiflare/issues/581)) ([4a3f41f](https://github.com/sinameraji/kimiflare/commit/4a3f41f5fd2e91efc17843993947524a3b8e3ffb))
* **ui:** reduce startup noise ([#579](https://github.com/sinameraji/kimiflare/issues/579)) ([1fe3a84](https://github.com/sinameraji/kimiflare/commit/1fe3a84f6bad1374234fa8a3dcda2229ef1f5a8a))

## [0.86.0](https://github.com/sinameraji/kimiflare/compare/v0.85.0...v0.86.0) (2026-06-12)


### Features

* **agent:** parallelize read-only tools within a turn ([#576](https://github.com/sinameraji/kimiflare/issues/576)) ([2327e48](https://github.com/sinameraji/kimiflare/commit/2327e4890709919a694578ebab6f0bef6ac87735))
* **camouflage:** P0.3 diff rendering + P0.4 fuzzy file picker ([#573](https://github.com/sinameraji/kimiflare/issues/573)) ([465422b](https://github.com/sinameraji/kimiflare/commit/465422ba1dcb42c7278a2d3da16bd8f8276ab721))
* **camouflage:** P1 parity — plan complete picker, skills wizard, theme persistence ([#574](https://github.com/sinameraji/kimiflare/issues/574)) ([6b889af](https://github.com/sinameraji/kimiflare/commit/6b889af7d81d1e231cd054aaff93d66939127569))
* **camouflage:** P2 parity — cost breakdown, workers, hooks dashboard, QR codes, changelog picker ([#575](https://github.com/sinameraji/kimiflare/issues/575)) ([c4b69e2](https://github.com/sinameraji/kimiflare/commit/c4b69e28595edf5af828cf78bea62ca7436ef7dc))
* **camouflage:** P3 enhancements — persistence, todo list, paste handling, bug fixes ([#577](https://github.com/sinameraji/kimiflare/issues/577)) ([b319a40](https://github.com/sinameraji/kimiflare/commit/b319a40cb87fcbb991422eeadeae861e24381ce4))
* **camouflage:** P3.17 mouse support — host-side event handling ([#578](https://github.com/sinameraji/kimiflare/issues/578)) ([3e68873](https://github.com/sinameraji/kimiflare/commit/3e68873035fc3abd61001a38acdf93d96fab5498))
* **camouflage:** wire MemoryManager, MCP, LSP, and Hooks managers ([#571](https://github.com/sinameraji/kimiflare/issues/571)) ([54b49e2](https://github.com/sinameraji/kimiflare/commit/54b49e25edb83936ea981622148bc3544672cd1f))

## [0.85.0](https://github.com/sinameraji/kimiflare/compare/v0.84.1...v0.85.0) (2026-06-11)


### Features

* add /changelog-image command to generate shareable changelog PNGs ([#562](https://github.com/sinameraji/kimiflare/issues/562)) ([43db05b](https://github.com/sinameraji/kimiflare/commit/43db05b1c917fe3e0fe2d559aaf16f6d6308cf05))
* **agent:** mode-aware /fresh with continuation summaries ([#570](https://github.com/sinameraji/kimiflare/issues/570)) ([e9368bb](https://github.com/sinameraji/kimiflare/commit/e9368bbfa37dbdccb21a5ce53999c21a35e8740a))

## [0.84.1](https://github.com/sinameraji/kimiflare/compare/v0.84.0...v0.84.1) (2026-06-11)


### Bug Fixes

* **ui:** rebuild system prompt when switching from plan to execution mode ([#567](https://github.com/sinameraji/kimiflare/issues/567)) ([c328f63](https://github.com/sinameraji/kimiflare/commit/c328f639ad9a83bf37f849f51b4177c169e279f1))

## [0.84.0](https://github.com/sinameraji/kimiflare/compare/v0.83.0...v0.84.0) (2026-06-11)


### Features

* **agent:** increase default tool-call limit from 50 to 200 ([#564](https://github.com/sinameraji/kimiflare/issues/564)) ([e2ceabc](https://github.com/sinameraji/kimiflare/commit/e2ceabcf414a72bfba042385861e6274a2a7edae))


### Bug Fixes

* **plan-mode:** preserve original plan across follow-up discussion ([#566](https://github.com/sinameraji/kimiflare/issues/566)) ([5aa0d59](https://github.com/sinameraji/kimiflare/commit/5aa0d597a4014df3fcd23b5c8cbd5ddc0bcb22b5))

## [0.83.0](https://github.com/sinameraji/kimiflare/compare/v0.82.1...v0.83.0) (2026-06-08)


### Features

* **seo:** SEO + GEO overhaul of kimiflare.com ([#556](https://github.com/sinameraji/kimiflare/issues/556)) ([39966e1](https://github.com/sinameraji/kimiflare/commit/39966e11ed8e34ba742ef93be5405b9f4239049d))
* **tools:** present_plan_options tool with dual-UI support ([#563](https://github.com/sinameraji/kimiflare/issues/563)) ([c413081](https://github.com/sinameraji/kimiflare/commit/c413081711a7237b18f306ca3da7dc98a6cc73de))
* **usage:** carry over cost baseline on /fresh ([#560](https://github.com/sinameraji/kimiflare/issues/560)) ([8198283](https://github.com/sinameraji/kimiflare/commit/81982837f6cac6073955310dcac3b96aa23c055d))


### Bug Fixes

* **agent:** strengthen tasks_set prompt and add heuristic auto-advance ([#559](https://github.com/sinameraji/kimiflare/issues/559)) ([5ed1e9b](https://github.com/sinameraji/kimiflare/commit/5ed1e9b27fefa12eefff77dd5bad310a9ba2678e))
* **docs:** shorten hero copy and remove text-heavy sections ([#561](https://github.com/sinameraji/kimiflare/issues/561)) ([546a81a](https://github.com/sinameraji/kimiflare/commit/546a81a65fcb486c01495934c818aed1c91f7aad))

## [0.82.1](https://github.com/sinameraji/kimiflare/compare/v0.82.0...v0.82.1) (2026-06-04)


### Bug Fixes

* **ui:** prevent blank screen when PlanCompletePicker opens after plan mode ([#554](https://github.com/sinameraji/kimiflare/issues/554)) ([3b39304](https://github.com/sinameraji/kimiflare/commit/3b39304887c79643aa121e33038942494fb6a25f))

## [0.82.0](https://github.com/sinameraji/kimiflare/compare/v0.81.0...v0.82.0) (2026-06-03)


### Features

* **update:** check for camouflage-tui optional dependency updates ([#550](https://github.com/sinameraji/kimiflare/issues/550)) ([f07da38](https://github.com/sinameraji/kimiflare/commit/f07da38e8eba1ead1ff523f6bc1dd7358bf1f23f))


### Bug Fixes

* **camouflage:** wire /logout and /fresh slash commands ([#549](https://github.com/sinameraji/kimiflare/issues/549)) ([0122870](https://github.com/sinameraji/kimiflare/commit/0122870d2de8c3c33e249f4e66870c7c153ce5ca)), closes [#1](https://github.com/sinameraji/kimiflare/issues/1)
* **ui:** correct cursor rendering, add paste sanitization and usePaste hook ([#552](https://github.com/sinameraji/kimiflare/issues/552)) ([ea6946a](https://github.com/sinameraji/kimiflare/commit/ea6946adfaf8e45f78698746934ccdc4dc5b58ca))
* **ui:** keep cursor at end on history nav + only spinner on latest assistant msg ([#547](https://github.com/sinameraji/kimiflare/issues/547)) ([debe4cc](https://github.com/sinameraji/kimiflare/commit/debe4cc4e708bb8732854ab009752c6f94383c62))
* **ui:** make PlanCompletePicker an inline overlay and auto-submit plan ([#551](https://github.com/sinameraji/kimiflare/issues/551)) ([7724f13](https://github.com/sinameraji/kimiflare/commit/7724f1332028cd685b08e7dfc53b5b961b4e68ea))

## [0.81.0](https://github.com/sinameraji/kimiflare/compare/v0.80.0...v0.81.0) (2026-06-03)


### Features

* **agent:** LLM-based synthesis for multi-agent findings ([#546](https://github.com/sinameraji/kimiflare/issues/546)) ([0168a27](https://github.com/sinameraji/kimiflare/commit/0168a278f5f7176ebbedfcbd15b4c273060fe51a))
* **ui:** auto-prompt /fresh when plan mode completes ([#544](https://github.com/sinameraji/kimiflare/issues/544)) ([b3e8cda](https://github.com/sinameraji/kimiflare/commit/b3e8cda5efaf7068e5beb90219b52735e44e39b6))

## [0.80.0](https://github.com/sinameraji/kimiflare/compare/v0.79.0...v0.80.0) (2026-06-03)


### Features

* add /fresh command to reset session with distilled plan ([#533](https://github.com/sinameraji/kimiflare/issues/533)) ([5893acb](https://github.com/sinameraji/kimiflare/commit/5893acb8f0ee9649b8ee1bb48f4cdbeab6ff34f3))
* **agent:** LLM-based task decomposition for multi-agent mode ([#529](https://github.com/sinameraji/kimiflare/issues/529)) ([c1d29df](https://github.com/sinameraji/kimiflare/commit/c1d29df9234ca36731a1a60ef59511f2440f0674)), closes [#518](https://github.com/sinameraji/kimiflare/issues/518)
* **multi-agent:** client-side worker budget validation and partial-result handling ([#526](https://github.com/sinameraji/kimiflare/issues/526)) ([ef1900b](https://github.com/sinameraji/kimiflare/commit/ef1900b8fd714400c5638fbecabdaadecbf0562a)), closes [#517](https://github.com/sinameraji/kimiflare/issues/517)
* **multi-agent:** coordinator hints, remote-agent phase timing, and shallow clone ([#528](https://github.com/sinameraji/kimiflare/issues/528)) ([6c8c0d9](https://github.com/sinameraji/kimiflare/commit/6c8c0d951f33e20b2f3a50825abe7b627e5b8392))
* **multi-agent:** coordinator-side file-read cache for workers ([#527](https://github.com/sinameraji/kimiflare/issues/527)) ([4e7716d](https://github.com/sinameraji/kimiflare/commit/4e7716da5d442e58e93b8aab5c64f95a5a8dd0d5))
* **multi-agent:** proxy memory, LSP, and MCP context to workers ([#531](https://github.com/sinameraji/kimiflare/issues/531)) ([34433cb](https://github.com/sinameraji/kimiflare/commit/34433cb5b2e8280f7f812b7e33107a943ca55bbb)), closes [#520](https://github.com/sinameraji/kimiflare/issues/520)


### Bug Fixes

* **multi-agent:** respect config timeout, extend on progress, and clear worker list after synthesis ([#532](https://github.com/sinameraji/kimiflare/issues/532)) ([dbc633d](https://github.com/sinameraji/kimiflare/commit/dbc633d927158539f76ecb0762d00849c0e41417))

## [0.79.0](https://github.com/sinameraji/kimiflare/compare/v0.78.0...v0.79.0) (2026-06-02)


### Features

* **multi-agent:** coordinator narration, step visualization, and auto-present findings ([#515](https://github.com/sinameraji/kimiflare/issues/515)) ([71ace3d](https://github.com/sinameraji/kimiflare/commit/71ace3dd2bf8b2c81e0bd01923452c9da70c2368))

## [0.78.0](https://github.com/sinameraji/kimiflare/compare/v0.77.0...v0.78.0) (2026-06-02)


### Features

* **multi-agent:** add teardown, cleanup scripts, and workerName tracking ([#512](https://github.com/sinameraji/kimiflare/issues/512)) ([5895c9c](https://github.com/sinameraji/kimiflare/commit/5895c9c42cbce825942066650523917b7f1da48c))


### Bug Fixes

* **multi-agent:** abort signal, escape cancel, and user-message routing ([#514](https://github.com/sinameraji/kimiflare/issues/514)) ([34d7692](https://github.com/sinameraji/kimiflare/commit/34d7692f1e1c460685467146bb7e266f78702df7))

## [0.77.0](https://github.com/sinameraji/kimiflare/compare/v0.76.1...v0.77.0) (2026-06-02)


### Features

* **multi-agent:** add worker execute mode + unit tests ([#506](https://github.com/sinameraji/kimiflare/issues/506)) ([45e314c](https://github.com/sinameraji/kimiflare/commit/45e314c19921e0bdba15e110960c58d7ef730b92))
* **multi-agent:** full coordinator + worker architecture, one-tap deploy, TUI settings, and resilience fixes ([#511](https://github.com/sinameraji/kimiflare/issues/511)) ([c216ab8](https://github.com/sinameraji/kimiflare/commit/c216ab88387409f811b31cb48cc59829b8250a5c))
* **multi-agent:** standalone worker client side ([#496](https://github.com/sinameraji/kimiflare/issues/496)) ([8bdce6f](https://github.com/sinameraji/kimiflare/commit/8bdce6fee6a7725d1432493d3462a363a3a95f88))


### Bug Fixes

* **multi-agent:** make experimental mode usable in both UIs ([#507](https://github.com/sinameraji/kimiflare/issues/507)) ([752555d](https://github.com/sinameraji/kimiflare/commit/752555d4cf014492aea1adfb6b0e4dba5db3fe4f))

## [0.76.1](https://github.com/sinameraji/kimiflare/compare/v0.76.0...v0.76.1) (2026-05-27)


### Bug Fixes

* make camouflage-tui an optional dependency ([#502](https://github.com/sinameraji/kimiflare/issues/502)) ([0d6824e](https://github.com/sinameraji/kimiflare/commit/0d6824e00e9c2a763e892563a0bdacbab2b36020))

## [0.76.0](https://github.com/sinameraji/kimiflare/compare/v0.75.0...v0.76.0) (2026-05-26)


### Features

* **ui:** default interactive UI to Camouflage ([#474](https://github.com/sinameraji/kimiflare/issues/474)) ([#499](https://github.com/sinameraji/kimiflare/issues/499)) ([75a647b](https://github.com/sinameraji/kimiflare/commit/75a647b5a7bdeaf30aa8b74727a5ded5610f93de))

## [0.75.0](https://github.com/sinameraji/kimiflare/compare/v0.74.1...v0.75.0) (2026-05-24)


### Features

* **ui:** add bidirectional turn separators and speaker labels in chat view ([#493](https://github.com/sinameraji/kimiflare/issues/493)) ([55b0805](https://github.com/sinameraji/kimiflare/commit/55b0805755a4c4a2ccc538a5a572f8826986ccf9))


### Bug Fixes

* **app:** make onDone fire-and-forget so UI returns to idle immediately ([#492](https://github.com/sinameraji/kimiflare/issues/492)) ([b134e3a](https://github.com/sinameraji/kimiflare/commit/b134e3a26378d8c1daebb23307fd74289d322ec8))
* **app:** unblock UI between iterations during onIterationEnd housekeeping ([#494](https://github.com/sinameraji/kimiflare/issues/494)) ([250a553](https://github.com/sinameraji/kimiflare/commit/250a55372473b23e8bf8f273a239976ecc0af2d3))

## [0.74.1](https://github.com/sinameraji/kimiflare/compare/v0.74.0...v0.74.1) (2026-05-23)


### Bug Fixes

* **agent:** close race window in processMessage and harden runInit/runCompact ([#491](https://github.com/sinameraji/kimiflare/issues/491)) ([0994e80](https://github.com/sinameraji/kimiflare/commit/0994e807065a705b840b33053d4388d82d4204ff))
* **agent:** prevent TurnSupervisor crash on race-conditioned turn starts ([#487](https://github.com/sinameraji/kimiflare/issues/487)) ([104691b](https://github.com/sinameraji/kimiflare/commit/104691b4f20b3f01f95f7ce41aba6e0d7f978f84))
* **context:** prevent API overflow at high context utilization ([#489](https://github.com/sinameraji/kimiflare/issues/489)) ([83cbe79](https://github.com/sinameraji/kimiflare/commit/83cbe7945c1d22ce308ec193c913c63445ee177b))

## [0.74.0](https://github.com/sinameraji/kimiflare/compare/v0.73.2...v0.74.0) (2026-05-21)


### Features

* **routing:** dual-path Workers AI direct + AI Gateway ([#484](https://github.com/sinameraji/kimiflare/issues/484)) ([7ee9db3](https://github.com/sinameraji/kimiflare/commit/7ee9db3f7d15ac091d3eeafa575842356c9382c3))


### Bug Fixes

* **agent:** prevent 'Body is unusable' error and handle it gracefully ([#482](https://github.com/sinameraji/kimiflare/issues/482)) ([4f33f08](https://github.com/sinameraji/kimiflare/commit/4f33f080fd15d4314fb2a4fbb985bf4565b5a509))

## [0.73.2](https://github.com/sinameraji/kimiflare/compare/v0.73.1...v0.73.2) (2026-05-21)


### Bug Fixes

* **routing:** route every chat model through AI Gateway /compat ([#480](https://github.com/sinameraji/kimiflare/issues/480)) ([16ac852](https://github.com/sinameraji/kimiflare/commit/16ac852ef2775027a87f7d09ff10293edb845eb6))

## [0.73.1](https://github.com/sinameraji/kimiflare/compare/v0.73.0...v0.73.1) (2026-05-18)


### Bug Fixes

* **onboarding:** route picked model through billing setup before saving ([#476](https://github.com/sinameraji/kimiflare/issues/476)) ([2c9a0be](https://github.com/sinameraji/kimiflare/commit/2c9a0be9c437bece31e6fa6c653cde692fc86a3f))

## [0.73.0](https://github.com/sinameraji/kimiflare/compare/v0.72.0...v0.73.0) (2026-05-18)


### Features

* **models:** multi-provider routing via AI Gateway Universal Endpoint ([#468](https://github.com/sinameraji/kimiflare/issues/468)) ([a319976](https://github.com/sinameraji/kimiflare/commit/a319976611d91deb84585b362b1a759583c7acec))

## [0.72.0](https://github.com/sinameraji/kimiflare/compare/v0.71.0...v0.72.0) (2026-05-17)


### Features

* **glob:** replace fast-glob with native node:fs implementation ([#470](https://github.com/sinameraji/kimiflare/issues/470)) ([b5f1712](https://github.com/sinameraji/kimiflare/commit/b5f1712fb50e8f5a7311713b591e5bd27bc6e6d4))
* remove diff npm dependency ([#473](https://github.com/sinameraji/kimiflare/issues/473)) ([c5f3a8f](https://github.com/sinameraji/kimiflare/commit/c5f3a8f3eaa98229be5ca301362f9baef384be85))

## [0.71.0](https://github.com/sinameraji/kimiflare/compare/v0.70.0...v0.71.0) (2026-05-17)


### Features

* **hooks:** user-configured lifecycle hooks (M6.1) ([#467](https://github.com/sinameraji/kimiflare/issues/467)) ([56a1c11](https://github.com/sinameraji/kimiflare/commit/56a1c1133bb6e1a47ffeef736df0017d3d1c0686))
* **skills:** replace gray-matter with custom frontmatter parser ([#469](https://github.com/sinameraji/kimiflare/issues/469)) ([f1ef6c0](https://github.com/sinameraji/kimiflare/commit/f1ef6c0b7d2535a7540ff7ccc58cf171ea73ab4f))
* **telemetry:** optional OTLP/HTTP log export (M5.2) ([#460](https://github.com/sinameraji/kimiflare/issues/460)) ([d238d68](https://github.com/sinameraji/kimiflare/commit/d238d68535d666b5b3ec92fa17f89ff8aa2749c4))


### Bug Fixes

* **status:** suppress 'AI Gateway · cache miss' indicator ([#466](https://github.com/sinameraji/kimiflare/issues/466)) ([7376d3a](https://github.com/sinameraji/kimiflare/commit/7376d3a151fdf6b0d8808e6ce36c7bb90579ef5d))

## [0.70.0](https://github.com/sinameraji/kimiflare/compare/v0.69.0...v0.70.0) (2026-05-16)


### Features

* **telemetry:** structured JSON log sink + correlation IDs (M5.1) ([#458](https://github.com/sinameraji/kimiflare/issues/458)) ([439816e](https://github.com/sinameraji/kimiflare/commit/439816e1433a1ccf1dca6687676fccfdd5343e4c))

## [0.69.0](https://github.com/sinameraji/kimiflare/compare/v0.68.2...v0.69.0) (2026-05-16)


### Features

* **observability:** log prompt preview + preTurnMs, surface routing in AI Gateway ([#455](https://github.com/sinameraji/kimiflare/issues/455)) ([a69d470](https://github.com/sinameraji/kimiflare/commit/a69d47001d6e0c0f793161477262958081a13e2c))
* **tools:** streaming read for files over the 2 MB cap (M3.4) ([#454](https://github.com/sinameraji/kimiflare/issues/454)) ([f69f8ba](https://github.com/sinameraji/kimiflare/commit/f69f8ba7e23cf8da42925cf25f4f9b33d6af83cf))

## [0.68.2](https://github.com/sinameraji/kimiflare/compare/v0.68.1...v0.68.2) (2026-05-16)


### Performance Improvements

* **routing:** parallelize pre-turn memory recall + skill routing ([#449](https://github.com/sinameraji/kimiflare/issues/449)) ([967c0f1](https://github.com/sinameraji/kimiflare/commit/967c0f1d5f987300f8ee4ddb45c7f3403e8f6662))

## [0.68.1](https://github.com/sinameraji/kimiflare/compare/v0.68.0...v0.68.1) (2026-05-16)


### Bug Fixes

* **loop:** wrap onKimiMdStale/onWarning fires in memory-extraction IIFE ([#444](https://github.com/sinameraji/kimiflare/issues/444)) ([8699021](https://github.com/sinameraji/kimiflare/commit/8699021e68f9dc70b092b02b779f835956a6e8e4))

## [0.68.0](https://github.com/sinameraji/kimiflare/compare/v0.67.0...v0.68.0) (2026-05-16)


### Features

* **usage:** surface gateway latency, per-feature cost, cache-hit ratio ([#441](https://github.com/sinameraji/kimiflare/issues/441)) ([e3405cf](https://github.com/sinameraji/kimiflare/commit/e3405cf4250e7ce39273224cb5a208fcee59bc30))

## [0.67.0](https://github.com/sinameraji/kimiflare/compare/v0.66.0...v0.67.0) (2026-05-16)


### Features

* **loop:** cross-turn web-fetch guardrail (OP-6 / RF-3) ([#433](https://github.com/sinameraji/kimiflare/issues/433)) ([f6428f7](https://github.com/sinameraji/kimiflare/commit/f6428f7224b73337e4cb6a1304d899bca1f330fb))
* **loop:** onTruncation callback for truncated tool output (OP-3 / RF-12) ([#429](https://github.com/sinameraji/kimiflare/issues/429)) ([ccfec01](https://github.com/sinameraji/kimiflare/commit/ccfec014abde123d3ba026bfaff585140e440e93))
* **loop:** sliding-window drift detection (OP-8 / RF-2) ([#435](https://github.com/sinameraji/kimiflare/issues/435)) ([367d4e1](https://github.com/sinameraji/kimiflare/commit/367d4e1cd32ccb0b224edc2602c836c1a396bdbe))

## [0.66.0](https://github.com/sinameraji/kimiflare/compare/v0.65.0...v0.66.0) (2026-05-16)


### Features

* **artifacts:** size-weighted eviction in ArtifactStore (OP-2 / RF-9) ([#428](https://github.com/sinameraji/kimiflare/issues/428)) ([9ae379e](https://github.com/sinameraji/kimiflare/commit/9ae379efd85c6ad4c6b431ae609e7c00e4b2d09a))
* **client:** per-call SSE idle timeout with post-first-byte tightening (OP-4 / RF-7) ([#430](https://github.com/sinameraji/kimiflare/issues/430)) ([f2ed8f2](https://github.com/sinameraji/kimiflare/commit/f2ed8f231130bbc2a11e3203bd70f2f1ae60acf8))
* **memory:** per-session extraction-error counter + first-failure warning (OP-7 / RF-1) ([#434](https://github.com/sinameraji/kimiflare/issues/434)) ([d70e72a](https://github.com/sinameraji/kimiflare/commit/d70e72a063f7563ed67cca0d67d6d1bb6c108370))
* **tools:** honor ctx.signal in grep/glob/read (OP-5 / RF-13 first half) ([#431](https://github.com/sinameraji/kimiflare/issues/431)) ([ce71766](https://github.com/sinameraji/kimiflare/commit/ce71766e4d31b6bbab2430d11564b3a8846e8471))


### Bug Fixes

* **loop:** enforce token budget on pure-text turns too (OP-9 / RF-5) ([#436](https://github.com/sinameraji/kimiflare/issues/436)) ([b3963c9](https://github.com/sinameraji/kimiflare/commit/b3963c92fd2f7698ae76061c50d1fd7d8fcb4fdf))

## [0.65.0](https://github.com/sinameraji/kimiflare/compare/v0.64.0...v0.65.0) (2026-05-16)


### Features

* **usage:** reconcile per-turn cost from AI Gateway logs ([#437](https://github.com/sinameraji/kimiflare/issues/437)) ([39eca8c](https://github.com/sinameraji/kimiflare/commit/39eca8c7e389b4d01c528719de3a94927fd2054e))

## [0.64.0](https://github.com/sinameraji/kimiflare/compare/v0.63.0...v0.64.0) (2026-05-16)


### Features

* **ai-gateway:** make Cloudflare AI Gateway the default backend ([#420](https://github.com/sinameraji/kimiflare/issues/420)) ([e67725e](https://github.com/sinameraji/kimiflare/commit/e67725e5d1d14e803e5ea99168f8e6daef68e377))
* **lsp:** configurable per-request timeout and auto-restart on crash ([#422](https://github.com/sinameraji/kimiflare/issues/422)) ([6a2df6a](https://github.com/sinameraji/kimiflare/commit/6a2df6ac7e10306d8ebf59b7d92fd9c1f2d9af85))
* **mcp:** per-call timeout for tool invocations ([#421](https://github.com/sinameraji/kimiflare/issues/421)) ([6577721](https://github.com/sinameraji/kimiflare/commit/657772179c270ba06fe686b6b28d8dd7704f44ac))
* ship M1.1, M1.10, log M3.1–M3.3 progress ([#425](https://github.com/sinameraji/kimiflare/issues/425)) ([89bb94a](https://github.com/sinameraji/kimiflare/commit/89bb94ae8a75bb31d21c68c04288b39dcca19aff))


### Bug Fixes

* **app:** disable Ink's built-in Ctrl+C handler so useInput can interrupt (M1.0, real fix) ([#427](https://github.com/sinameraji/kimiflare/issues/427)) ([d0b4d46](https://github.com/sinameraji/kimiflare/commit/d0b4d46c922fdc343d503533cea67f38d6c1fe4b))

## [0.63.0](https://github.com/sinameraji/kimiflare/compare/v0.62.0...v0.63.0) (2026-05-13)


### Features

* **onboarding:** remove cloud mode option, default to BYOK ([#413](https://github.com/sinameraji/kimiflare/issues/413)) ([e6000db](https://github.com/sinameraji/kimiflare/commit/e6000dbe127f27ba2a9e8d75d67a4b9d7385d496))


### Bug Fixes

* **deps:** resolve npm audit vulnerabilities ([#411](https://github.com/sinameraji/kimiflare/issues/411)) ([3b0a875](https://github.com/sinameraji/kimiflare/commit/3b0a87597ef50f6cde8688fd61a229a7471b9656))

## [0.62.0](https://github.com/sinameraji/kimiflare/compare/v0.61.0...v0.62.0) (2026-05-13)


### Features

* **feedback:** QR code fallback, mic selector, mic level meter, R2 upload ([#408](https://github.com/sinameraji/kimiflare/issues/408)) ([7300afb](https://github.com/sinameraji/kimiflare/commit/7300afb2d8c26d33ec1231593e6b0163a35f01f2))
* **inbox:** add /inbox command for voice replies from creator ([#407](https://github.com/sinameraji/kimiflare/issues/407)) ([4dfbd94](https://github.com/sinameraji/kimiflare/commit/4dfbd94bb61845bd907580c590157e75b212c9da))


### Bug Fixes

* **feedback-worker:** stop microphone stream leaks after recording ([#410](https://github.com/sinameraji/kimiflare/issues/410)) ([c18d832](https://github.com/sinameraji/kimiflare/commit/c18d8325acaa5fd384c3a081e01b1f95171d601f))

## [0.61.0](https://github.com/sinameraji/kimiflare/compare/v0.60.1...v0.61.0) (2026-05-13)


### Features

* **ui:** add 'Synthesize' option to loop detection modal ([#405](https://github.com/sinameraji/kimiflare/issues/405)) ([17c8a8b](https://github.com/sinameraji/kimiflare/commit/17c8a8b24028c77966ac6318515b6621d417d4f4))

## [0.60.1](https://github.com/sinameraji/kimiflare/compare/v0.60.0...v0.60.1) (2026-05-13)


### Bug Fixes

* **cloud:** TUI cloud auth now passes credentials directly and persists cloudMode ([#403](https://github.com/sinameraji/kimiflare/issues/403)) ([370e434](https://github.com/sinameraji/kimiflare/commit/370e434309731addabc32234cf84d746612a577c))

## [0.60.0](https://github.com/sinameraji/kimiflare/compare/v0.59.0...v0.60.0) (2026-05-12)


### Features

* **feedback-worker:** store voice notes in R2, serve via /audio, text-only Discord webhook ([#401](https://github.com/sinameraji/kimiflare/issues/401)) ([69898e3](https://github.com/sinameraji/kimiflare/commit/69898e3076c996ed938dd77692088330e0a6d36b))

## [0.59.0](https://github.com/sinameraji/kimiflare/compare/v0.58.0...v0.59.0) (2026-05-12)


### Features

* **agent:** move pre-turn memory recall and skill routing into supervisor lifecycle ([#399](https://github.com/sinameraji/kimiflare/issues/399)) ([735cc7c](https://github.com/sinameraji/kimiflare/commit/735cc7c36bad18e054926910694b34e453adf9d3))

## [0.58.0](https://github.com/sinameraji/kimiflare/compare/v0.57.0...v0.58.0) (2026-05-12)


### Features

* **cloud:** add kill switch integration for KimiFlare Cloud ([#395](https://github.com/sinameraji/kimiflare/issues/395)) ([ec37c10](https://github.com/sinameraji/kimiflare/commit/ec37c1036fece5a41d2aca50337ecdd2a81011e8))
* **ui:** add loop-detected modal with continue/stop choices ([#397](https://github.com/sinameraji/kimiflare/issues/397)) ([d97fe3f](https://github.com/sinameraji/kimiflare/commit/d97fe3f02300a84f9886d9a36cf64fe7a548d14c))


### Reverts

* **config:** default memoryEnabled back to false (opt-in via /memory) ([#398](https://github.com/sinameraji/kimiflare/issues/398)) ([54e702d](https://github.com/sinameraji/kimiflare/commit/54e702dd6569b8467437965a551430bebf643a5e))

## [0.57.0](https://github.com/sinameraji/kimiflare/compare/v0.56.0...v0.57.0) (2026-05-11)


### Features

* **skills:** AGENTS.md + semantic skill search ([#394](https://github.com/sinameraji/kimiflare/issues/394)) ([c8edb8b](https://github.com/sinameraji/kimiflare/commit/c8edb8b1d015274f96969ba4e3c0b3a5936c4c1e))


### Bug Fixes

* **cloud:** catch network errors in fetchCloudUsage to prevent crashes ([#392](https://github.com/sinameraji/kimiflare/issues/392)) ([daabba0](https://github.com/sinameraji/kimiflare/commit/daabba06074b4753430a15ab3d8c5a55feed1ab0))

## [0.56.0](https://github.com/sinameraji/kimiflare/compare/v0.55.1...v0.56.0) (2026-05-11)


### Features

* **report:** add /report slash command for diagnostic error reporting ([#387](https://github.com/sinameraji/kimiflare/issues/387)) ([8793e5a](https://github.com/sinameraji/kimiflare/commit/8793e5a85fecae900e94eb13d5ea3506367cbd9e))

## [0.55.1](https://github.com/sinameraji/kimiflare/compare/v0.55.0...v0.55.1) (2026-05-11)


### Bug Fixes

* **config:** default memoryEnabled to true for all users ([#388](https://github.com/sinameraji/kimiflare/issues/388)) ([177826f](https://github.com/sinameraji/kimiflare/commit/177826f14a8997e0f43f2b3ff9051995c0123603))

## [0.55.0](https://github.com/sinameraji/kimiflare/compare/v0.54.1...v0.55.0) (2026-05-11)


### Features

* **tools:** OS-aware shell selection for bash tool ([#385](https://github.com/sinameraji/kimiflare/issues/385)) ([a0ae6f7](https://github.com/sinameraji/kimiflare/commit/a0ae6f799c3a29a31d4ac9bd17f07f68735caaf2))

## [0.54.1](https://github.com/sinameraji/kimiflare/compare/v0.54.0...v0.54.1) (2026-05-11)


### Bug Fixes

* **agent:** retry 429 rate limits and surface Cloudflare error codes ([#383](https://github.com/sinameraji/kimiflare/issues/383)) ([b3194f0](https://github.com/sinameraji/kimiflare/commit/b3194f0cec0bfa2d9ed374f63c161679996c5002))

## [0.54.0](https://github.com/sinameraji/kimiflare/compare/v0.53.0...v0.54.0) (2026-05-10)


### Features

* **sandbox:** improve fallback warning UX and SDK integration ([#382](https://github.com/sinameraji/kimiflare/issues/382)) ([eb0816a](https://github.com/sinameraji/kimiflare/commit/eb0816a98e7ae5ccaa386b2b8257be82cb4272c4))
* **ui:** restore shift+tab mode-cycle hint in status bar ([#380](https://github.com/sinameraji/kimiflare/issues/380)) ([c5c5856](https://github.com/sinameraji/kimiflare/commit/c5c5856a80114e83a9b5927aa40cd6b2baa37058))

## [0.53.0](https://github.com/sinameraji/kimiflare/compare/v0.52.0...v0.53.0) (2026-05-10)


### Features

* **ui:** restore true message queuing — Enter queues, Esc interrupts ([#378](https://github.com/sinameraji/kimiflare/issues/378)) ([9b62196](https://github.com/sinameraji/kimiflare/commit/9b621969c3a59f38c6a8004b63500a432df30bc1))
* **ui:** tool states show queued, rejected, cancelled ([#374](https://github.com/sinameraji/kimiflare/issues/374)) ([cdf34eb](https://github.com/sinameraji/kimiflare/commit/cdf34eb5492d0e5a703b6de2119f6db918fda38e))

## [0.52.0](https://github.com/sinameraji/kimiflare/compare/v0.51.0...v0.52.0) (2026-05-10)


### Features

* **ui:** show content preview in paste placeholders ([#376](https://github.com/sinameraji/kimiflare/issues/376)) ([5c58b4c](https://github.com/sinameraji/kimiflare/commit/5c58b4c2030c8aff6a3d6b578e9069be934e15f8))
* **ui:** smart permission modal with inline feedback and keyboard shortcuts ([#369](https://github.com/sinameraji/kimiflare/issues/369)) ([3e2370e](https://github.com/sinameraji/kimiflare/commit/3e2370edbb83b08fa60bcd48197db34fff7f4388))

## [0.51.0](https://github.com/sinameraji/kimiflare/compare/v0.50.1...v0.51.0) (2026-05-10)


### Features

* **agent:** hard-stop loop guardrail following BudgetExhaustedError pattern ([#367](https://github.com/sinameraji/kimiflare/issues/367)) ([ffdc272](https://github.com/sinameraji/kimiflare/commit/ffdc272dd6c122eb9d14aa346615cc3f19b8ac64))


### Bug Fixes

* **auth:** harden device ID to prevent multi-account abuse ([#372](https://github.com/sinameraji/kimiflare/issues/372)) ([0438bf7](https://github.com/sinameraji/kimiflare/commit/0438bf7b1711e3c5732ee276113814905654bac6))

## [0.50.1](https://github.com/sinameraji/kimiflare/compare/v0.50.0...v0.50.1) (2026-05-09)


### Bug Fixes

* **ui:** defensive tool renders and diff view to prevent crashes on malformed args ([#353](https://github.com/sinameraji/kimiflare/issues/353)) ([0d2cdc4](https://github.com/sinameraji/kimiflare/commit/0d2cdc4dfefbd2c434d5ab4b36568d03ebc5ce8f))

## [0.50.0](https://github.com/sinameraji/kimiflare/compare/v0.49.0...v0.50.0) (2026-05-09)


### Features

* **errors:** humanize Cloudflare API errors in TUI and print mode ([#350](https://github.com/sinameraji/kimiflare/issues/350)) ([fc56b44](https://github.com/sinameraji/kimiflare/commit/fc56b44b5e538ed9def3230f303140c1fe2cc5a7))
* **usage:** persistent history.jsonl for never-pruned daily usage ([#352](https://github.com/sinameraji/kimiflare/issues/352)) ([4b66610](https://github.com/sinameraji/kimiflare/commit/4b6661027e7595fe4849210f815e58a478258fe2))

## [0.49.0](https://github.com/sinameraji/kimiflare/compare/v0.48.5...v0.49.0) (2026-05-09)


### Features

* **sdk:** add headless SDK for KimiFlare Studio ([#347](https://github.com/sinameraji/kimiflare/issues/347)) ([01993b5](https://github.com/sinameraji/kimiflare/commit/01993b56f5dabf58567d7afb1fb5d13ae5de128a))

## [0.48.5](https://github.com/sinameraji/kimiflare/compare/v0.48.4...v0.48.5) (2026-05-09)


### Bug Fixes

* **ui:** correct notify domain from kimiflare.dev to kimiflare.com ([#343](https://github.com/sinameraji/kimiflare/issues/343)) ([613d53e](https://github.com/sinameraji/kimiflare/commit/613d53e41f3f08fd827b2eef3257e4ab741a48d0))

## [0.48.4](https://github.com/sinameraji/kimiflare/compare/v0.48.3...v0.48.4) (2026-05-08)


### Bug Fixes

* **app:** add missing logger import ([#341](https://github.com/sinameraji/kimiflare/issues/341)) ([fefd47a](https://github.com/sinameraji/kimiflare/commit/fefd47a662e7731362478fc6e37cfa2d123fb3c9))

## [0.48.3](https://github.com/sinameraji/kimiflare/compare/v0.48.2...v0.48.3) (2026-05-08)


### Bug Fixes

* resolve interrupt hangs from backgrounded bash processes and stuck abort debounce ([#339](https://github.com/sinameraji/kimiflare/issues/339)) ([c63df39](https://github.com/sinameraji/kimiflare/commit/c63df39a609bb5b6dbfef33872262899d6ff2c80))

## [0.48.2](https://github.com/sinameraji/kimiflare/compare/v0.48.1...v0.48.2) (2026-05-07)


### Bug Fixes

* **ui:** remove Static component from ChatView to fix /clear memory leak ([#334](https://github.com/sinameraji/kimiflare/issues/334)) ([e510cb9](https://github.com/sinameraji/kimiflare/commit/e510cb9994c4f480e17db0b24bcf75dbf604dc73)), closes [#322](https://github.com/sinameraji/kimiflare/issues/322)

## [0.48.1](https://github.com/sinameraji/kimiflare/compare/v0.48.0...v0.48.1) (2026-05-07)


### Bug Fixes

* **ui:** restore slash command output display and remove deprecated commands ([#335](https://github.com/sinameraji/kimiflare/issues/335)) ([4f03673](https://github.com/sinameraji/kimiflare/commit/4f0367394a26c05d91d0d53c6899383b039dc3a0))

## [0.48.0](https://github.com/sinameraji/kimiflare/compare/v0.47.0...v0.48.0) (2026-05-07)


### Features

* **session:** checkpoints, reliability fixes, and redesigned resume picker ([#328](https://github.com/sinameraji/kimiflare/issues/328)) ([52e7bf7](https://github.com/sinameraji/kimiflare/commit/52e7bf7d4063175746a38751b4da85629d86fbbd))
* **ui:** clean up status bar density ([#333](https://github.com/sinameraji/kimiflare/issues/333)) ([e7da31d](https://github.com/sinameraji/kimiflare/commit/e7da31d888e8d89d0e84fc7f7831c1064124f4d1))
* **ui:** smart welcome greetings, recent files boost, and task celebration ([#329](https://github.com/sinameraji/kimiflare/issues/329)) ([cc3caa6](https://github.com/sinameraji/kimiflare/commit/cc3caa66e1d230f9750c73cafa6f3bfd216c0e60))

## [0.47.0](https://github.com/sinameraji/kimiflare/compare/v0.46.0...v0.47.0) (2026-05-07)


### Features

* **agent:** add context-window guardrails and fix /clear memory leak ([#322](https://github.com/sinameraji/kimiflare/issues/322)) ([f8d2e5c](https://github.com/sinameraji/kimiflare/commit/f8d2e5cd435416e841150dbc755cc0bb88daa600))
* **ui:** differentiate spinner animations across the TUI ([#326](https://github.com/sinameraji/kimiflare/issues/326)) ([3917f64](https://github.com/sinameraji/kimiflare/commit/3917f64a02b07b9603943de76a3398d653f82d3e))


### Bug Fixes

* **ui:** strip trailing blank blocks from markdown output ([#325](https://github.com/sinameraji/kimiflare/issues/325)) ([e2fbbec](https://github.com/sinameraji/kimiflare/commit/e2fbbec287751f564ff3bb32bb8434f8f54094db))

## [0.46.0](https://github.com/sinameraji/kimiflare/compare/v0.45.0...v0.46.0) (2026-05-07)


### Features

* **cloud:** graceful quota-exhausted message in TUI ([#321](https://github.com/sinameraji/kimiflare/issues/321)) ([e7c26f1](https://github.com/sinameraji/kimiflare/commit/e7c26f15142d3ffd38f41c11864fe42a42e613b4))
* turn supervisor architecture with graceful preemption and visual cleanup ([#323](https://github.com/sinameraji/kimiflare/issues/323)) ([c25bff2](https://github.com/sinameraji/kimiflare/commit/c25bff217f0455714d2533a8e54d66276158797e))

## [0.45.0](https://github.com/sinameraji/kimiflare/compare/v0.44.0...v0.45.0) (2026-05-07)


### Features

* **tools:** add web search, GitHub read-only, and headless browser tools ([#319](https://github.com/sinameraji/kimiflare/issues/319)) ([8740cc9](https://github.com/sinameraji/kimiflare/commit/8740cc913a645ea80bb99f38afe3d39204203af9))
* **ui:** add cross-background contrast report for themes ([#317](https://github.com/sinameraji/kimiflare/issues/317)) ([60b1482](https://github.com/sinameraji/kimiflare/commit/60b148253213d45010c03fa4472e8bb3ba6809b1))
* **ui:** fuzzy matching for @ file picker ([#315](https://github.com/sinameraji/kimiflare/issues/315)) ([09f60ad](https://github.com/sinameraji/kimiflare/commit/09f60ad074218662d4dbd590a91ead5fac9f9070))
* **ui:** humanize system logs with tier-aware storytelling ([#318](https://github.com/sinameraji/kimiflare/issues/318)) ([638f34d](https://github.com/sinameraji/kimiflare/commit/638f34d45a3c51ccc99285eb666ce1c72417009c))


### Bug Fixes

* **ui:** preserve original list numbers in markdown rendering ([#320](https://github.com/sinameraji/kimiflare/issues/320)) ([0acfee2](https://github.com/sinameraji/kimiflare/commit/0acfee268b2559b93f3bca14c7547dc310afb6c6))

## [0.44.0](https://github.com/sinameraji/kimiflare/compare/v0.43.0...v0.44.0) (2026-05-06)


### Features

* **ui:** show current git branch in status bar ([#311](https://github.com/sinameraji/kimiflare/issues/311)) ([df69ebe](https://github.com/sinameraji/kimiflare/commit/df69ebe5a868d95b788471f7f618857906d2a716))
* **ui:** show mode-cycle tip in status bar ([#309](https://github.com/sinameraji/kimiflare/issues/309)) ([1f067f8](https://github.com/sinameraji/kimiflare/commit/1f067f8f98f5321b01b416af47682f112fef51bf))


### Bug Fixes

* **ui:** restore tool-card visibility in plan mode ([#312](https://github.com/sinameraji/kimiflare/issues/312)) ([c14f022](https://github.com/sinameraji/kimiflare/commit/c14f022f5183c150dec4a5f39055f71b89809ed0))

## [0.43.0](https://github.com/sinameraji/kimiflare/compare/v0.42.0...v0.43.0) (2026-05-06)


### Features

* **skills:** implement tiered skill routing with TUI visibility ([#298](https://github.com/sinameraji/kimiflare/issues/298)) ([809e06e](https://github.com/sinameraji/kimiflare/commit/809e06ee7757dd37285853756ffa3ef922ea5e9c))


### Bug Fixes

* **ui:** hide Cloudflare billing link in cloud mode ([#307](https://github.com/sinameraji/kimiflare/issues/307)) ([4f9b93f](https://github.com/sinameraji/kimiflare/commit/4f9b93f05a63c2f1b81ad7607c664820b87973f3))

## [0.42.0](https://github.com/sinameraji/kimiflare/compare/v0.41.0...v0.42.0) (2026-05-06)


### Features

* **ui:** extensible JSON themes with WCAG contrast validation ([#302](https://github.com/sinameraji/kimiflare/issues/302)) ([bced1f7](https://github.com/sinameraji/kimiflare/commit/bced1f7b18b46e601f93911fdf242b390a54b22c))
* **ui:** improve progress visibility during agent turns ([#299](https://github.com/sinameraji/kimiflare/issues/299)) ([7c4f44e](https://github.com/sinameraji/kimiflare/commit/7c4f44e18b4b291a0dbace34b64d193f49349c25))

## [0.41.0](https://github.com/sinameraji/kimiflare/compare/v0.40.0...v0.41.0) (2026-05-06)


### Features

* KIMI.md drift detection with memory-based staleness indicators ([#303](https://github.com/sinameraji/kimiflare/issues/303)) ([052b46c](https://github.com/sinameraji/kimiflare/commit/052b46c614fae8d3a30bd3fc4e9741ab987bdef6))

## [0.40.0](https://github.com/sinameraji/kimiflare/compare/v0.39.1...v0.40.0) (2026-05-06)


### Features

* **ui:** narrative activity layer, plan-mode suppression, and interruption cleanup ([#300](https://github.com/sinameraji/kimiflare/issues/300)) ([085d2ea](https://github.com/sinameraji/kimiflare/commit/085d2eabf4dbd9667783fa1d1228223493ea7bba))

## [0.39.1](https://github.com/sinameraji/kimiflare/compare/v0.39.0...v0.39.1) (2026-05-06)


### Bug Fixes

* **app:** update /hello feedback worker URL to hello.kimiflare.com ([#292](https://github.com/sinameraji/kimiflare/issues/292)) ([376eaed](https://github.com/sinameraji/kimiflare/commit/376eaed67ab64b54502d2fd5116df92729178da1))
* **build:** remove logMemory import and calls ([#297](https://github.com/sinameraji/kimiflare/issues/297)) ([ef5b22c](https://github.com/sinameraji/kimiflare/commit/ef5b22caf65eeaed30028949cafd428eb47aae92))
* **ui:** remove live theme preview to prevent memory leak ([#296](https://github.com/sinameraji/kimiflare/issues/296)) ([2980dc9](https://github.com/sinameraji/kimiflare/commit/2980dc98c6550d0a392b3772bdf82fd25ba5e266))

## [0.39.0](https://github.com/sinameraji/kimiflare/compare/v0.38.1...v0.39.0) (2026-05-06)


### Features

* **auth:** update CLI auth URL for generic portal ([#290](https://github.com/sinameraji/kimiflare/issues/290)) ([48fa8e1](https://github.com/sinameraji/kimiflare/commit/48fa8e140a38a61fdb794bc56c44f573e1fbe73a))

## [0.38.1](https://github.com/sinameraji/kimiflare/compare/v0.38.0...v0.38.1) (2026-05-06)


### Bug Fixes

* make isolated-vm optional with fallback warning ([#288](https://github.com/sinameraji/kimiflare/issues/288)) ([fc1b562](https://github.com/sinameraji/kimiflare/commit/fc1b5623e8b02c41063c5003bc4e0cb9573374b1))

## [0.38.0](https://github.com/sinameraji/kimiflare/compare/v0.37.0...v0.38.0) (2026-05-06)


### Features

* **cloud:** client-side usage fallback reporting ([#286](https://github.com/sinameraji/kimiflare/issues/286)) ([38448e5](https://github.com/sinameraji/kimiflare/commit/38448e5ff60094107bf8509af3802d81c4aaae50))

## [0.37.0](https://github.com/sinameraji/kimiflare/compare/v0.36.2...v0.37.0) (2026-05-05)


### Features

* **cloud:** refresh token budget in real time after each turn ([#284](https://github.com/sinameraji/kimiflare/issues/284)) ([957671c](https://github.com/sinameraji/kimiflare/commit/957671c01ab45d93ded4369f95d3d278a924dbb6))

## [0.36.2](https://github.com/sinameraji/kimiflare/compare/v0.36.1...v0.36.2) (2026-05-05)


### Bug Fixes

* **cloud:** bind JWT to CLI device ID instead of browser fingerprint ([#282](https://github.com/sinameraji/kimiflare/issues/282)) ([da2d977](https://github.com/sinameraji/kimiflare/commit/da2d9772d2f26704a9fef6e6093552f049ed9fb6))

## [0.36.1](https://github.com/sinameraji/kimiflare/compare/v0.36.0...v0.36.1) (2026-05-05)


### Bug Fixes

* **cloud:** use cloudToken state instead of stale prop in runAgentTurn ([#280](https://github.com/sinameraji/kimiflare/issues/280)) ([983dbd1](https://github.com/sinameraji/kimiflare/commit/983dbd162a03966ccefd2284f2fb38c6e93b7402))
* **cloud:** validate fetchCloudUsage response to prevent crash on undefined remaining ([#279](https://github.com/sinameraji/kimiflare/issues/279)) ([f232e7c](https://github.com/sinameraji/kimiflare/commit/f232e7c4bc24fef95e4e898706c3c6864b75ba5d))

## [0.36.0](https://github.com/sinameraji/kimiflare/compare/v0.35.0...v0.36.0) (2026-05-05)


### Features

* add GitHub Sponsors funding configuration ([#275](https://github.com/sinameraji/kimiflare/issues/275)) ([9c0ad43](https://github.com/sinameraji/kimiflare/commit/9c0ad439e0a83edf053fce5d601f326faa971c7e))
* **init:** structured context generation with project-type detection ([#273](https://github.com/sinameraji/kimiflare/issues/273)) ([11c4d7a](https://github.com/sinameraji/kimiflare/commit/11c4d7a3c1591b12b4117879d4d93ecdd023a7be))
* inline cloud auth in onboarding + strikethrough cost display ([#276](https://github.com/sinameraji/kimiflare/issues/276)) ([5c0ef78](https://github.com/sinameraji/kimiflare/commit/5c0ef78a087750e7e36617e8810795e4ecd54247))
* interactive modal when tool-call limit is reached ([#277](https://github.com/sinameraji/kimiflare/issues/277)) ([5247572](https://github.com/sinameraji/kimiflare/commit/5247572aaf18814394dc3279fa162ee2f4ba1277))


### Bug Fixes

* handle Escape abort gracefully and prevent crashes ([#278](https://github.com/sinameraji/kimiflare/issues/278)) ([71e509f](https://github.com/sinameraji/kimiflare/commit/71e509f8828ff3183898fff5531043a09d975b8e)), closes [#276](https://github.com/sinameraji/kimiflare/issues/276)

## [0.35.0](https://github.com/sinameraji/kimiflare/compare/v0.34.1...v0.35.0) (2026-05-05)


### Features

* add Kimiflare Cloud mode with device auth and API proxy ([#272](https://github.com/sinameraji/kimiflare/issues/272)) ([ae86eb0](https://github.com/sinameraji/kimiflare/commit/ae86eb0c01b98d080ad82ae1e0b6082c4ddcf17c))


### Bug Fixes

* **code-mode:** use typescript compiler when available for transpilation ([#270](https://github.com/sinameraji/kimiflare/issues/270)) ([febf38a](https://github.com/sinameraji/kimiflare/commit/febf38a681a99e82c53fabe8da79f0040001949a))

## [0.34.1](https://github.com/sinameraji/kimiflare/compare/v0.34.0...v0.34.1) (2026-05-05)


### Bug Fixes

* **memory:** supersession + LLM-synthesized edit events ([#267](https://github.com/sinameraji/kimiflare/issues/267)) ([298fa8b](https://github.com/sinameraji/kimiflare/commit/298fa8b1536c0913c53f317bff31bc9e88b9f3a0))
* remove hardcoded 200k input token budget from code mode ([#268](https://github.com/sinameraji/kimiflare/issues/268)) ([b90c995](https://github.com/sinameraji/kimiflare/commit/b90c9954c1ed619e7d4dc77ff747896154142621))

## [0.34.0](https://github.com/sinameraji/kimiflare/compare/v0.33.0...v0.34.0) (2026-05-05)


### Features

* add Zed Agent Panel (ACP) integration ([#262](https://github.com/sinameraji/kimiflare/issues/262)) ([8e61752](https://github.com/sinameraji/kimiflare/commit/8e61752f0e6b72836df725333bf27ff421df1cec))
* auto-enable Code Mode for heavy tasks (Phase 4) ([#252](https://github.com/sinameraji/kimiflare/issues/252)) ([631fb36](https://github.com/sinameraji/kimiflare/commit/631fb36ade69e2ca8d4532a3d9a3e44a5a63a322))
* implement phase five — parallel research agents ([#253](https://github.com/sinameraji/kimiflare/issues/253)) ([4ab70a2](https://github.com/sinameraji/kimiflare/commit/4ab70a2542fa64a940be709facb8ddc74e92aa88))
* Phase 3 — intent classification + telemetry ([#250](https://github.com/sinameraji/kimiflare/issues/250)) ([c706b9c](https://github.com/sinameraji/kimiflare/commit/c706b9c8f44de157f46321b0554e768570d7da40))
* **remote:** Phase 1 MVP — end-to-end /remote command ([#254](https://github.com/sinameraji/kimiflare/issues/254)) ([ad11946](https://github.com/sinameraji/kimiflare/commit/ad11946dacae069f6681664170556bebdb927943))
* **remote:** Phase 2 — Resilience & Polish ([#255](https://github.com/sinameraji/kimiflare/issues/255)) ([3c53d32](https://github.com/sinameraji/kimiflare/commit/3c53d3233a9b4b6a99e32a2762baa700ae3d677d))


### Bug Fixes

* equip heavy explorer mode with missing superpowers (auto-compact, budget, continue-on-limit) ([#266](https://github.com/sinameraji/kimiflare/issues/266)) ([8508ee0](https://github.com/sinameraji/kimiflare/commit/8508ee02e75fc87b7c4dc7f6c4935708da39f233))
* parallel research cost bugs ([#257](https://github.com/sinameraji/kimiflare/issues/257)) ([7d31a87](https://github.com/sinameraji/kimiflare/commit/7d31a87c55a7cd2cfc7542c92404bf066c3f2efa))
* **research:** prevent empty scout questions from breaking worker ([#260](https://github.com/sinameraji/kimiflare/issues/260)) ([c82d50b](https://github.com/sinameraji/kimiflare/commit/c82d50b56bf9f1c963b94f28a21cbd0d961fe10c))
* **research:** prevent false convergence and empty synthesis output ([#259](https://github.com/sinameraji/kimiflare/issues/259)) ([873157c](https://github.com/sinameraji/kimiflare/commit/873157c2cddb4c49fd80fc86fabb3ad87ca18d8d))
* **research:** remove parallel research system, route heavy explore to normal agent ([#265](https://github.com/sinameraji/kimiflare/issues/265)) ([8de4c5f](https://github.com/sinameraji/kimiflare/commit/8de4c5f05c24b7c20ea498509563f5fb69570aa9))
* scope /resume to current project directory ([#256](https://github.com/sinameraji/kimiflare/issues/256)) ([31ec123](https://github.com/sinameraji/kimiflare/commit/31ec123d5401e67e59e45d67f73cc6cb5a20738d))

## [0.33.0](https://github.com/sinameraji/kimiflare/compare/v0.32.0...v0.33.0) (2026-05-03)


### Features

* Phase 1 — /init refresh mode ([#247](https://github.com/sinameraji/kimiflare/issues/247)) ([0cbda83](https://github.com/sinameraji/kimiflare/commit/0cbda83c7784067e3b5c995932e1f2893294c797))
* Phase 2 — memory auto-extraction from tool results ([#248](https://github.com/sinameraji/kimiflare/issues/248)) ([fbd8add](https://github.com/sinameraji/kimiflare/commit/fbd8addb81217740df96987bebd4c6d96cf250bd))
* **remote:** Phase 0 — core loop changes for headless remote execution ([#246](https://github.com/sinameraji/kimiflare/issues/246)) ([ff6407b](https://github.com/sinameraji/kimiflare/commit/ff6407b3ec779d97d699aa947ef48890929b32b6))


### Bug Fixes

* enable filePicker by default in app.tsx ([#244](https://github.com/sinameraji/kimiflare/issues/244)) ([5e327cf](https://github.com/sinameraji/kimiflare/commit/5e327cfc9286a0726363db5d79df7c7d13275f47))

## [0.32.0](https://github.com/sinameraji/kimiflare/compare/v0.31.0...v0.32.0) (2026-05-03)


### Features

* add theme picker with 4-color palette ([#242](https://github.com/sinameraji/kimiflare/issues/242)) ([ddd1c30](https://github.com/sinameraji/kimiflare/commit/ddd1c3068202b6bd3799238018ac6e87f856c4a0))
* enable filePicker by default ([#230](https://github.com/sinameraji/kimiflare/issues/230)) ([ab2fb32](https://github.com/sinameraji/kimiflare/commit/ab2fb32946953830681b0fcb3eed11f0a99437c1))
* remove theme system ([#240](https://github.com/sinameraji/kimiflare/issues/240)) ([ff2705f](https://github.com/sinameraji/kimiflare/commit/ff2705f8e572b5e96fd415b857d7b796e3dec2e9))


### Bug Fixes

* **cost:** show big-picture week breakdown in ongoing TUI sessions ([#234](https://github.com/sinameraji/kimiflare/issues/234)) ([63e90f4](https://github.com/sinameraji/kimiflare/commit/63e90f4d09251109521f9529e8bdcf5c598c2b02)), closes [#230](https://github.com/sinameraji/kimiflare/issues/230)
* slash picker Enter selects and runs command immediately ([#239](https://github.com/sinameraji/kimiflare/issues/239)) ([05c4550](https://github.com/sinameraji/kimiflare/commit/05c4550587062c44c26b18cc7abc9bce831858cf))
* stream formatted markdown instead of raw text ([#238](https://github.com/sinameraji/kimiflare/issues/238)) ([7f96f7d](https://github.com/sinameraji/kimiflare/commit/7f96f7df1bf050d5a0b0b31e8b47e5efdb986396))


### Reverts

* remove multi-agent architecture and restore single agent ([#243](https://github.com/sinameraji/kimiflare/issues/243)) ([86e1c12](https://github.com/sinameraji/kimiflare/commit/86e1c12aa0c052a2e7d845e1288e153deba30420))

## [0.31.0](https://github.com/sinameraji/kimiflare/compare/v0.30.0...v0.31.0) (2026-05-01)


### Features

* / slash command picker with inline filtering and navigation ([#228](https://github.com/sinameraji/kimiflare/issues/228)) ([ac462fd](https://github.com/sinameraji/kimiflare/commit/ac462fd8b62107b781966d7b353ebd44c5936b66))
* **agents:** Coding Agent and General Agent personas ([#227](https://github.com/sinameraji/kimiflare/issues/227)) ([0a7346a](https://github.com/sinameraji/kimiflare/commit/0a7346ad6c54efe85664fce713200703a801b560))

## [0.30.0](https://github.com/sinameraji/kimiflare/compare/v0.29.1...v0.30.0) (2026-05-01)


### Features

* **research-agent:** deliverable-driven persona with hand_off, budget checks, and graceful pause ([#225](https://github.com/sinameraji/kimiflare/issues/225)) ([08fd777](https://github.com/sinameraji/kimiflare/commit/08fd77744092661579af5d2c3e4fa1d699d86f1f))

## [0.29.1](https://github.com/sinameraji/kimiflare/compare/v0.29.0...v0.29.1) (2026-05-01)


### Bug Fixes

* **multi-agent:** resume context loss, missing system messages, compact crash ([#223](https://github.com/sinameraji/kimiflare/issues/223)) ([77828bb](https://github.com/sinameraji/kimiflare/commit/77828bbe0204fe345df61bc766bf1a5f58fe8342))

## [0.29.0](https://github.com/sinameraji/kimiflare/compare/v0.28.0...v0.29.0) (2026-04-30)


### Features

* @ file mention picker with inline filtering and navigation ([#217](https://github.com/sinameraji/kimiflare/issues/217)) ([f2728c2](https://github.com/sinameraji/kimiflare/commit/f2728c248e7c04b0cf0480544d5de8d07d306c34))
* add automated PR guardrail review agent ([#215](https://github.com/sinameraji/kimiflare/issues/215)) ([8e709ca](https://github.com/sinameraji/kimiflare/commit/8e709ca01626d6f1410e23ffe4a06ff8ceb03a06))
* multi-agent system with specialized plan/build/general agents ([#220](https://github.com/sinameraji/kimiflare/issues/220)) ([1fe8c3c](https://github.com/sinameraji/kimiflare/commit/1fe8c3cfd99a6bdab5d12d12bd2d0472f526f14b))


### Reverts

* remove automated guardrail review agent ([#219](https://github.com/sinameraji/kimiflare/issues/219)) ([35ea7e0](https://github.com/sinameraji/kimiflare/commit/35ea7e037ec4a8b6e295793c37912fa5663aa87f))

## [0.28.0](https://github.com/sinameraji/kimiflare/compare/v0.27.0...v0.28.0) (2026-04-30)


### Features

* add stay-in-the-loop and shipping-fast sections to README ([#195](https://github.com/sinameraji/kimiflare/issues/195)) ([bb499f2](https://github.com/sinameraji/kimiflare/commit/bb499f25a4ac4e8ae98221a1e17fb73b8eb913c5))
* cost attribution by task type ([#196](https://github.com/sinameraji/kimiflare/issues/196)) ([#207](https://github.com/sinameraji/kimiflare/issues/207)) ([43d24d0](https://github.com/sinameraji/kimiflare/commit/43d24d0ed8119c806b2946309870c9b489655db1))
* interrupt current turn with Ctrl+C or Escape without exiting session ([#208](https://github.com/sinameraji/kimiflare/issues/208)) ([3667b2e](https://github.com/sinameraji/kimiflare/commit/3667b2ed646793eb6f693181a486efa1e4ace9de))
* **landing:** redesign with email capture, changelog, Cloudflare Pages ([ae7aaa2](https://github.com/sinameraji/kimiflare/commit/ae7aaa2ad190315f6aab7ae44b69c1e5ae497d1e))
* **landing:** redesign with email capture, changelog, discord, cloudflare pages ([7384d48](https://github.com/sinameraji/kimiflare/commit/7384d487644ee040f6e9769a80aafa93c767ea57))


### Bug Fixes

* avoid isolated-vm build failure in Pages deploy ([20b763e](https://github.com/sinameraji/kimiflare/commit/20b763e3562e2e6fa9ad045657bb059226a08246))
* avoid isolated-vm build failure in Pages deploy action ([7121e12](https://github.com/sinameraji/kimiflare/commit/7121e12ac0002103dfda85df18629cadcee1781e))
* prevent perf_hooks memory leak in long-running TUI sessions ([#211](https://github.com/sinameraji/kimiflare/issues/211)) ([ae8845c](https://github.com/sinameraji/kimiflare/commit/ae8845cc8141d3580bd23395368b350eecfa23fb))

## [0.27.0](https://github.com/sinameraji/kimiflare/compare/v0.26.1...v0.27.0) (2026-04-29)


### Features

* **lsp:** add interactive LSP server configuration wizard ([a060d45](https://github.com/sinameraji/kimiflare/commit/a060d456a8339da93549761fcbf69a305ec29849))
* **lsp:** auto-gitignore project config and add tests ([34acf05](https://github.com/sinameraji/kimiflare/commit/34acf050dcc7a68996f3ac755f7f036fc50ade89))
* **lsp:** auto-nudge when user references code files without LSP ([86736e7](https://github.com/sinameraji/kimiflare/commit/86736e74f5fc72ee823bcf0aee83aa1169855bdc))
* **lsp:** integrate Language Server Protocol for semantic code intelligence ([91fe95f](https://github.com/sinameraji/kimiflare/commit/91fe95f82d74950dd1f3cc87d4987f8d63093e8a))
* **lsp:** integrate Language Server Protocol for semantic code intelligence ([faa7e16](https://github.com/sinameraji/kimiflare/commit/faa7e164ecc89f3338b30a257c541204e2831e79))
* **lsp:** per-project LSP config with wizard scope selection ([e15416e](https://github.com/sinameraji/kimiflare/commit/e15416e36952006c756dc9ce83be9f47517728b0))
* security hardening for custom slash commands ([30a997e](https://github.com/sinameraji/kimiflare/commit/30a997e4260653ed04ace703e1ae57c927e9ac2f))
* security hardening for custom slash commands ([7b1c684](https://github.com/sinameraji/kimiflare/commit/7b1c684bb20768ee5e9de12fa44d3fc5a4a18260))


### Bug Fixes

* **lsp:** address PR review feedback ([d420970](https://github.com/sinameraji/kimiflare/commit/d42097046758c596c9c13a3fdcce496fa57c5f6b))
* **lsp:** mark already-configured presets in Add list ([e1ca073](https://github.com/sinameraji/kimiflare/commit/e1ca073accbdaea206e989c1645034f28297413c))
* **lsp:** remove conditional useMemo calls causing hooks-order crash ([3b610ce](https://github.com/sinameraji/kimiflare/commit/3b610cec0c0656a0b15ea5631b9d98d6eec94887))
* **lsp:** resolve yoga-layout crash and add reload feedback ([83f7bec](https://github.com/sinameraji/kimiflare/commit/83f7becb9af831f8eb137f3abcd7e1226e89e997))

## [0.26.1](https://github.com/sinameraji/kimiflare/compare/v0.26.0...v0.26.1) (2026-04-28)


### Bug Fixes

* **images:** preserve images on early turns and handle paths with spaces ([624a9d2](https://github.com/sinameraji/kimiflare/commit/624a9d2da193f0cb734a15fb6c703aabcd5951fc))
* **messages:** preserve images when user message count is below keepLastTurns threshold ([6c35f5d](https://github.com/sinameraji/kimiflare/commit/6c35f5dfbc6e68168df779ea0dc8e358b6a1639f))
* **plan-mode:** halt agent loop when blocked tool is called in plan mode ([122c86e](https://github.com/sinameraji/kimiflare/commit/122c86e74a1916ecce471423db56488164800101))
* **plan-mode:** halt agent loop when blocked tool is called in plan mode ([542cf43](https://github.com/sinameraji/kimiflare/commit/542cf43dd7d2dd758964c26a7f125a3b7289cd27))

## [0.26.0](https://github.com/sinameraji/kimiflare/compare/v0.25.0...v0.26.0) (2026-04-27)


### Features

* **code-mode:** deterministic TypeScript API generation + cache ([b78eac2](https://github.com/sinameraji/kimiflare/commit/b78eac2eaab54ae569b57bc7242ed18403b5c6d1))
* **code-mode:** deterministic TypeScript API generation + cache ([81ad1f2](https://github.com/sinameraji/kimiflare/commit/81ad1f29ff89f040b8eb73e085bdbf22cb3be35f))
* **commands:** interactive TUI for creating, editing, deleting and listing custom slash commands ([b522099](https://github.com/sinameraji/kimiflare/commit/b522099e28bba586f26779cd76d25ab05d63e8a5))
* **commands:** interactive TUI for custom slash commands ([4b27a04](https://github.com/sinameraji/kimiflare/commit/4b27a04d89b2521a04e58f2f3d725b229ac4791a))
* **commands:** side-by-side template guide in command wizard ([414521c](https://github.com/sinameraji/kimiflare/commit/414521c04a2bf6d867054eae74f7532966a78d68))
* memory polish and loop guardrails ([2d9dbf5](https://github.com/sinameraji/kimiflare/commit/2d9dbf596b81fa46e626ba25fa2bf6ad3d82768a))
* memory polish and loop guardrails ([500b26b](https://github.com/sinameraji/kimiflare/commit/500b26b381bb04c18341f4b3053304c13f436f5b))
* **memory:** session-start and compaction-time memory recall ([cb790f5](https://github.com/sinameraji/kimiflare/commit/cb790f586ba3ad5d7ae379038216b3875b3299ad))
* **memory:** session-start and compaction-time memory recall ([82623b2](https://github.com/sinameraji/kimiflare/commit/82623b2b0a06de72d8a3e5f093c3c695fd687931))
* **memory:** use Llama 4 Scout for plumbing tasks and deterministic topic keys ([1615e2a](https://github.com/sinameraji/kimiflare/commit/1615e2a9c04c520811292502eb100de3c44535bd))
* **memory:** use Llama 4 Scout for plumbing tasks and deterministic topic keys ([467f9a2](https://github.com/sinameraji/kimiflare/commit/467f9a2dbcff9381e7be1c6eba2d582a00d470c6))
* **session:** persist ArtifactStore across session resume ([75b6ece](https://github.com/sinameraji/kimiflare/commit/75b6ece914a2f51d4c9bb90291424a162044391e))
* **session:** persist ArtifactStore across session resume ([c58e86d](https://github.com/sinameraji/kimiflare/commit/c58e86d0a834c72f2ccb5187cfa251634eda259d))

## [0.25.0](https://github.com/sinameraji/kimiflare/compare/v0.24.0...v0.25.0) (2026-04-27)


### Features

* add /memory on and /memory off commands ([5617f68](https://github.com/sinameraji/kimiflare/commit/5617f68d2125b59076cf1b4c3458b00f12ba0466))
* add /memory on and /memory off commands ([a1a3cf3](https://github.com/sinameraji/kimiflare/commit/a1a3cf381f4919a4d2ebe15aa74def0addc92eaf))
* add interactive nested help menu ([6430153](https://github.com/sinameraji/kimiflare/commit/643015305753bd133fbcf9f4c059646562e4b336))
* **commands:** custom slash commands from markdown files ([0121692](https://github.com/sinameraji/kimiflare/commit/01216920df4ffcf250f458ed0df0b3ab3129a601))
* **commands:** custom slash commands from markdown files ([b36926e](https://github.com/sinameraji/kimiflare/commit/b36926ea7207506076e3bca30af00bb9cf5f24ac))
* make help menu interactive with executable commands and Escape navigation ([d2b75c6](https://github.com/sinameraji/kimiflare/commit/d2b75c60c7f80c761853e2804a832f1c136f4ce8))


### Bug Fixes

* auto-compact fallback, diff-friendly bash, tighter failure recall ([5b7984f](https://github.com/sinameraji/kimiflare/commit/5b7984fb7a71908544734ac10c7072ef8b259f0a))
* **compact:** auto-compact via LLM summarizer when compiled context is off ([c84810a](https://github.com/sinameraji/kimiflare/commit/c84810a53da8860c9217abad5e162c7bb39fae6b))
* **compaction:** tighten failure-keyword artifact recall ([9c1521f](https://github.com/sinameraji/kimiflare/commit/9c1521f5f9e09a03f8d630c7be44713789a3c9e2))
* **reducer:** bypass bash reducer for diff-style git commands ([92b2532](https://github.com/sinameraji/kimiflare/commit/92b2532f97e7bd18f385ac6793109eb583ce06a8))
* **status:** restore $ prefix on cost cell in right status bar ([88cfa35](https://github.com/sinameraji/kimiflare/commit/88cfa35f1e25aef6d38608e9ec24ca73fcd1d66a))
* **version:** correct package.json path when bundled ([b024232](https://github.com/sinameraji/kimiflare/commit/b02423234ac2c6e4ed44d12d3f1baebb4d2020ea))
* **version:** correct package.json path when bundled ([ac9dca0](https://github.com/sinameraji/kimiflare/commit/ac9dca00667776283fd20ae65e627fab67979a41))

## [0.24.0](https://github.com/sinameraji/kimiflare/compare/v0.23.0...v0.24.0) (2026-04-26)


### Features

* /hello voice note feedback ([b170496](https://github.com/sinameraji/kimiflare/commit/b17049693b6784239d0fe9cc20ce1b86dee3f0e1))
* add /hello voice note feedback to creator ([8e05b8f](https://github.com/sinameraji/kimiflare/commit/8e05b8f7ccf9ad6ff50ffb67f12dbf3e480b3ca6))
* allow plan mode to prompt for non-whitelisted bash commands ([8c2770d](https://github.com/sinameraji/kimiflare/commit/8c2770dfbe4645c8a8fd9b603c9c92b1795cf4d9))
* allow plan mode to prompt for non-whitelisted bash commands ([75b96c9](https://github.com/sinameraji/kimiflare/commit/75b96c9bc736b3674393b19885d5ac17c63d9e8b))
* **discord:** add /community command and welcome promotion ([c5a3e69](https://github.com/sinameraji/kimiflare/commit/c5a3e697c8e62e94c35245f6bf2763d08cb6a924))
* **feedback:** compact single-screen layout ([1a2f644](https://github.com/sinameraji/kimiflare/commit/1a2f64496194da619a4d5062a9c41391d70f81f0))
* **feedback:** improve visual design and contrast ([19378fd](https://github.com/sinameraji/kimiflare/commit/19378fd2f084aabdc38704b1f88da8b8b153cc22))
* **feedback:** redesign page to match landing page branding ([c05e756](https://github.com/sinameraji/kimiflare/commit/c05e7568cd94e0591b5f575ebcdc51f8cc413f4f))
* **feedback:** use real logo and inline success message ([011b5f1](https://github.com/sinameraji/kimiflare/commit/011b5f19ea5d37db4ff3271dab60972a8a9c5881))


### Bug Fixes

* /cost rendering, Static keys, and status bar token sync ([2050e9f](https://github.com/sinameraji/kimiflare/commit/2050e9fc2c1745b01df267eb1593cfc4f41677fe))
* /cost rendering, Static keys, and status bar token sync ([b7b0a05](https://github.com/sinameraji/kimiflare/commit/b7b0a057a5f2cf90fe73ed588b7e9aadfce193e5))
* /cost rendering, Static keys, and status bar token sync ([7c4042a](https://github.com/sinameraji/kimiflare/commit/7c4042aab02c0c43541f98aaf950f7c9acdd3996)), closes [#152](https://github.com/sinameraji/kimiflare/issues/152)
* **feedback:** add stop button and creator message ([7ecfa59](https://github.com/sinameraji/kimiflare/commit/7ecfa591856cfa7680e3b79b6a80c5597369a703))
* **feedback:** make copy first-person and more personal ([c705edd](https://github.com/sinameraji/kimiflare/commit/c705eddb79ef1815d1965f1e2e14ea81dfd298d1))
* **feedback:** simplify privacy line ([d20fc7e](https://github.com/sinameraji/kimiflare/commit/d20fc7e6d1ec78fd3ddaa3fe9e4889948b309845))
* **feedback:** update privacy copy on recording page ([d419ac6](https://github.com/sinameraji/kimiflare/commit/d419ac659b5aa569bf27c6753d114d64a17338e2))
* prevent co-author injection on git commands that only move HEAD ([2cc0a2f](https://github.com/sinameraji/kimiflare/commit/2cc0a2ff57aa1d26c07736d0be3c5bef7a818a5d))
* prevent co-author injection on git commands that only move HEAD ([0bde202](https://github.com/sinameraji/kimiflare/commit/0bde2026ab89269149a72ffd788205546eb3302b))
* **tui:** remove Static to fix missing user messages; fix plan mode && chains ([049671d](https://github.com/sinameraji/kimiflare/commit/049671d8014e3c6448f0febf21c0806174230412))
* **tui:** restore Static, raise event cap to 500, add visual compaction ([fd14c6d](https://github.com/sinameraji/kimiflare/commit/fd14c6da9de24de7aaa51d265420f0a242f57c4a))
* update feedback worker URL to deployed subdomain ([2af59a5](https://github.com/sinameraji/kimiflare/commit/2af59a587122df04b1eb90cf0aa3d4d9d3eb3a7f))

## [0.23.0](https://github.com/sinameraji/kimiflare/compare/v0.22.0...v0.23.0) (2026-04-26)


### Features

* agent-driven memory with tools, RRF retrieval, verification, and supersession ([12bab38](https://github.com/sinameraji/kimiflare/commit/12bab384321a7660603eed636390eaefe9ae20bf))
* Code Mode — Local TypeScript Sandbox ([fdb4ec2](https://github.com/sinameraji/kimiflare/commit/fdb4ec29af6d5767e8e65d89fdc891ceff237296))
* implement Code Mode — local TypeScript sandbox for tool execution ([2ee4d2a](https://github.com/sinameraji/kimiflare/commit/2ee4d2a226eabba8ab21f2f8bdd23afe2c5c0111)), closes [#146](https://github.com/sinameraji/kimiflare/issues/146)
* Local Structured Agent Memory — SQLite + Embeddings for Cross-Session Context ([956eba8](https://github.com/sinameraji/kimiflare/commit/956eba834ebfb21b4a0d09c3e464e304bcf41bc7))
* Local Structured Agent Memory — SQLite + Embeddings for Cross-Session Context ([00ff896](https://github.com/sinameraji/kimiflare/commit/00ff896c2af77ae9fd0bb9c1427665df0f9ef211))


### Bug Fixes

* add /billable-usage to Cloudflare billing URL ([ebe48ed](https://github.com/sinameraji/kimiflare/commit/ebe48ed0391ac4eaa6f1521b4ad7c7fb8a5380c0))
* add /billable-usage to Cloudflare billing URL in welcome screen ([334711a](https://github.com/sinameraji/kimiflare/commit/334711ad3c2ef573282c2dee3ccf1f481d430913))
* allow pipes and && chains of read-only bash commands in plan mode ([16477be](https://github.com/sinameraji/kimiflare/commit/16477bec2a9e9121b772c6ff65ffabfa5c0f3487))
* allow pipes and && chains of read-only bash commands in plan mode ([2bc0576](https://github.com/sinameraji/kimiflare/commit/2bc05766eab643730f36220454d28f8d7fca9f4f))
* allow pipes and && chains of read-only bash commands in plan mode ([9327c2d](https://github.com/sinameraji/kimiflare/commit/9327c2df6a830b13e68baf8c8ae4a3aa88b8878f))
* bump CI and engines to Node 22 for isolated-vm compatibility ([e77ff30](https://github.com/sinameraji/kimiflare/commit/e77ff30893707ed079c1625e3cd573ab1f6bcfea))
* bump CI and engines to Node 22 for isolated-vm compatibility ([ec57339](https://github.com/sinameraji/kimiflare/commit/ec57339bb53922b339f069b1409385f4a11e801f))
* bump CI and engines to Node 22 for isolated-vm compatibility ([7fbd050](https://github.com/sinameraji/kimiflare/commit/7fbd05053ff7537a1b5a40d79ccfd778139d800d))
* bump CI and engines to Node 22 for isolated-vm compatibility ([43b4720](https://github.com/sinameraji/kimiflare/commit/43b472003cc7d98245f8225f5fa3decb1aaea942))
* show session-level cost and token totals in status bar and /cost command ([3de4cdb](https://github.com/sinameraji/kimiflare/commit/3de4cdb3d48ce918ebc4d2431cd435aa629d210f))
* show session-level cost and token totals in status bar and /cost command ([a7f928c](https://github.com/sinameraji/kimiflare/commit/a7f928cea24f4633c229ff698a8946fcae780df3))
* **tui:** cap Static events and fix task timer restart ([5f17089](https://github.com/sinameraji/kimiflare/commit/5f17089582c973c2bfaaa38df9203347d61cbff7))
* **tui:** cap Static events to prevent incremental rendering from hiding output; fix task timer restart ([c229bb2](https://github.com/sinameraji/kimiflare/commit/c229bb23bf6e751fe97d25abbcedf23e6bdfd632)), closes [#160](https://github.com/sinameraji/kimiflare/issues/160)


### Reverts

* remove intern's session-level token count work from status bar ([931aab7](https://github.com/sinameraji/kimiflare/commit/931aab7029db903378f2c6e6675b5285adc00f1e))

## [0.22.0](https://github.com/sinameraji/kimiflare/compare/v0.21.0...v0.22.0) (2026-04-26)


### Features

* /gateway slash command + model ID validation ([006b3ff](https://github.com/sinameraji/kimiflare/commit/006b3ffc49fafeff74514d02182f498b9b970194))
* add /gateway slash command and validate model IDs ([a012c27](https://github.com/sinameraji/kimiflare/commit/a012c271bc80f7d48b164adde26820cb58d33f97))
* add billing notice to README and terminal welcome screen ([5632b82](https://github.com/sinameraji/kimiflare/commit/5632b82264910555657493d8cef552e618f104c1))
* add billing notice to README and terminal welcome screen ([5cbe1d6](https://github.com/sinameraji/kimiflare/commit/5cbe1d626e369ee4bf1a1c3625517df0c7d77902))
* add billing notice to README and terminal welcome screen ([0918a7e](https://github.com/sinameraji/kimiflare/commit/0918a7e12e28002a5f6a707d82549539c520e965))
* add optional AI Gateway routing ([96ad68c](https://github.com/sinameraji/kimiflare/commit/96ad68cc562c3c5df06d21015cbd97ef216e9e60))
* add optional AI Gateway routing ([5b6ec67](https://github.com/sinameraji/kimiflare/commit/5b6ec6772f96b2e56de2a6a5e29e46ea6bb140a5))


### Bug Fixes

* **tui:** reduce flicker during streaming output ([4d3f543](https://github.com/sinameraji/kimiflare/commit/4d3f54304dc652a58f84cdfd242b87af4ec9aa4e))
* **tui:** reduce flicker during streaming output ([037002d](https://github.com/sinameraji/kimiflare/commit/037002d3100bde72755525acda0d5256bd595376))

## [0.21.0](https://github.com/sinameraji/kimiflare/compare/v0.20.3...v0.21.0) (2026-04-24)


### Features

* **agent:** send x-session-affinity header for prefix caching ([af04d7d](https://github.com/sinameraji/kimiflare/commit/af04d7d932148f935fba24641506d66f31863b9c))
* **agent:** send x-session-affinity header for prefix caching ([af04d7d](https://github.com/sinameraji/kimiflare/commit/af04d7d932148f935fba24641506d66f31863b9c))
* **agent:** send x-session-affinity header for prefix caching ([d4ad35f](https://github.com/sinameraji/kimiflare/commit/d4ad35f51498cfc1c352fffa7889e73011d12fb4))
* **agent:** send x-session-affinity header for prefix caching ([600c1b9](https://github.com/sinameraji/kimiflare/commit/600c1b96b3a6d2fc32784f0e85e0b061a67842d8))


### Bug Fixes

* configure release-please to use plain v tags ([764bd01](https://github.com/sinameraji/kimiflare/commit/764bd01d57038a5ddffb8835530e07b550d56b29))
* configure release-please to use plain v tags ([764bd01](https://github.com/sinameraji/kimiflare/commit/764bd01d57038a5ddffb8835530e07b550d56b29))
* configure release-please to use plain v tags ([86886f0](https://github.com/sinameraji/kimiflare/commit/86886f0b0fc725dd62a865acf77a620bdc186691))

## [0.20.3](https://github.com/sinameraji/kimiflare/compare/v0.18.0...v0.20.3) (2026-04-24)


### Bug Fixes

* manual release to sync stable version from 0.18.0 to 0.20.3 ([64f999d](https://github.com/sinameraji/kimiflare/commit/64f999d))

## [0.18.0](https://github.com/sinameraji/kimiflare/compare/v0.17.0...v0.18.0) (2026-04-24)


### Features

* strip reasoning_content from historical assistant messages ([63ca8aa](https://github.com/sinameraji/kimiflare/commit/63ca8aa6a4aad13861a9e0978d8dea94208e974f))
* strip reasoning_content from historical assistant messages ([d393964](https://github.com/sinameraji/kimiflare/commit/d39396420855935eb1dfb3a354eafbf077858df1)), closes [#94](https://github.com/sinameraji/kimiflare/issues/94)

## [0.17.0](https://github.com/sinameraji/kimiflare/compare/v0.16.0...v0.17.0) (2026-04-23)


### Features

* token-efficient tool result reducers with progressive disclosure ([1e42eb4](https://github.com/sinameraji/kimiflare/commit/1e42eb47104e019840e78338dba6016419491ea0))
* token-efficient tool result reducers with progressive disclosure ([0ce4bf8](https://github.com/sinameraji/kimiflare/commit/0ce4bf891d211a64ddaaa81e6d242857fa23d6a5))


### Bug Fixes

* lock down plan mode to strictly read-only bash commands ([d33c7cb](https://github.com/sinameraji/kimiflare/commit/d33c7cbc13e8b08d3280aa1fd3779f00225c5fdd))
* lock down plan mode to strictly read-only bash commands ([78b87fc](https://github.com/sinameraji/kimiflare/commit/78b87fc741723749700491fc5797e26dd4560f8b))
* show USD currency symbol in status bar cost display ([eb6e0ea](https://github.com/sinameraji/kimiflare/commit/eb6e0eacf2b426e1cf39c7226d2af840924e38d1))
* show USD currency symbol in status bar cost display ([80b43f2](https://github.com/sinameraji/kimiflare/commit/80b43f2360eeb8394794974c128e1bbf104ee059))
* show USD currency symbol in status bar cost display ([2378d8e](https://github.com/sinameraji/kimiflare/commit/2378d8e428472c2645d74f1a849412eb8f3b247c))

## [0.16.0](https://github.com/sinameraji/kimiflare/compare/v0.15.0...v0.16.0) (2026-04-23)


### Features

* compiled context architecture + storage cleanup ([88833f6](https://github.com/sinameraji/kimiflare/commit/88833f6d715b301420a28bf2dd3fd8d733fe1808))
* compiled context architecture + storage cleanup ([b323e80](https://github.com/sinameraji/kimiflare/commit/b323e80c27acc80a205f5b15a22f166d4e55e6c7))

## [0.15.0](https://github.com/sinameraji/kimiflare/compare/v0.14.0...v0.15.0) (2026-04-23)


### Features

* cache-stable prefix engineering + instrumentation ([8725816](https://github.com/sinameraji/kimiflare/commit/87258167a9401824ba8d1e8b40c27f19c5ab9262))
* cache-stable prefix engineering + instrumentation ([6b54723](https://github.com/sinameraji/kimiflare/commit/6b54723b9d80e6fe6d0cbf824dd0d52a7c38df0d))

## [0.14.0](https://github.com/sinameraji/kimiflare/compare/v0.13.7...v0.14.0) (2026-04-23)


### Features

* /cost command + cost debug logging ([1dcda71](https://github.com/sinameraji/kimiflare/commit/1dcda7185e926bdf85a4253907d24d9f9947e3df))
* add /cost command with session/today/month/all-time USD breakdown + cost debug logging ([77826a1](https://github.com/sinameraji/kimiflare/commit/77826a109afa11a12e39bfd1567eff4fdb6bd041))
* MCP server integration ([4660535](https://github.com/sinameraji/kimiflare/commit/46605351fec74a4f34ac572e83eac245c5a0b870))
* MCP server integration ([c5180df](https://github.com/sinameraji/kimiflare/commit/c5180df9a8ceefaddd94a512f8e5a52ca17f48a3))
* MCP server integration ([ad3ceee](https://github.com/sinameraji/kimiflare/commit/ad3ceeeed6bc820fdc64238fd97b98ba8d313cb6)), closes [#83](https://github.com/sinameraji/kimiflare/issues/83)


### Bug Fixes

* always show npm update instructions on /update ([7e491bf](https://github.com/sinameraji/kimiflare/commit/7e491bf15a6ec4877448898c06a48c6b322007de))
* brighten theme-picker hint text and add $ to cost display ([98476a1](https://github.com/sinameraji/kimiflare/commit/98476a110674c854487ff58ffaf3e35f1f458665))
* brighten theme-picker hint text and add $ to cost display ([1bc4616](https://github.com/sinameraji/kimiflare/commit/1bc4616a71b3630c921ebae4a2d84db0abed03a8))
* brighten theme-picker hint text and add $ to cost display ([d41487a](https://github.com/sinameraji/kimiflare/commit/d41487a9e74010e87ccb7406403ef906f1044b43))
* detect npm install correctly for update instructions ([0d6f479](https://github.com/sinameraji/kimiflare/commit/0d6f479e33d637389f9f9c5123601cb371ff2065))
* **ui:** memoize chat components to reduce flicker on large conversations ([342ea5b](https://github.com/sinameraji/kimiflare/commit/342ea5b415392031f7007b8fbde762655c0f9184))
* **ui:** memoize chat components to reduce flicker on large conversations ([c1df330](https://github.com/sinameraji/kimiflare/commit/c1df330e2c60b98590d9b13a73bcfd3bdd6d6f77))
* **ui:** memoize chat components to reduce flicker on large conversations ([7a01b2b](https://github.com/sinameraji/kimiflare/commit/7a01b2b801751a55e46307a35e394eb0801e0dd6))

## [0.13.7](https://github.com/sinameraji/kimiflare/compare/v0.13.6...v0.13.7) (2026-04-23)


### Bug Fixes

* **themes:** replace ANSI colors with truecolor hex and remove redundant themes ([86712a3](https://github.com/sinameraji/kimiflare/commit/86712a378c020472e4bc17d45e305c71d42b592a))
* **themes:** replace ANSI colors with truecolor hex and remove redundant themes ([539657a](https://github.com/sinameraji/kimiflare/commit/539657a31987edd7b6586e842360386d7a1c11d6))
* **themes:** replace ANSI colors with truecolor hex and remove redundant themes ([cb62898](https://github.com/sinameraji/kimiflare/commit/cb6289826223005189ec979cc0a2be3d6fee9eea))

## [0.13.6](https://github.com/sinameraji/kimiflare/compare/v0.13.5...v0.13.6) (2026-04-23)


### Reverts

* roll back memory-optimizations commit to isolate flashing bug ([1cd1bf7](https://github.com/sinameraji/kimiflare/commit/1cd1bf7b1d97cc0d39d1de63f3c400332ed1ca0a))

## [0.13.5](https://github.com/sinameraji/kimiflare/compare/v0.13.4...v0.13.5) (2026-04-23)


### Reverts

* roll ctrl+c interrupt work back to v0.12.0 behavior ([d10c104](https://github.com/sinameraji/kimiflare/commit/d10c104ba5ea0c834f4b0dd4559688585e8b62a5))

## [0.13.4](https://github.com/sinameraji/kimiflare/compare/v0.13.3...v0.13.4) (2026-04-23)


### Bug Fixes

* remove redundant global SIGINT handler causing screen flashing ([d332484](https://github.com/sinameraji/kimiflare/commit/d3324848ede678e6efdde0c8bba1460098a54493))
* remove redundant global SIGINT handler causing screen flashing ([bf46eb8](https://github.com/sinameraji/kimiflare/commit/bf46eb8cdc851149b5ce33490f9eb163847d5179))

## [0.13.3](https://github.com/sinameraji/kimiflare/compare/v0.13.2...v0.13.3) (2026-04-22)


### Bug Fixes

* prevent Ctrl+C from hanging the app ([2c2e7e5](https://github.com/sinameraji/kimiflare/commit/2c2e7e56416f1a9388641c1ec7301aad71360c12))
* prevent Ctrl+C from hanging the app ([c6e9c1f](https://github.com/sinameraji/kimiflare/commit/c6e9c1fd90c1a8cc401c3f53236dc4bd7da0a294))

## [0.13.2](https://github.com/sinameraji/kimiflare/compare/v0.13.1...v0.13.2) (2026-04-22)


### Bug Fixes

* robust co-author injection for all git commit-creating commands ([8698d03](https://github.com/sinameraji/kimiflare/commit/8698d03bd206048600e4897b17ae3f8c4a0770f4))
* robust co-author injection for all git commit-creating commands ([9053488](https://github.com/sinameraji/kimiflare/commit/9053488f74a98aa82647c1045405c88a1eda4a8d))

## [0.13.1](https://github.com/sinameraji/kimiflare/compare/v0.13.0...v0.13.1) (2026-04-22)


### Bug Fixes

* reduce memory growth during long sessions ([510a5bb](https://github.com/sinameraji/kimiflare/commit/510a5bbff24a4319743dcfa5a4d052a581c98967))
* reduce memory growth during long sessions ([de840a6](https://github.com/sinameraji/kimiflare/commit/de840a6cfcf5edf620e79ab1b465407579068c00))

## [0.13.0](https://github.com/sinameraji/kimiflare/compare/v0.12.0...v0.13.0) (2026-04-22)


### Features

* ctrl+c interrupts current operation without exiting session ([6a3da50](https://github.com/sinameraji/kimiflare/commit/6a3da50d312e850a0c45de883db00cd810f8d89a))
* ctrl+c interrupts current operation without exiting session ([3307c8f](https://github.com/sinameraji/kimiflare/commit/3307c8f51da22b461c972af68ab0556d1d22f317))

## [0.12.0](https://github.com/sinameraji/kimiflare/compare/v0.11.0...v0.12.0) (2026-04-22)


### Features

* image understanding support ([cbf9810](https://github.com/sinameraji/kimiflare/commit/cbf9810d1abb3357f2a21a2b9dbe2edcaec82875))
* image understanding support ([14b917f](https://github.com/sinameraji/kimiflare/commit/14b917fae2657944dc67bb3ad348d49c47167dfd))

## [0.11.0](https://github.com/sinameraji/kimiflare/compare/v0.10.0...v0.11.0) (2026-04-22)


### Features

* polished README, landing page, and plan-mode bash support ([#59](https://github.com/sinameraji/kimiflare/issues/59)) ([0b9eedd](https://github.com/sinameraji/kimiflare/commit/0b9eedd2d6a932421e8c9bad2b28255327935e02))

## [0.10.0](https://github.com/sinameraji/kimiflare/compare/v0.9.2...v0.10.0) (2026-04-22)


### Features

* allow read-only bash commands in plan mode ([#54](https://github.com/sinameraji/kimiflare/issues/54)) ([0cf518a](https://github.com/sinameraji/kimiflare/commit/0cf518aed0866a7c7337000b7f9492636137d720))


### Bug Fixes

* **docs:** remove stray X placeholders from landing page buttons ([#57](https://github.com/sinameraji/kimiflare/issues/57)) ([45515d2](https://github.com/sinameraji/kimiflare/commit/45515d2d5ede1a2d657be2b30edabc15faeec93b))

## [0.9.2](https://github.com/sinameraji/kimiflare/compare/v0.9.1...v0.9.2) (2026-04-22)


### Bug Fixes

* validate tool_call arguments JSON to prevent 400 BadRequest loops ([#52](https://github.com/sinameraji/kimiflare/issues/52)) ([e234417](https://github.com/sinameraji/kimiflare/commit/e234417cc0999c3eddd4d8a17532bdecc7d4220e))

## [0.9.1](https://github.com/sinameraji/kimiflare/compare/v0.9.0...v0.9.1) (2026-04-22)


### Bug Fixes

* make events capping automatic for all setEvents calls ([59da63b](https://github.com/sinameraji/kimiflare/commit/59da63b9556af5ae2d19a8564a2d7366337dc896))
* prevent memory leaks from unbounded events and timer churn ([6d91b89](https://github.com/sinameraji/kimiflare/commit/6d91b897d21554c7508ffeffe026ee6ef8fd086b))
* prevent memory leaks from unbounded events and timer churn ([ba0195b](https://github.com/sinameraji/kimiflare/commit/ba0195b9eb9b5bf515859e91c355211752320d18))

## [0.9.0](https://github.com/sinameraji/kimiflare/compare/v0.8.2...v0.9.0) (2026-04-22)


### Features

* add logo, badges, and MIT license ([c4d27ee](https://github.com/sinameraji/kimiflare/commit/c4d27ee08cfde50192fdfd86c9f4251d737ef607))
* add logo, badges, and MIT license to README ([4dc3249](https://github.com/sinameraji/kimiflare/commit/4dc3249077fd12091b837a50ee7f624112a6e451))


### Bug Fixes

* update default co-author email to kimiflare@proton.me ([84400ce](https://github.com/sinameraji/kimiflare/commit/84400ceccf95e19fc9f42100265e94ef2a2f04c4))
* update default co-author email to kimiflare@proton.me ([abe96cc](https://github.com/sinameraji/kimiflare/commit/abe96cc7c8d46a7d5e92e0e195d08bde5a36be9d))
* use existing project logo instead of generated SVG ([d7ca1ce](https://github.com/sinameraji/kimiflare/commit/d7ca1ce60a66e0ab75dea2c47b338cb05fc188ef))
* use existing project logo instead of generated SVG ([2112085](https://github.com/sinameraji/kimiflare/commit/21120851b596481876716f8d61f4672d8728ba6e))

## [0.8.2](https://github.com/sinameraji/kimiflare/compare/v0.8.1...v0.8.2) (2026-04-22)


### Bug Fixes

* prevent theme picker from closing on arrow keys ([a0bac95](https://github.com/sinameraji/kimiflare/commit/a0bac95d55932e2defa0f2b87a2c677ef089bf56))
* prevent theme picker from closing on arrow keys ([fc115fe](https://github.com/sinameraji/kimiflare/commit/fc115fedfbc45eeeb2e057b5d8f5b012889e1c70))

## [0.8.1](https://github.com/sinameraji/kimiflare/compare/v0.8.0...v0.8.1) (2026-04-22)


### Bug Fixes

* stale update cache and double arrow in theme picker ([913c230](https://github.com/sinameraji/kimiflare/commit/913c2301f53c9a02628c111ebdc1ad50abdcd432))
* stale update cache and double arrow in theme picker ([4572494](https://github.com/sinameraji/kimiflare/commit/4572494c02077ce50aa0b413d22c7c48428ac5ab))

## [0.8.0](https://github.com/sinameraji/kimiflare/compare/v0.7.1...v0.8.0) (2026-04-22)


### Features

* paginate /resume picker and add interactive theme picker with live preview ([e1239a9](https://github.com/sinameraji/kimiflare/commit/e1239a9782b80990578b7663d0d31a8d0b516e6a))
* paginate /resume picker and add interactive theme picker with live preview ([878dd89](https://github.com/sinameraji/kimiflare/commit/878dd893ae6b5884896b97a28a366b3404677764))
* runtime update nudge on startup + periodic checks ([e423678](https://github.com/sinameraji/kimiflare/commit/e423678eba25201043eb25593cb75ef854382da3))
* runtime update nudge on startup + periodic checks ([b8a1c31](https://github.com/sinameraji/kimiflare/commit/b8a1c31353c5c7cadfcce17410fb71bdf10e987d))

## [0.7.1](https://github.com/sinameraji/kimiflare/compare/v0.7.0...v0.7.1) (2026-04-22)


### Bug Fixes

* sanitize lone surrogates and improve AI error handling ([9f7fa71](https://github.com/sinameraji/kimiflare/commit/9f7fa71faea31ec31f7ce5be00d3dee08843d884))
* sanitize lone surrogates and improve AI error handling ([7b0a87f](https://github.com/sinameraji/kimiflare/commit/7b0a87fba58b2a368b1b9525d76039b90ac46b38))

## [0.7.0](https://github.com/sinameraji/kimiflare/compare/v0.6.0...v0.7.0) (2026-04-22)


### Features

* **ui:** add progress animations and clearer idle/busy states ([d0c43ae](https://github.com/sinameraji/kimiflare/commit/d0c43ae7dbcf0df93e218e4793154aa48ff66b4a))
* **ui:** add progress animations and clearer idle/busy states ([c08cb29](https://github.com/sinameraji/kimiflare/commit/c08cb299e8cae0907ca6205effe8c4a601980703))


### Bug Fixes

* remove clear msg, proactive updates, paste cursor, compact logs ([4a27c0e](https://github.com/sinameraji/kimiflare/commit/4a27c0ec99a890db2830df58a53a9e4051393249))
* remove clear msg, proactive updates, paste cursor, compact logs ([4f6068f](https://github.com/sinameraji/kimiflare/commit/4f6068fca908f47af7ccf683f6b7d68ced538ef0))

## [0.6.0](https://github.com/sinameraji/kimiflare/compare/v0.5.0...v0.6.0) (2026-04-22)


### Features

* **docs:** add Product Hunt badge, favicon, and SEO meta tags ([9a924a7](https://github.com/sinameraji/kimiflare/commit/9a924a769819e6d694096dbf140a2f427bd9eefd))
* **docs:** add Product Hunt badge, favicon, and SEO meta tags ([7641b7e](https://github.com/sinameraji/kimiflare/commit/7641b7ede4679388415a5a5d45aa8de096fb1986))
* **docs:** remove Claude Code reference and subscription language from landing copy ([f2eef80](https://github.com/sinameraji/kimiflare/commit/f2eef8085bcfa6fc4ac6d2b34977f5b546617efd))
* **docs:** update landing page terminal and copy ([b86954a](https://github.com/sinameraji/kimiflare/commit/b86954af225ea4c0129251a5e7898c85ec9bb645))
* **docs:** update landing page terminal simulation to match current UI/UX ([9ddaad8](https://github.com/sinameraji/kimiflare/commit/9ddaad8a493dc5bb63bc3995303833b4c2f94d66))


### Bug Fixes

* use sinameraji@gmail.com as default co-author email ([f82a45b](https://github.com/sinameraji/kimiflare/commit/f82a45bfbe893ef49f52a035d3bebc58a9771776))
* use sinameraji@gmail.com as default co-author email ([2456bc8](https://github.com/sinameraji/kimiflare/commit/2456bc8528026ad0ff2a6b208a092456049e4f21))

## [0.5.0](https://github.com/sinameraji/kimiflare/compare/v0.4.1...v0.5.0) (2026-04-22)


### Features

* auto-append co-author trailer to git commits ([fd6caf2](https://github.com/sinameraji/kimiflare/commit/fd6caf23d3abf889ff432dfe54c54f1d0b03a220))
* auto-append co-author trailer to git commits ([efb3ff6](https://github.com/sinameraji/kimiflare/commit/efb3ff69e98b5ce15c385b5d0270a0d44dc13668))

## [0.4.1](https://github.com/sinameraji/kimiflare/compare/v0.4.0...v0.4.1) (2026-04-22)


### Bug Fixes

* **update-check:** walk up dirs to find package.json and .git ([4198ed8](https://github.com/sinameraji/kimiflare/commit/4198ed8cd03552865bc5b5e7b4533c5b80f3e68e))
* **update-check:** walk up dirs to find package.json and .git ([66f4627](https://github.com/sinameraji/kimiflare/commit/66f4627985514fa1b6900234a859a687b6de5121))

## [0.4.0](https://github.com/sinameraji/kimiflare/compare/v0.3.1...v0.4.0) (2026-04-22)


### Features

* clean up first-run UI, chat layout, and onboarding ([d5eb188](https://github.com/sinameraji/kimiflare/commit/d5eb188ddf099aa22ca14c0899ac92175a3ddaae))
* clean up first-run UI, chat layout, and onboarding ([0bf41ae](https://github.com/sinameraji/kimiflare/commit/0bf41ae5c1bdae51b7c77ce2bf7155e369ef0e91))


### Bug Fixes

* remove automatic update-check spam on startup ([6826cca](https://github.com/sinameraji/kimiflare/commit/6826cca07d530d30228fe59117016ac066c9081b))
* remove unused onSuggestion prop from Welcome component ([9aef3fb](https://github.com/sinameraji/kimiflare/commit/9aef3fbe9a9a1793e28a72a21e15892dacbddef0))
* remove unused prop + configure release-please for ui commits ([03def7c](https://github.com/sinameraji/kimiflare/commit/03def7cb62746fd914359246fc67235c99b30ba7))

## [0.3.1](https://github.com/sinameraji/kimiflare/compare/v0.3.0...v0.3.1) (2026-04-21)


### Bug Fixes

* --version reads from package.json (was hardcoded 0.1.0) ([78952a1](https://github.com/sinameraji/kimiflare/commit/78952a11a9ffc66b6193102535b1dd885a75f919))
* --version reads from package.json instead of hardcoded 0.1.0 ([9e38b33](https://github.com/sinameraji/kimiflare/commit/9e38b33aa31ff8730ba594e9935e66e400a36960))

## [0.3.0](https://github.com/sinameraji/kimiflare/compare/v0.2.0...v0.3.0) (2026-04-21)


### Features

* UI polish, /init + KIMI.md, release-please ([6f38ea7](https://github.com/sinameraji/kimiflare/commit/6f38ea7bd566bcab87b0820522ad74f032f269cd))
* UI polish, /init + KIMI.md, release-please ([3d1f2f4](https://github.com/sinameraji/kimiflare/commit/3d1f2f4810288ee67a8081cafe12f89ffe25f69a))


### Bug Fixes

* dark theme legibility on Terminal.app — drop dim attribute ([bdbab32](https://github.com/sinameraji/kimiflare/commit/bdbab323ca1f2e4ac4858ff9b7dd1234021ddc69))
* dark theme legibility on Terminal.app (0.2.1) ([186a488](https://github.com/sinameraji/kimiflare/commit/186a48878459bc33e5407dbfb74d1ee9b56371e1))
