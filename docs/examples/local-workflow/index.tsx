export default function Project() {
  return <stage id="stage" camera={[0.2,0,0,0.2,20,180]}>
    <scene id="demo" name="Local animation tools" width={1920} height={1080} fill="#111827" active>
      <sequence id="animation-clips">
        <video id="diagram" name="Manim diagram" src="assets/diagram.mp4" start={0} end={3} width={1920} height={1080} />
        <video id="title" name="HyperFrames title" src="assets/title.mp4" start={3} end={6} width={1920} height={1080} />
      </sequence>
    </scene>
  </stage>;
}
