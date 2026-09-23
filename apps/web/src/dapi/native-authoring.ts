import { ANIMATABLE_PROPERTIES, validateCustomMeshGeometry, validatePointCloudGeometry, type AnimatableProperty, type AuthoredTree, type PropValue, isPropValue } from "@diffusionstudio/jsx";
import { authoredElement, createRuntimeDocument, renderAuthored } from "@diffusionstudio/reconciler";
import { Source, SpatialGeometry, createRuntimeWorld, getEntityTree, getParentEntity, isScene } from "@diffusionstudio/runtime";
import { getDocumentEditor } from "@/engine/editor";
import { isClipLocked } from "@/engine/clip-links";
import { syncKeyframe } from "@/engine/keyframes";
import type { Entity, World } from "koota";

/** Use the renderer's property validation before an agent edit reaches live source. */
export function validateNativeTree(tree: AuthoredTree, parent?: Entity): void {
  const world = createRuntimeWorld("native-authoring-validation");
  const document = createRuntimeDocument(world);
  const visit = (tree: AuthoredTree, parent: ReturnType<typeof document.createElement>) => {
    const node = document.createElement(tree.tag.charAt(0).toUpperCase() + tree.tag.slice(1));
    for (const [name, value] of Object.entries(tree.props)) document.setProperty(node, name, value);
    const geometry = node.entity.get(SpatialGeometry);
    if (tree.tag.toLowerCase() === "mesh" && geometry?.shape === "custom") validateCustomMeshGeometry(geometry);
    if (tree.tag.toLowerCase() === "pointcloud" && geometry) validatePointCloudGeometry(geometry);
    document.insertNode(parent, node);
    for (const child of tree.children) visit(child, node);
  };
  try {
    const ancestors = [];
    for (let current = parent; current; current = getParentEntity(current) ?? undefined) {
      const owner = authoredElement(current);
      if (owner) ancestors.unshift(owner);
    }
    let target = document.stage;
    for (const owner of ancestors) {
      const node = document.createElement(owner.tag.charAt(0).toUpperCase() + owner.tag.slice(1));
      for (const [name, value] of Object.entries(owner.props)) {
        if (isPropValue(value)) document.setProperty(node, name, value);
      }
      document.insertNode(target, node);
      target = node;
    }
    visit(tree, target);
  } finally { document.dispose(); world.destroy(); }
}

export function updateNativeElement(world: World, node: Entity, values: Record<string, PropValue | undefined>, text?: string): void {
  const current = authoredElement(node);
  if (!current) throw new Error("This element has no editable source");
  const entries = Object.entries(values).filter((entry): entry is [string, PropValue] => entry[1] !== undefined);
  const protectedContent = isClipLocked(node)
    || ((!isScene(node) || text !== undefined) && getEntityTree(world, node).some(isClipLocked));
  if (protectedContent && (text !== undefined || entries.some(([key]) => key !== "locked" && key !== "hidden"))) {
    throw new Error("This element is protected by a lock. Unlock it before editing its content.");
  }
  validateNativeTree({ ...current, props: { ...current.props, ...Object.fromEntries(entries) }, ...(text !== undefined ? { text } : {}), children: [] }, getParentEntity(node) ?? undefined);
  const editor = getDocumentEditor(world);
  for (const [key, value] of entries) {
    if (key === "locked") continue;
    if (key in ANIMATABLE_PROPERTIES && (typeof value === "number" || typeof value === "string" || Array.isArray(value) && value.every(item => typeof item === "number"))) {
      syncKeyframe(world, editor, node, key as AnimatableProperty, value);
    }
    editor.editProperty(node, key, value);
  }
  if (text !== undefined) editor.editText(node, text);
  // Apply a new lock only after the requested content edits are complete.
  if (values.locked !== undefined) editor.editProperty(node, "locked", values.locked);
}

export function insertNativeTree(world: World, parent: Entity, tree: AuthoredTree) {
  validateNativeTree(tree, parent);
  const [inserted] = getDocumentEditor(world).insertElement(parent, () => renderAuthored(tree));
  if (!inserted) throw new Error("This parent is locked or has no editable source");
  return inserted;
}

export function nativeElementTree(world: World, root: Entity) {
  return getEntityTree(world, root).flatMap(entity => {
    const source = entity.get(Source)?.value;
    const node = authoredElement(entity);
    return source && node ? [{ source, tag: node.tag, ...(typeof node.props.name === "string" ? { name: node.props.name } : {}) }] : [];
  });
}
