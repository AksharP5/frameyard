export default function GeometryStudy() {
  return (
    <group id="geometry-study-1" name={"Geometry study"} width={1920} height={1080} end={6} expanded={true}>
      <rect id="geometry-study-2" name={"Background"} width={1920} height={1080} fill={"#F3F0E9"} />
      <text id="geometry-study-3" name={"Title"} x={135} y={105} fontSize={106} fontFamily={"Inter"} fontWeight={600} letterSpacing={-4}>
        {"A little change."}
        <solidPaint id="geometry-study-4" color={"#272922"} />
      </text>
      <text id="geometry-study-5" name={"Equation"} x={141} y={248} fontSize={44} fontFamily={"Inter"} fontWeight={500}>
        {"y = sin(x)"}
        <solidPaint id="geometry-study-6" color={"#8D6550"} />
      </text>
      <group id="geometry-study-7" name={"Coordinate plane"} x={370} y={395} width={1130} height={520} expanded={true}>
        <rect id="geometry-study-8" name={"Vertical guide 1"} x={0} width={1} height={500} fill={"#DCD7CE"} />
        <rect id="geometry-study-9" name={"Vertical guide 2"} x={180} width={1} height={500} fill={"#DCD7CE"} />
        <rect id="geometry-study-10" name={"Vertical guide 3"} x={360} width={1} height={500} fill={"#DCD7CE"} />
        <rect id="geometry-study-11" name={"Vertical guide 4"} x={540} width={1} height={500} fill={"#DCD7CE"} />
        <rect id="geometry-study-12" name={"Vertical guide 5"} x={720} width={1} height={500} fill={"#DCD7CE"} />
        <rect id="geometry-study-13" name={"Vertical guide 6"} x={900} width={1} height={500} fill={"#DCD7CE"} />
        <rect id="geometry-study-14" name={"Vertical guide 7"} x={1080} width={1} height={500} fill={"#DCD7CE"} />
        <rect id="geometry-study-15" name={"Horizontal guide 1"} y={70} width={1104} height={1} fill={"#DCD7CE"} />
        <rect id="geometry-study-16" name={"Horizontal guide 2"} y={250} width={1104} height={1} fill={"#DCD7CE"} />
        <rect id="geometry-study-17" name={"Horizontal guide 3"} y={430} width={1104} height={1} fill={"#DCD7CE"} />
        <path id="geometry-study-18" name={"Axes"} d={"M 0 0 L 0 500 M 0 250 L 1130 250"} width={1130} height={500}>
          <stroke id="geometry-study-19" color={"#99938A"} width={3} />
        </path>
        <path id="geometry-study-20" name={"Sine curve"} d={"M 0 250 L 46 203.41257188154628 L 92 160 L 138 122.72077938642146 L 184 94.11542731880104 L 230 76.1333512679677 L 276 70 L 322 76.1333512679677 L 368 94.11542731880104 L 414 122.72077938642144 L 460 160 L 506 203.41257188154623 L 552 249.99999999999997 L 598 296.58742811845366 L 644 340 L 690 377.27922061357856 L 736 405.88457268119896 L 782 423.86664873203233 L 828 430 L 874 423.86664873203233 L 920 405.88457268119896 L 966 377.27922061357856 L 1012 340.0000000000001 L 1058 296.5874281184537 L 1104 250.00000000000006"} width={1104} height={500}>
          <stroke id="geometry-study-21" color={"#BA7554"} width={6} cap={"round"} join={"round"} />
          <keyframeTrack id="geometry-study-22" property={"opacity"}>
            <keyframe id="geometry-study-23" time={0} value={0} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="geometry-study-24" time={1.2} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
          </keyframeTrack>
        </path>
        <ellipse id="geometry-study-25" name={"Moving point"} x={-13} y={237} width={26} height={26} fill={"#644635"}>
          <keyframeTrack id="geometry-study-26" property={"x"}>
            <keyframe id="geometry-study-27" time={0.7} value={-13} easing={"linear"} />
            <keyframe id="geometry-study-28" time={0.8916666666666666} value={33} easing={"linear"} />
            <keyframe id="geometry-study-29" time={1.0833333333333333} value={79} easing={"linear"} />
            <keyframe id="geometry-study-30" time={1.275} value={125} easing={"linear"} />
            <keyframe id="geometry-study-31" time={1.4666666666666666} value={171} easing={"linear"} />
            <keyframe id="geometry-study-32" time={1.6583333333333332} value={217} easing={"linear"} />
            <keyframe id="geometry-study-33" time={1.8499999999999999} value={263} easing={"linear"} />
            <keyframe id="geometry-study-34" time={2.0416666666666665} value={309} easing={"linear"} />
            <keyframe id="geometry-study-35" time={2.2333333333333334} value={355} easing={"linear"} />
            <keyframe id="geometry-study-36" time={2.425} value={401} easing={"linear"} />
            <keyframe id="geometry-study-37" time={2.6166666666666663} value={447} easing={"linear"} />
            <keyframe id="geometry-study-38" time={2.8083333333333327} value={493} easing={"linear"} />
            <keyframe id="geometry-study-39" time={3} value={539} easing={"linear"} />
            <keyframe id="geometry-study-40" time={3.1916666666666664} value={585} easing={"linear"} />
            <keyframe id="geometry-study-41" time={3.383333333333333} value={631} easing={"linear"} />
            <keyframe id="geometry-study-42" time={3.575} value={677} easing={"linear"} />
            <keyframe id="geometry-study-43" time={3.7666666666666666} value={723} easing={"linear"} />
            <keyframe id="geometry-study-44" time={3.958333333333333} value={769} easing={"linear"} />
            <keyframe id="geometry-study-45" time={4.1499999999999995} value={815} easing={"linear"} />
            <keyframe id="geometry-study-46" time={4.341666666666666} value={861} easing={"linear"} />
            <keyframe id="geometry-study-47" time={4.533333333333333} value={907} easing={"linear"} />
            <keyframe id="geometry-study-48" time={4.725} value={953} easing={"linear"} />
            <keyframe id="geometry-study-49" time={4.916666666666666} value={999} easing={"linear"} />
            <keyframe id="geometry-study-50" time={5.108333333333333} value={1045} easing={"linear"} />
            <keyframe id="geometry-study-51" time={5.3} value={1091} easing={"linear"} />
          </keyframeTrack>
          <keyframeTrack id="geometry-study-52" property={"y"}>
            <keyframe id="geometry-study-53" time={0.7} value={237} easing={"linear"} />
            <keyframe id="geometry-study-54" time={0.8916666666666666} value={190.41257188154628} easing={"linear"} />
            <keyframe id="geometry-study-55" time={1.0833333333333333} value={147} easing={"linear"} />
            <keyframe id="geometry-study-56" time={1.275} value={109.72077938642146} easing={"linear"} />
            <keyframe id="geometry-study-57" time={1.4666666666666666} value={81.11542731880104} easing={"linear"} />
            <keyframe id="geometry-study-58" time={1.6583333333333332} value={63.1333512679677} easing={"linear"} />
            <keyframe id="geometry-study-59" time={1.8499999999999999} value={57} easing={"linear"} />
            <keyframe id="geometry-study-60" time={2.0416666666666665} value={63.1333512679677} easing={"linear"} />
            <keyframe id="geometry-study-61" time={2.2333333333333334} value={81.11542731880104} easing={"linear"} />
            <keyframe id="geometry-study-62" time={2.425} value={109.72077938642144} easing={"linear"} />
            <keyframe id="geometry-study-63" time={2.6166666666666663} value={147} easing={"linear"} />
            <keyframe id="geometry-study-64" time={2.8083333333333327} value={190.41257188154623} easing={"linear"} />
            <keyframe id="geometry-study-65" time={3} value={236.99999999999997} easing={"linear"} />
            <keyframe id="geometry-study-66" time={3.1916666666666664} value={283.58742811845366} easing={"linear"} />
            <keyframe id="geometry-study-67" time={3.383333333333333} value={327} easing={"linear"} />
            <keyframe id="geometry-study-68" time={3.575} value={364.27922061357856} easing={"linear"} />
            <keyframe id="geometry-study-69" time={3.7666666666666666} value={392.88457268119896} easing={"linear"} />
            <keyframe id="geometry-study-70" time={3.958333333333333} value={410.86664873203233} easing={"linear"} />
            <keyframe id="geometry-study-71" time={4.1499999999999995} value={417} easing={"linear"} />
            <keyframe id="geometry-study-72" time={4.341666666666666} value={410.86664873203233} easing={"linear"} />
            <keyframe id="geometry-study-73" time={4.533333333333333} value={392.88457268119896} easing={"linear"} />
            <keyframe id="geometry-study-74" time={4.725} value={364.27922061357856} easing={"linear"} />
            <keyframe id="geometry-study-75" time={4.916666666666666} value={327.0000000000001} easing={"linear"} />
            <keyframe id="geometry-study-76" time={5.108333333333333} value={283.5874281184537} easing={"linear"} />
            <keyframe id="geometry-study-77" time={5.3} value={237.00000000000006} easing={"linear"} />
          </keyframeTrack>
        </ellipse>
        <text id="geometry-study-78" name={"X axis label"} x={1150} y={231} fontSize={30} fontFamily={"Inter"} fontWeight={500}>
          {"x"}
          <solidPaint id="geometry-study-79" color={"#77736C"} />
        </text>
        <text id="geometry-study-80" name={"Y axis label"} x={-13} y={-51} fontSize={30} fontFamily={"Inter"} fontWeight={500}>
          {"y"}
          <solidPaint id="geometry-study-81" color={"#77736C"} />
        </text>
      </group>
    </group>
  );
}
