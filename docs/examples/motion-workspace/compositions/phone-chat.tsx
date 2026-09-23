export default function PhoneChat() {
  return (
    <group id="phone-chat-1" name={"Phone & chat"} width={1920} height={1080} end={6} expanded={true}>
      <rect id="phone-chat-2" name={"Background"} width={1920} height={1080} fill={"#F3F3F0"} />
      <text id="phone-chat-3" name={"Headline first line"} x={130} y={330} fontSize={100} fontFamily={"Inter"} fontWeight={600}>
        {"Conversations"}
        <solidPaint id="phone-chat-4" color={"#20242B"} />
      </text>
      <text id="phone-chat-5" name={"Headline second line"} x={130} y={445} fontSize={100} fontFamily={"Inter"} fontWeight={600}>
        {"with depth."}
        <solidPaint id="phone-chat-6" color={"#20242B"} />
      </text>
      <text id="phone-chat-7" name={"Caption"} x={136} y={614} fontSize={30} fontFamily={"Inter"} fontWeight={500}>
        {"Make room for the little details."}
        <solidPaint id="phone-chat-8" color={"#697078"} />
      </text>
      <group id="phone-chat-9" name={"Phone"} x={1180} y={122} width={420} height={820} rotationX={8} rotationY={-24} rotation={6} expanded={true}>
        <keyframeTrack id="phone-chat-10" property={"rotationY"}>
          <keyframe id="phone-chat-11" time={0} value={-32} easing={"cubicBezier(0.22,1,0.36,1)"} />
          <keyframe id="phone-chat-12" time={2} value={-24} easing={"cubicBezier(0.22,1,0.36,1)"} />
          <keyframe id="phone-chat-13" time={6} value={-8} easing={"cubicBezier(0.22,1,0.36,1)"} />
        </keyframeTrack>
        <keyframeTrack id="phone-chat-14" property={"rotationX"}>
          <keyframe id="phone-chat-15" time={0} value={12} easing={"cubicBezier(0.22,1,0.36,1)"} />
          <keyframe id="phone-chat-16" time={6} value={4} easing={"cubicBezier(0.22,1,0.36,1)"} />
        </keyframeTrack>
        <rect id="phone-chat-17" name={"Phone frame"} width={420} height={820} cornerRadius={58} fill={"#30333B"}>
          <shadow id="phone-chat-18" color={"#1C2545"} opacity={0.25} blur={70} offsetY={18} />
        </rect>
        <rect id="phone-chat-19" name={"Screen"} x={12} y={12} width={396} height={796} cornerRadius={48} fill={"#FAFAFA"} z={3} />
        <rect id="phone-chat-20" name={"Camera island"} x={142} y={25} width={136} height={33} cornerRadius={18} fill={"#181B20"} z={5} />
        <text id="phone-chat-21" name={"Screen title"} x={40} y={95} fontSize={36} fontFamily={"Inter"} fontWeight={600} z={6}>
          {"Messages"}
          <solidPaint id="phone-chat-22" color={"#242832"} />
        </text>
        <text id="phone-chat-23" name={"Screen date"} x={42} y={151} fontSize={13} fontFamily={"Inter"} fontWeight={500} z={6} letterSpacing={2}>
          {"TODAY"}
          <solidPaint id="phone-chat-24" color={"#959CA7"} />
        </text>
        <group id="phone-chat-25" name={"Message from Maya 1"} x={29} y={211} width={362} height={111} z={8}>
          <keyframeTrack id="phone-chat-26" property={"z"}>
            <keyframe id="phone-chat-27" time={0} value={8} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-28" time={0.8} value={8} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-29" time={2.1} value={60} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-30" time={5.6} value={8} easing={"cubicBezier(0.22,1,0.36,1)"} />
          </keyframeTrack>
          <keyframeTrack id="phone-chat-31" property={"x"}>
            <keyframe id="phone-chat-32" time={0} value={29} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-33" time={2.2} value={6} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-34" time={5.6} value={29} easing={"cubicBezier(0.22,1,0.36,1)"} />
          </keyframeTrack>
          <rect id="phone-chat-35" name={"Message surface"} width={362} height={111} cornerRadius={24} fill={"#FFFFFF"}>
            <shadow id="phone-chat-36" color={"#2F3D60"} opacity={0.125} blur={20} offsetY={18} />
          </rect>
          <ellipse id="phone-chat-37" name={"Avatar"} x={19} y={22} width={41} height={41} fill={"#BDDACE"} />
          <text id="phone-chat-38" name={"Sender"} x={78} y={18} fontSize={18} fontFamily={"Inter"} fontWeight={600}>
            {"Maya"}
            <solidPaint id="phone-chat-39" color={"#303642"} />
          </text>
          <text id="phone-chat-40" name={"Message text"} x={78} y={48} fontSize={16} fontFamily={"Inter"} fontWeight={500}>
            {"Ready when you are."}
            <solidPaint id="phone-chat-41" color={"#697180"} />
          </text>
          <text id="phone-chat-42" name={"Timestamp"} x={303} y={20} fontSize={11} fontFamily={"Inter"} fontWeight={500}>
            {"Now"}
            <solidPaint id="phone-chat-43" color={"#9BA2AD"} />
          </text>
        </group>
        <group id="phone-chat-44" name={"Message from You 2"} x={29} y={350} width={362} height={111} z={8}>
          <keyframeTrack id="phone-chat-45" property={"z"}>
            <keyframe id="phone-chat-46" time={0} value={8} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-47" time={0.9500000000000001} value={8} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-48" time={2.25} value={90} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-49" time={5.6} value={8} easing={"cubicBezier(0.22,1,0.36,1)"} />
          </keyframeTrack>
          <keyframeTrack id="phone-chat-50" property={"x"}>
            <keyframe id="phone-chat-51" time={0} value={29} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-52" time={2.35} value={-16} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-53" time={5.6} value={29} easing={"cubicBezier(0.22,1,0.36,1)"} />
          </keyframeTrack>
          <rect id="phone-chat-54" name={"Message surface"} width={362} height={111} cornerRadius={24} fill={"#FFFFFF"}>
            <shadow id="phone-chat-55" color={"#2F3D60"} opacity={0.125} blur={20} offsetY={18} />
          </rect>
          <ellipse id="phone-chat-56" name={"Avatar"} x={19} y={22} width={41} height={41} fill={"#C9D6FF"} />
          <text id="phone-chat-57" name={"Sender"} x={78} y={18} fontSize={18} fontFamily={"Inter"} fontWeight={600}>
            {"You"}
            <solidPaint id="phone-chat-58" color={"#303642"} />
          </text>
          <text id="phone-chat-59" name={"Message text"} x={78} y={48} fontSize={16} fontFamily={"Inter"} fontWeight={500}>
            {"Let's make it move."}
            <solidPaint id="phone-chat-60" color={"#697180"} />
          </text>
          <text id="phone-chat-61" name={"Timestamp"} x={303} y={20} fontSize={11} fontFamily={"Inter"} fontWeight={500}>
            {"Now"}
            <solidPaint id="phone-chat-62" color={"#9BA2AD"} />
          </text>
        </group>
        <group id="phone-chat-63" name={"Message from Maya 3"} x={29} y={489} width={362} height={111} z={8}>
          <keyframeTrack id="phone-chat-64" property={"z"}>
            <keyframe id="phone-chat-65" time={0} value={8} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-66" time={1.1} value={8} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-67" time={2.4} value={120} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-68" time={5.6} value={8} easing={"cubicBezier(0.22,1,0.36,1)"} />
          </keyframeTrack>
          <keyframeTrack id="phone-chat-69" property={"x"}>
            <keyframe id="phone-chat-70" time={0} value={29} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-71" time={2.5} value={-38} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="phone-chat-72" time={5.6} value={29} easing={"cubicBezier(0.22,1,0.36,1)"} />
          </keyframeTrack>
          <rect id="phone-chat-73" name={"Message surface"} width={362} height={111} cornerRadius={24} fill={"#FFFFFF"}>
            <shadow id="phone-chat-74" color={"#2F3D60"} opacity={0.125} blur={20} offsetY={18} />
          </rect>
          <ellipse id="phone-chat-75" name={"Avatar"} x={19} y={22} width={41} height={41} fill={"#FFD6C4"} />
          <text id="phone-chat-76" name={"Sender"} x={78} y={18} fontSize={18} fontFamily={"Inter"} fontWeight={600}>
            {"Maya"}
            <solidPaint id="phone-chat-77" color={"#303642"} />
          </text>
          <text id="phone-chat-78" name={"Message text"} x={78} y={48} fontSize={16} fontFamily={"Inter"} fontWeight={500}>
            {"Every detail is yours."}
            <solidPaint id="phone-chat-79" color={"#697180"} />
          </text>
          <text id="phone-chat-80" name={"Timestamp"} x={303} y={20} fontSize={11} fontFamily={"Inter"} fontWeight={500}>
            {"Now"}
            <solidPaint id="phone-chat-81" color={"#9BA2AD"} />
          </text>
        </group>
        <rect id="phone-chat-82" name={"Compose field"} x={31} y={705} width={358} height={48} cornerRadius={24} fill={"#EDEEF2"} z={5} />
        <text id="phone-chat-83" name={"Compose placeholder"} x={54} y={718} fontSize={15} fontFamily={"Inter"} fontWeight={500} z={7}>
          {"Write a message"}
          <solidPaint id="phone-chat-84" color={"#989DA8"} />
        </text>
        <rect id="phone-chat-85" name={"Home indicator"} x={142} y={780} width={136} height={5} cornerRadius={3} fill={"#24262C"} z={6} />
      </group>
    </group>
  );
}
