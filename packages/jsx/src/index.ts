/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The authoring surface: the types project sources are written against, the
 * pure helpers they may call, and the hooks the editor implements. The
 * renderer that turns this vocabulary into a composition is not here — the
 * editor supplies it when a project is mounted (see
 * @diffusionstudio/reconciler), so nothing in this package touches a host.
 */

export {
  generate,
  transform,
  AssetRef,
  isAssetRef,
  getAssetSpec,
  getAssetInputs,
  mapAssetInputs,
  isTransformSpec,
  isTransformType,
  serializeAssetRef,
  isSerializedAssetRef,
} from "./generate";
export type {
  AspectRatio,
  AssetInput,
  AssetSpecInput,
  GenerateSpec,
  TransformSpec,
  TransformType,
  SerializedAssetInput,
  SerializedAssetRef,
  SerializedAssetSpec,
  GenerateAudioOptions,
  GenerateImageOptions,
  GenerateVideoOptions,
  GenerateVoiceOptions,
} from "./generate";
export { parseTime, TIME_FPS, FRAME_RATE_PRESETS, isFrameRate } from "./time";
export { HIGHLIGHT_DEFAULTS, parseHighlightOptions, highlightProgress } from "./highlight";
export type { HighlightOptions } from "./highlight";
export { PRESET_CATALOG, PRESET_DEFAULTS, PRESET_LIMITS, getPresetDefinition, parsePresetOptions } from "./presets";
export type { PresetOptions, PresetSettings, PresetDefinition } from "./presets";
export {
  COMPOSITION_TAGS,
  ID_ATTR,
  LOOP_ATTR,
  LOOP_TAGS,
  SOURCE_ATTR,
  formatSource,
  isCompositionTag,
  isLoopTag,
  isPropValue,
  parseSource,
} from "./source";
export type { AuthoredElement, AuthoredTree, CompositionTag, PropValue } from "./source";
export { useResolution, useTicker } from "./hooks";
export type { Ticker } from "./hooks";
export { INSPECT_TAG, INSPECT_TYPES, __inspect } from "./inspect";
export type { InspectDeclaration, InspectType, InspectValue } from "./inspect";
export { ANIMATABLE_PROPERTIES } from "./types";
export type {
  AdjustmentLayerProps,
  AnimatableProperty,
  AnimationProps,
  AnimationType,
  AudioProps,
  AudioProcessingSettings,
  ColorGradeSettings,
  BlendMode,
  CameraMatrix,
  CaptionPreset,
  CaptionsProps,
  ColorStopProps,
  Easing,
  EffectProps,
  EffectType,
  Fit,
  GradientPaintProps,
  GroupProps,
  HighlightProps,
  PresetProps,
  HorizontalConstraint,
  HtmlPaintProps,
  HtmlProps,
  ImageProps,
  KeyframeProps,
  KeyframeTrackProps,
  MediaPaintProps,
  RectProps,
  PathProps,
  EllipseProps,
  SceneCameraProps,
  DepthSortMode,
  SceneNode,
  SceneProps,
  SequenceProps,
  ShaderPaintProps,
  ShadowProps,
  SolidPaintProps,
  SourceProps,
  StageProps,
  StrokeCap,
  StrokeJoin,
  StrokeProps,
  SurfacePaintProps,
  SurfaceProps,
  TextCase,
  TextProps,
  TextRangeProps,
  Time,
  TransitionSpec,
  TransitionType,
  VerticalConstraint,
  VideoProps,
} from "./types";

export * from "./spatial";
export * from "./physics";
export type { Scene3DProps, MeshProps, Path3DProps, PointCloudProps, LightProps, VolumeProps } from "./types";
