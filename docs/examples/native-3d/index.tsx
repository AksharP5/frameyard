export default function Native3D() {
  return <stage id="native-3d" background="#101113" camera={[.55, 0, 0, .55, 30, 80]}>
    <scene id="solid-scene" name="Solid objects" width={1280} height={720} active>
      <rect id="solid-background" end={8} name="Background" width={1280} height={720} fill="#111A22" />
      <text id="solid-title" end={8} x={64} y={58} fontSize={42} fontFamily="Inter" fontWeight={600} fill="#F4F7FA">Solid objects</text>
      <scene3d id="solid-viewport" name="3D scene" width={1280} height={720} ambientIntensity={.4} end={8}>
        <mesh id="rotating-cube" name="Blue cube" x={310} y={270} width={240} height={240} depth={240} rotationX={-18} rotationY={30} fill="#72B9F1" roughness={.3}>
          <keyframeTrack property="rotationY" id="94hvv7"><keyframe time={0} value={30} id="talkg8" /><keyframe time={8} value={390} id="ef24g7" /></keyframeTrack>
        </mesh>
        <mesh id="copper-sphere" name="Copper sphere" shape="sphere" x={720} y={310} width={185} height={185} depth={185} fill="#DD8F57" roughness={.19} metalness={.45}>
          <keyframeTrack property="y" id="ogm7v7"><keyframe time={0} value={310} easing="easeInOut" id="ewn0pd" /><keyframe time={4} value={220} easing="easeInOut" id="b1bc6i" /><keyframe time={8} value={310} id="hvd4uf" /></keyframeTrack>
        </mesh>
        <mesh id="ground" name="Ground" x={140} y={558} z={-80} width={1000} height={25} depth={750} fill="#293642" roughness={.9} />
        <light id="key-light" name="Key light" type="directional" x={80} y={-250} z={850} targetX={640} targetY={360} intensity={2.8} color="#ECF5FF" />
        <light id="rim-light" name="Rim light" type="point" x={1100} y={150} z={-250} intensity={50000} distance={1800} color="#FFD0AA" />
      </scene3d>
    </scene>
    <scene id="physics-scene" name="Gravity and collisions" x={1440} width={1280} height={720}>
      <rect id="physics-background" end={8} width={1280} height={720} fill="#171B21" />
      <text id="physics-title" end={8} x={64} y={58} fontSize={42} fontFamily="Inter" fontWeight={600} fill="#F4F7FA">Gravity and collisions</text>
      <scene3d id="physics-viewport" name="Physics world" width={1280} height={720} end={8} physics={{ gravity: [0, 780, 0] }} ambientIntensity={.5}>
        <mesh id="physics-floor" name="Floor collider" x={160} y={585} width={970} height={30} depth={500} fill="#344657" rigidBody={{ type: 'fixed', restitution: .7, friction: .6 }} />
        <mesh id="bouncing-ball" name="Bouncing ball" shape="sphere" x={310} y={145} width={95} height={95} depth={95} fill="#86C9F1" roughness={.3} rigidBody={{ shape: { type: 'sphere', radius: 47.5 }, restitution: .8, velocity: [100, 0, 0] }} />
        <mesh id="falling-box" name="Falling box" x={740} y={110} width={105} height={105} depth={105} fill="#ECA16B" roughness={.4} rigidBody={{ restitution: .45, angularVelocity: [25, 30, 10], velocity: [-25, 0, 0] }} />
        <light id="physics-light" type="directional" x={80} y={-200} z={700} targetX={640} targetY={400} intensity={2.5} />
      </scene3d>
    </scene>
    <scene id="smoke-scene" name="Smoke and depth" x={2880} width={1280} height={720}>
      <rect id="smoke-background" end={8} width={1280} height={720} fill="#111921" />
      <text id="smoke-title" end={8} x={64} y={58} fontSize={42} fontFamily="Inter" fontWeight={600} fill="#F4F7FA">Smoke and depth</text>
      <scene3d id="smoke-viewport" name="Volume scene" width={1280} height={720} end={8}>
        <volume id="smoke" name="Blue smoke" x={280} y={150} width={600} height={500} depth={440} color="#8EBBDD" density={.85} noiseScale={4} flowSpeed={.5} scatter={.8} />
        <mesh id="smoke-marker" name="Moving marker" x={775} y={310} width={110} height={160} depth={130} fill="#F4A26A" rotationY={25}>
          <keyframeTrack property="z" id="25h7jk"><keyframe time={0} value={-400} id="di0mad" /><keyframe time={4} value={300} id="x8zpbe" /><keyframe time={8} value={-400} id="mrkkeq" /></keyframeTrack>
        </mesh>
        <light id="smoke-light" type="directional" x={80} y={-100} z={600} targetX={600} targetY={400} intensity={2.2} color="#D8EEFF" />
      </scene3d>
    </scene>
  </stage>;
}
