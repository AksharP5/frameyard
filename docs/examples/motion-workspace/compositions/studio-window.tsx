export default function StudioWindow() {
  return (
    <group id="studio-window-1" name={"Studio launch"} width={1920} height={1080} end={6} expanded={true}>
      <rect id="studio-window-2" name={"Background"} width={1920} height={1080} fill={"#F7F6F3"} />
      <text id="studio-window-3" name={"Title"} x={115} y={142} fontSize={174} fontFamily={"Inter"} fontWeight={600} letterSpacing={-7} leading={0.98}>
        {"Your next\nbig idea."}
        <solidPaint id="studio-window-4" color={"#242830"} />
      </text>
      <text id="studio-window-5" name={"Subtitle"} x={130} y={638} fontSize={33} fontFamily={"Inter"} fontWeight={500}>
        {"Built one layer at a time."}
        <solidPaint id="studio-window-6" color={"#85888E"} />
      </text>
      <group id="studio-window-7" name={"Studio window"} x={866} y={264} width={884} height={588} rotationY={-13} rotationX={5} expanded={true}>
        <keyframeTrack id="studio-window-8" property={"offsetY"}>
          <keyframe id="studio-window-9" time={0} value={140} easing={"cubicBezier(0.22,1,0.36,1)"} />
          <keyframe id="studio-window-10" time={1.7} value={0} easing={"cubicBezier(0.22,1,0.36,1)"} />
        </keyframeTrack>
        <keyframeTrack id="studio-window-11" property={"rotationY"}>
          <keyframe id="studio-window-12" time={0} value={-22} easing={"cubicBezier(0.22,1,0.36,1)"} />
          <keyframe id="studio-window-13" time={5.5} value={-5} easing={"cubicBezier(0.22,1,0.36,1)"} />
        </keyframeTrack>
        <rect id="studio-window-14" name={"Window surface"} width={884} height={588} cornerRadius={23} fill={"#FFFFFF"}>
          <shadow id="studio-window-15" color={"#8593DB"} opacity={0.31} blur={80} offsetY={18} />
        </rect>
        <rect id="studio-window-16" name={"Sidebar surface"} x={1} y={56} width={202} height={509} fill={"#F6F7FA"} cornerRadius={10} z={1} />
        <ellipse id="studio-window-17" name={"Window control 1"} x={23} y={21} width={11} height={11} fill={"#DE8D87"} z={2} />
        <ellipse id="studio-window-18" name={"Window control 2"} x={47} y={21} width={11} height={11} fill={"#DFC488"} z={2} />
        <ellipse id="studio-window-19" name={"Window control 3"} x={71} y={21} width={11} height={11} fill={"#9ABE9F"} z={2} />
        <text id="studio-window-20" name={"Window title"} x={338} y={14} fontSize={17} fontFamily={"Inter"} fontWeight={500} z={2}>
          {"Motion Studio"}
          <solidPaint id="studio-window-21" color={"#7F8491"} />
        </text>
        <text id="studio-window-22" name={"Sidebar title"} x={26} y={86} fontSize={18} fontFamily={"Inter"} fontWeight={600} z={3}>
          {"Layers"}
          <solidPaint id="studio-window-23" color={"#353D4B"} />
        </text>
        <text id="studio-window-24" name={"Layer label 1"} x={36} y={144} fontSize={15} fontFamily={"Inter"} fontWeight={500} z={3}>
          {"Opening"}
          <solidPaint id="studio-window-25" color={"#7E8593"} />
        </text>
        <text id="studio-window-26" name={"Layer label 2"} x={36} y={193} fontSize={15} fontFamily={"Inter"} fontWeight={500} z={3}>
          {"Headline"}
          <solidPaint id="studio-window-27" color={"#7E8593"} />
        </text>
        <text id="studio-window-28" name={"Layer label 3"} x={36} y={242} fontSize={15} fontFamily={"Inter"} fontWeight={500} z={3}>
          {"Composition"}
          <solidPaint id="studio-window-29" color={"#7E8593"} />
        </text>
        <text id="studio-window-30" name={"Layer label 4"} x={36} y={291} fontSize={15} fontFamily={"Inter"} fontWeight={500} z={3}>
          {"Sound"}
          <solidPaint id="studio-window-31" color={"#7E8593"} />
        </text>
        <text id="studio-window-32" name={"Layer label 5"} x={36} y={340} fontSize={15} fontFamily={"Inter"} fontWeight={500} z={3}>
          {"Closing"}
          <solidPaint id="studio-window-33" color={"#7E8593"} />
        </text>
        <rect id="studio-window-34" name={"Canvas"} x={226} y={81} width={632} height={302} cornerRadius={13} fill={"#EAEFFA"} z={2} />
        <text id="studio-window-35" name={"Canvas title"} x={275} y={194} fontSize={57} fontFamily={"Inter"} fontWeight={600} z={4} letterSpacing={-2}>
          {"Make it yours."}
          <solidPaint id="studio-window-36" color={"#43567D"} />
        </text>
        <group id="studio-window-37" name={"Sound clip"} x={237} y={420} width={600} height={100} z={14}>
          <rect id="studio-window-38" name={"Clip surface"} width={600} height={100} cornerRadius={13} fill={"#F5E5E1"} />
          <rect id="studio-window-39" name={"Waveform bar 1"} x={21} y={42.5} width={6} height={15} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-40" property={"scaleY"}>
              <keyframe id="studio-window-41" time={0.7} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-42" time={1.6} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-43" name={"Waveform bar 2"} x={41} y={24.804969650310834} width={6} height={50.39006069937833} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-44" property={"scaleY"}>
              <keyframe id="studio-window-45" time={0.725} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-46" time={1.625} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-47" name={"Waveform bar 3"} x={61} y={18.410979528925946} width={6} height={63.17804094214811} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-48" property={"scaleY"}>
              <keyframe id="studio-window-49" time={0.75} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-50" time={1.6500000000000001} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-51" name={"Waveform bar 4"} x={81} y={25.537327090010447} width={6} height={48.92534581997911} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-52" property={"scaleY"}>
              <keyframe id="studio-window-53" time={0.7749999999999999} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-54" time={1.675} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-55" name={"Waveform bar 5"} x={101} y={38.00015162032876} width={6} height={23.999696759342484} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-56" property={"scaleY"}>
              <keyframe id="studio-window-57" time={0.7999999999999999} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-58" time={1.7000000000000002} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-59" name={"Waveform bar 6"} x={121} y={40.31051963135293} width={6} height={19.37896073729414} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-60" property={"scaleY"}>
              <keyframe id="studio-window-61" time={0.825} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-62" time={1.725} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-63" name={"Waveform bar 7"} x={141} y={41.27827831410978} width={6} height={17.443443371780447} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-64" property={"scaleY"}>
              <keyframe id="studio-window-65" time={0.85} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-66" time={1.75} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-67" name={"Waveform bar 8"} x={161} y={33.71333588852974} width={6} height={32.573328222940525} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-68" property={"scaleY"}>
              <keyframe id="studio-window-69" time={0.875} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-70" time={1.7750000000000001} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-71" name={"Waveform bar 9"} x={181} y={32.5023615459189} width={6} height={34.9952769081622} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-72" property={"scaleY"}>
              <keyframe id="studio-window-73" time={0.8999999999999999} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-74" time={1.8} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-75" name={"Waveform bar 10"} x={201} y={42.1370938342262} width={6} height={15.725812331547596} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-76" property={"scaleY"}>
              <keyframe id="studio-window-77" time={0.9249999999999999} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-78" time={1.8250000000000002} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-79" name={"Waveform bar 11"} x={221} y={25.572046474964328} width={6} height={48.855907050071345} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-80" property={"scaleY"}>
              <keyframe id="studio-window-81" time={0.95} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-82" time={1.85} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-83" name={"Waveform bar 12"} x={241} y={14.750802217446463} width={6} height={70.49839556510707} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-84" property={"scaleY"}>
              <keyframe id="studio-window-85" time={0.975} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-86" time={1.875} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-87" name={"Waveform bar 13"} x={261} y={18.261768135379363} width={6} height={63.476463729241274} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-88" property={"scaleY"}>
              <keyframe id="studio-window-89" time={1} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-90" time={1.9000000000000001} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-91" name={"Waveform bar 14"} x={281} y={34.01590540979112} width={6} height={31.96818918041776} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-92" property={"scaleY"}>
              <keyframe id="studio-window-93" time={1.025} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-94" time={1.925} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-95" name={"Waveform bar 15"} x={301} y={34.11246283639993} width={6} height={31.775074327200148} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-96" property={"scaleY"}>
              <keyframe id="studio-window-97" time={1.05} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-98" time={1.9500000000000002} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-99" name={"Waveform bar 16"} x={321} y={27.08107298444164} width={6} height={45.83785403111672} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-100" property={"scaleY"}>
              <keyframe id="studio-window-101" time={1.075} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-102" time={1.975} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-103" name={"Waveform bar 17"} x={341} y={31.828615452669585} width={6} height={36.34276909466083} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-104" property={"scaleY"}>
              <keyframe id="studio-window-105" time={1.1} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-106" time={2} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-107" name={"Waveform bar 18"} x={361} y={40.34926336370705} width={6} height={19.301473272585888} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-108" property={"scaleY"}>
              <keyframe id="studio-window-109" time={1.125} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-110" time={2.0250000000000004} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-111" name={"Waveform bar 19"} x={381} y={42.35906384393959} width={6} height={15.28187231212083} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-112" property={"scaleY"}>
              <keyframe id="studio-window-113" time={1.15} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-114" time={2.0500000000000003} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-115" name={"Waveform bar 20"} x={401} y={34.760462342568445} width={6} height={30.479075314863103} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-116" property={"scaleY"}>
              <keyframe id="studio-window-117" time={1.175} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-118" time={2.075} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-119" name={"Waveform bar 21"} x={421} y={24.581154201796686} width={6} height={50.83769159640663} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-120" property={"scaleY"}>
              <keyframe id="studio-window-121" time={1.2} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-122" time={2.1} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-123" name={"Waveform bar 22"} x={441} y={22.787464404951912} width={6} height={54.425071190096176} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-124" property={"scaleY"}>
              <keyframe id="studio-window-125" time={1.225} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-126" time={2.125} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-127" name={"Waveform bar 23"} x={461} y={34.364880037372615} width={6} height={31.27023992525477} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-128" property={"scaleY"}>
              <keyframe id="studio-window-129" time={1.25} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-130" time={2.1500000000000004} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-131" name={"Waveform bar 24"} x={481} y={31.640112919046246} width={6} height={36.71977416190751} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-132" property={"scaleY"}>
              <keyframe id="studio-window-133" time={1.275} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-134" time={2.1750000000000003} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-135" name={"Waveform bar 25"} x={501} y={17.692686745915545} width={6} height={64.61462650816891} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-136" property={"scaleY"}>
              <keyframe id="studio-window-137" time={1.3} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-138" time={2.2} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-139" name={"Waveform bar 26"} x={521} y={17.66965393158835} width={6} height={64.6606921368233} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-140" property={"scaleY"}>
              <keyframe id="studio-window-141" time={1.325} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-142" time={2.225} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-143" name={"Waveform bar 27"} x={541} y={29.733515543829064} width={6} height={40.53296891234187} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-144" property={"scaleY"}>
              <keyframe id="studio-window-145" time={1.35} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-146" time={2.25} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
          <rect id="studio-window-147" name={"Waveform bar 28"} x={561} y={41.73181892370144} width={6} height={16.536362152597114} cornerRadius={3} fill={"#D39A90"} z={2}>
            <keyframeTrack id="studio-window-148" property={"scaleY"}>
              <keyframe id="studio-window-149" time={1.375} value={0.1} easing={"cubicBezier(0.22,1,0.36,1)"} />
              <keyframe id="studio-window-150" time={2.2750000000000004} value={1} easing={"cubicBezier(0.22,1,0.36,1)"} />
            </keyframeTrack>
          </rect>
        </group>
      </group>
      <group id="studio-window-151" name={"Floating control"} x={1445} y={670} width={306} height={188} z={90} rotationY={-10}>
        <keyframeTrack id="studio-window-152" property={"offsetY"}>
          <keyframe id="studio-window-153" time={0.8} value={100} easing={"cubicBezier(0.22,1,0.36,1)"} />
          <keyframe id="studio-window-154" time={2.3} value={0} easing={"cubicBezier(0.22,1,0.36,1)"} />
        </keyframeTrack>
        <rect id="studio-window-155" name={"Control surface"} width={306} height={188} cornerRadius={25} backdropBlur={12} refraction={0.12}>
          <solidPaint id="studio-window-156" color={"#FFFFFF"} opacity={0.9} />
          <shadow id="studio-window-157" color={"#BC96CE"} opacity={0.31} blur={44} offsetY={18} />
        </rect>
        <text id="studio-window-158" name={"Control heading"} x={27} y={26} fontSize={22} fontFamily={"Inter"} fontWeight={600} z={2}>
          {"Make some room"}
          <solidPaint id="studio-window-159" color={"#484250"} />
        </text>
        <text id="studio-window-160" name={"Control description"} x={29} y={66} fontSize={15} fontFamily={"Inter"} fontWeight={500} z={2}>
          {"For the next idea."}
          <solidPaint id="studio-window-161" color={"#A29BA8"} />
        </text>
        <rect id="studio-window-162" name={"Slider track"} x={30} y={131} width={244} height={4} cornerRadius={2} fill={"#E0D6E4"} z={2} />
        <ellipse id="studio-window-163" name={"Slider thumb"} x={116} y={121} width={24} height={24} fill={"#B7A0C4"} z={5}>
          <keyframeTrack id="studio-window-164" property={"x"}>
            <keyframe id="studio-window-165" time={1.4} value={32} easing={"cubicBezier(0.22,1,0.36,1)"} />
            <keyframe id="studio-window-166" time={3.4} value={202} easing={"cubicBezier(0.22,1,0.36,1)"} />
          </keyframeTrack>
        </ellipse>
      </group>
    </group>
  );
}
