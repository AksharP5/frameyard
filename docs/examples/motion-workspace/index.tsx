import StudioOpening from './compositions/studio-opening';
import PhoneChat from './compositions/phone-chat';
import KineticType from './compositions/kinetic-type';
import GrowthChart from './compositions/growth-chart';
import GeometryStudy from './compositions/geometry-study';
import StudioWindow from './compositions/studio-window';
import SpatialCube from './compositions/spatial-cube';

export default function MotionWorkspace() {
  return <stage id="motion-workspace" background="#101113" camera={[0.2, 0, 0, 0.2, 20, 180]}>
    <scene id="studio-opening-scene" name="Studio opening" width={1920} height={1080} bloom={0.06} grain={0.02} active>
      <StudioOpening />
    </scene>
    <scene id="phone-chat-scene" name="Phone & chat" x={0} y={1320} width={1920} height={1080}>
      <PhoneChat />
    </scene>
    <scene id="kinetic-type-scene" name="Make it move" x={2160} y={1320} width={1920} height={1080}>
      <KineticType />
    </scene>
    <scene id="growth-chart-scene" name="Growth chart" x={4320} y={1320} width={1920} height={1080}>
      <GrowthChart />
    </scene>
    <scene id="geometry-study-scene" name="Geometry study" x={0} y={2640} width={1920} height={1080}>
      <GeometryStudy />
    </scene>
    <scene id="studio-window-scene" name="Studio launch" x={2160} y={2640} width={1920} height={1080}>
      <StudioWindow />
    </scene>
    <scene id="spatial-cube-scene" name="Another dimension" x={4320} y={2640} width={1920} height={1080}>
      <SpatialCube />
    </scene>
  </stage>;
}
