# Finding moments in audio

Frameyard's default local mode does not provide [`media_listen`](../../reference/tools/media/listen.md).
It requires Diffusion Studio's hosted analysis service. Use the local tools to
inspect a recording instead:

```sh
dapi media transcribe /absolute/path/to/interview.mp4 --output /absolute/path/to/transcript.json
dapi media waveform /absolute/path/to/interview.mp4
```

The transcript has word-level times. Search its text for a phrase, then listen
to that part in the editor and check the surrounding silence against the
waveform. `dapi media grab` gives you frames at chosen times when the recording
also has video. These tools work without a hosted account after local setup.

In a separately configured hosted build, `media_listen` can answer questions
about an audio track. Ask for timestamps relative to the analyzed segment so
you can check each answer against the source. It uploads audio to the hosted
service and may incur account charges.
