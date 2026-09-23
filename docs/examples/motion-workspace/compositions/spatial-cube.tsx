export default function SpatialCube() {
  return (
    <group id="spatial-cube-1" name={"Another dimension"} width={1920} height={1080} end={6} expanded={true}>
      <rect id="spatial-cube-2" name={"Background"} width={1920} height={1080} fill={"#121824"} />
      <text id="spatial-cube-3" name={"Title"} x={128} y={268} fontSize={138} fontFamily={"Inter"} fontWeight={600} leading={1.05} letterSpacing={-5}>
        {"Another\ndimension."}
        <solidPaint id="spatial-cube-4" color={"#E5EAF1"} />
      </text>
      <text id="spatial-cube-5" name={"Caption"} x={135} y={656} fontSize={31} fontFamily={"Inter"} fontWeight={500}>
        {"Six faces. One composition."}
        <solidPaint id="spatial-cube-6" color={"#8999AF"} />
      </text>
      <group id="spatial-cube-7" name={"Cube"} x={1180} y={368} width={320} height={320} rotationX={-22} rotationY={30} rotation={-4} depthSort="camera" expanded={true}>
        <keyframeTrack id="spatial-cube-8" property={"rotationY"}>
          <keyframe id="spatial-cube-9" time={0} value={25} easing={"cubicBezier(0.45,0,0.55,1)"} />
          <keyframe id="spatial-cube-10" time={6} value={235} easing={"cubicBezier(0.22,1,0.36,1)"} />
        </keyframeTrack>
        <keyframeTrack id="spatial-cube-11" property={"rotationX"}>
          <keyframe id="spatial-cube-12" time={0} value={-22} easing={"cubicBezier(0.45,0,0.55,1)"} />
          <keyframe id="spatial-cube-13" time={6} value={-36} easing={"cubicBezier(0.22,1,0.36,1)"} />
        </keyframeTrack>
        <rect id="spatial-cube-14" name={"Back face"} z={-160} rotationY={180} fill={"#727B91"} width={320} height={320}>
          <stroke id="spatial-cube-15" width={2} color={"#DAE5F3"} opacity={0.5} />
        </rect>
        <rect id="spatial-cube-16" name={"Left face"} x={-160} rotationY={-90} fill={"#BAC5D8"} width={320} height={320}>
          <stroke id="spatial-cube-17" width={2} color={"#DAE5F3"} opacity={0.5} />
        </rect>
        <rect id="spatial-cube-18" name={"Right face"} x={160} rotationY={90} fill={"#7488A9"} width={320} height={320}>
          <stroke id="spatial-cube-19" width={2} color={"#DAE5F3"} opacity={0.5} />
        </rect>
        <rect id="spatial-cube-20" name={"Top face"} y={-160} rotationX={90} fill={"#DCE5F0"} width={320} height={320}>
          <stroke id="spatial-cube-21" width={2} color={"#DAE5F3"} opacity={0.5} />
        </rect>
        <rect id="spatial-cube-22" name={"Bottom face"} y={160} rotationX={-90} fill={"#566681"} width={320} height={320}>
          <stroke id="spatial-cube-23" width={2} color={"#DAE5F3"} opacity={0.5} />
        </rect>
        <rect id="spatial-cube-24" name={"Front face"} z={160} fill={"#A4B8D0"} width={320} height={320}>
          <stroke id="spatial-cube-25" width={2} color={"#DAE5F3"} opacity={0.5} />
        </rect>
      </group>
    </group>
  );
}
