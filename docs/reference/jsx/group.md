# `<group>`

A container whose children remain individual editable layers. A group derives its bounds from its children unless given `width` and `height`; an explicit box keeps its transform pivot stable as children animate.

```tsx
<group x={100} y={100}>
  {/* children */}
</group>
```

## Props

A group takes the [common](./elements.md#common-props) **transform** (`x`, `y`, `z`, `offsetX`, `offsetY`, `rotation`, `rotationX`, `rotationY`, `scale`, `scaleX`, `scaleY`, `anchorX`, `anchorY`, `skewX`, `skewY`, `flipX`, `flipY`, `opacity`), **composite** (`blendMode`, `hidden`) and **timing** (`start`, `end`) props.

A group has no painted surface of its own: use a child `<rect>` as its background. `<effect>`, `<animation>` and `<keyframeTrack>` children are valid; an effect on a group filters its children together.

`depthSort="layer"` (default) orders child planes by local `z`, preserving source order at equal depth. `depthSort="camera"` orders them by distance from the camera; use it for solid face assemblies such as an editable cube. Keep ordinary interfaces on layer ordering.

Canvas resizing of a spatial group changes its scale, retaining every child's authored size and coordinates. Removing both authored dimensions restores automatic bounds.

`physics={true}` or a physics options object creates a local simulation world for descendant rigid bodies. Gravity and spring anchors use the group's coordinates. See [native physics](./spatial.md#physics).

## Timing

A group with no `end` of its own **spans its children**: it begins where the earliest one begins and ends where the last one ends, and follows them as they move. Give it an `end` and it trims them instead — children outside the window do not play. See [timing.md](./timing.md).

An empty group, having nothing to span, falls back to the 16-second default.

## Grouping and ungrouping

Groups are what the editor's group action creates and what its ungroup action takes apart, so a group written by hand and one made on the canvas are the same element. A [`<sequence>`](./sequences.md) is a group with the non-overlap invariant added and its own transform taken away.
