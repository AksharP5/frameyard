# Dependency patches

`koota+0.6.6.patch` fixes queries combining static OR traits.

The two Mediabunny 1.50.6 patches fix AAC encoder priming in MP4/MOV exports. The WASM worker returns FFmpeg packet PTS, including negative priming timestamps, but the extension replaces them with input timestamps. That moved decoded audio forward by 1,024 samples (21.33 ms at 48 kHz).

Frameyard opts into original packet timestamps through `onEncoderConfig` with `frameyardPreservePacketTimestamps`. The flag only affects the WASM AAC extension; native encoding ignores this extra dictionary field. Other containers keep the extension's existing timestamp behavior. The muxer accepts negative AAC timestamps only for nonfragmented MP4/MOV and represents them with an edit list that skips priming. Positive input offsets retain the existing empty edit. No priming length is hardcoded.

These are local fixes, not an upstream backport. Upstream's [AAC encoder source](https://github.com/Vanilagy/mediabunny/blob/main/packages/aac-encoder/src/encoder.ts) still replaced packet PTS when checked on September 15, 2026. Recheck timestamp and edit-list support before upgrading either dependency. The patches include source and the ESM/CommonJS entry points used by this repository; standalone minified bundles are not used or patched.

Run `node --test apps/cli/test/audio-export-timing.test.ts` with FFmpeg available. It encodes PCM impulses with the actual WASM extension and checks decoded timing at 44.1/48 kHz, including delayed inputs and the default extension contract.
