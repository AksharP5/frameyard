export default function GrowthChart() {
  return (
    <group id="growth-chart-1" name={"Growth chart"} width={1920} height={1080} end={6} expanded={true}>
      <rect id="growth-chart-2" name={"Background"} width={1920} height={1080} fill={"#101A16"} />
      <text id="growth-chart-3" name={"Metric"} x={155} y={104} fontSize={170} fontFamily={"Inter"} fontWeight={600} letterSpacing={-6}>
        {"43,715"}
        <solidPaint id="growth-chart-4" color={"#F0F4EC"} />
      </text>
      <text id="growth-chart-5" name={"Metric description"} x={166} y={310} fontSize={33} fontFamily={"Inter"} fontWeight={500}>
        {"Good things take shape."}
        <solidPaint id="growth-chart-6" color={"#A1B2A5"} />
      </text>
      <group id="growth-chart-7" name={"Chart"} x={173} y={430} width={1500} height={480} expanded={true}>
        <rect id="growth-chart-8" name={"Grid line 1"} y={0} width={1440} height={1} fill={"#26392D"} />
        <rect id="growth-chart-9" name={"Grid line 2"} y={200} width={1440} height={1} fill={"#26392D"} />
        <rect id="growth-chart-10" name={"Grid line 3"} y={400} width={1440} height={1} fill={"#26392D"} />
        <path id="growth-chart-11" name={"Series A"} d={"M 0 400 L 160 400 L 320 400 L 480 400 L 640 400 L 800 400 L 960 400 L 1120 400 L 1280 400 L 1440 400"} width={1440} height={430}>
          <stroke id="growth-chart-12" color={"#72D9A7"} width={7} cap={"round"} join={"round"} />
          <keyframeTrack id="growth-chart-13" property={"d"}>
            <keyframe id="growth-chart-14" time={0.4} value={"M 0 400 L 160 400 L 320 400 L 480 400 L 640 400 L 800 400 L 960 400 L 1120 400 L 1280 400 L 1440 400"} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="growth-chart-15" time={2.3} value={"M 0 388 L 160 355 L 320 330 L 480 268 L 640 281 L 800 200 L 960 158 L 1120 185 L 1280 82 L 1440 12"} easing={"cubicBezier(0.22,1,0.36,1)"} />
          </keyframeTrack>
        </path>
        <path id="growth-chart-16" name={"Series B"} d={"M 0 400 L 160 400 L 320 400 L 480 400 L 640 400 L 800 400 L 960 400 L 1120 400 L 1280 400 L 1440 400"} width={1440} height={430}>
          <stroke id="growth-chart-17" color={"#90B7DD"} width={7} cap={"round"} join={"round"} />
          <keyframeTrack id="growth-chart-18" property={"d"}>
            <keyframe id="growth-chart-19" time={0.7} value={"M 0 400 L 160 400 L 320 400 L 480 400 L 640 400 L 800 400 L 960 400 L 1120 400 L 1280 400 L 1440 400"} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="growth-chart-20" time={2.5999999999999996} value={"M 0 405 L 160 389 L 320 365 L 480 370 L 640 326 L 800 310 L 960 295 L 1120 227 L 1280 216 L 1440 171"} easing={"cubicBezier(0.22,1,0.36,1)"} />
          </keyframeTrack>
        </path>
        <text id="growth-chart-21" name={"Start label"} x={0} y={458} fontSize={22} fontFamily={"Inter"} fontWeight={500}>
          {"Day 1"}
          <solidPaint id="growth-chart-22" color={"#819887"} />
        </text>
        <text id="growth-chart-23" name={"End label"} x={1370} y={458} fontSize={22} fontFamily={"Inter"} fontWeight={500}>
          {"Day 30"}
          <solidPaint id="growth-chart-24" color={"#819887"} />
        </text>
      </group>
      <ellipse id="growth-chart-25" name={"Series A legend marker"} x={173} y={990} width={18} height={18} fill={"#72D9A7"} />
      <text id="growth-chart-26" name={"Series A legend"} x={207} y={983} fontSize={24} fontFamily={"Inter"} fontWeight={500}>
        {"First idea"}
        <solidPaint id="growth-chart-27" color={"#B4C5B9"} />
      </text>
      <ellipse id="growth-chart-28" name={"Series B legend marker"} x={432} y={990} width={18} height={18} fill={"#90B7DD"} />
      <text id="growth-chart-29" name={"Series B legend"} x={466} y={983} fontSize={24} fontFamily={"Inter"} fontWeight={500}>
        {"Next iteration"}
        <solidPaint id="growth-chart-30" color={"#B4C5B9"} />
      </text>
    </group>
  );
}
