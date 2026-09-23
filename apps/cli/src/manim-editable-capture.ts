/** Executed by the project's installed Manim Python; it never rasterizes objects. */
export const manimEditableCapture = String.raw`
import importlib.util
import base64
import hashlib
import io
import json
import math
import sys
import numpy as np
from PIL import Image
from pathlib import Path
from manim import Scene, VMobject, PMobject, ThreeDCamera, ManimColor, RendererType, config, tempconfig
from manim.mobject.types.image_mobject import AbstractImageMobject
from manim.renderer.cairo_renderer import CairoRenderer
from manim.scene import scene as scene_module

entry, scene_name, output, fps, media, transparent = sys.argv[1:]
layers = {}
objects = {}
issues = set()
sample_count = 0
images = {}
image_originals = {}

def issue(name, feature):
    issues.add((name, feature))

def number(value):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("Manim produced a non-finite coordinate")
    return round(value, 5)

def color(rgba):
    return "#" + "".join(f"{max(0,min(255,round(float(v)*255))):02x}" for v in rgba[:3])

def image_source(pixels):
    pixels = np.asarray(pixels, dtype=np.uint8)
    digest = hashlib.sha256(str(pixels.shape).encode() + pixels.tobytes()).hexdigest()
    if digest not in images:
        encoded = io.BytesIO()
        Image.fromarray(pixels).save(encoded, format="PNG")
        images[digest] = "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode()
    return images[digest]

def image_pixels(mob):
    pixels = mob.get_pixel_array().copy()
    original_alpha = getattr(mob, "orig_alpha_pixel_array", None)
    opacity = float(getattr(mob, "stroke_opacity", 1))
    original = image_originals.setdefault(id(mob), pixels.copy())
    target = getattr(mob, "target", None)
    same_rgb = np.array_equal(pixels[:,:,:3], original[:,:,:3])
    if target is not None and original.shape == pixels.shape:
        target_pixels = target.get_pixel_array()
        # Interpolating equal uint8 endpoints can truncate an unchanged RGB channel.
        same_rgb = same_rgb or (np.array_equal(target_pixels[:,:,:3], original[:,:,:3])
            and np.max(np.abs(pixels[:,:,:3].astype(float)-original[:,:,:3])) <= 1)
    # Alpha interpolation truncates both its target endpoint and its sampled value.
    if same_rgb and original_alpha is not None and np.max(np.abs(pixels[:,:,3].astype(float) - original_alpha * opacity)) < 2:
        pixels[:,:,:3] = original[:,:,:3]
        pixels[:,:,3] = original_alpha
        return pixels, number(opacity)
    return pixels, 1

def image_transform(points, name):
    origin, horizontal, vertical, opposite = points
    if not np.allclose(opposite, horizontal + vertical - origin, atol=1e-6):
        issue(name, "non-planar image corner warp")
    u = horizontal - origin
    v = vertical - origin
    width = float(np.linalg.norm(u))
    if width < 1e-8:
        return dict(x=number(origin[0]),y=number(origin[1]),width=0.001,height=0.001,opacity=0)
    u /= width
    skew = float(np.dot(u, v))
    v -= skew * u
    height = float(np.linalg.norm(v))
    if height < 1e-8:
        return dict(x=number(origin[0]),y=number(origin[1]),width=number(width),height=0.001,opacity=0)
    v /= height
    basis = np.column_stack((u, v, np.cross(u, v)))
    tilt_x = math.asin(float(np.clip(-basis[1,2], -1, 1)))
    if abs(math.cos(tilt_x)) > 1e-8:
        tilt_y = math.atan2(basis[0,2], basis[2,2])
        roll = math.atan2(basis[1,0], basis[1,1])
    else:
        tilt_y = math.atan2(-basis[2,0], basis[0,0])
        roll = 0
    props = dict(x=number(origin[0]),y=number(origin[1]),width=number(width),height=number(height),anchorX=0,anchorY=0,
        rotation=number(math.degrees(roll)),skewX=number(math.degrees(math.atan2(skew, height))))
    if abs(origin[2]) > 1e-8 or abs(tilt_x) > 1e-8 or abs(tilt_y) > 1e-8:
        props.update(z=number(origin[2]),rotationX=number(math.degrees(tilt_x)),rotationY=number(math.degrees(tilt_y)))
    return props

def camera_props(camera):
    camera.reset_rotation_matrix()
    flip = np.diag([1, -1, 1])
    rotation = (flip @ camera.get_rotation_matrix() @ flip).T
    angle_y = math.asin(float(np.clip(-rotation[2,0], -1, 1)))
    if abs(math.cos(angle_y)) > 1e-8:
        angle_x = math.atan2(rotation[2,1], rotation[2,2])
        roll = math.atan2(rotation[1,0], rotation[0,0])
    else:
        angle_x = math.atan2(-rotation[1,2], rotation[1,1])
        roll = 0
    unit = camera.pixel_width / camera.frame_width
    focal = camera.get_focal_distance() * unit
    center = flip @ camera.frame_center * unit
    position = center + rotation @ np.array([0, 0, focal])
    return dict(width=camera.pixel_width,height=camera.pixel_height,opacity=1,
        cameraX=number(position[0]+camera.pixel_width/2),cameraY=number(position[1]+camera.pixel_height/2),cameraZ=number(position[2]),
        cameraRotationX=number(math.degrees(angle_x)),cameraRotationY=number(math.degrees(angle_y)),cameraRotation=number(math.degrees(roll)),
        perspective=number(focal),cameraZoom=number(camera.get_zoom()),cameraOffsetX=number(-center[0]),cameraOffsetY=number(-center[1]))

def native_points(camera, mob, points):
    points = np.asarray(points, dtype=float).copy()
    if isinstance(camera, ThreeDCamera):
        if mob in camera.fixed_in_frame_mobjects or mob in camera.fixed_orientation_mobjects:
            # Retain XYZ geometry while sampling the object's camera compensation.
            projected = camera.transform_points_pre_display(mob, points)
            focal = camera.get_focal_distance()
            factors = focal / (focal - projected[:,2]) * camera.get_zoom()
            projected[:,:2] /= factors[:,None]
            points = projected @ camera.get_rotation_matrix() + camera.frame_center
        points *= np.array([1, -1, 1]) * camera.pixel_width / camera.frame_width
        points[:,:2] += [camera.pixel_width/2, camera.pixel_height/2]
        return points
    result = np.zeros_like(points)
    result[:,:2] = camera.points_to_subpixel_coords(mob, points)
    return result

def path_geometry(camera, mob):
    points = native_points(camera, mob, mob.points)
    left, top = points[:,:2].min(axis=0)
    right, bottom = points[:,:2].max(axis=0)
    width, height = max(float(right-left), 0.001), max(float(bottom-top), 0.001)
    points[:,:2] -= [left, top]
    spatial = isinstance(camera, ThreeDCamera)
    if not spatial:
        # Fixed normalized coordinates retain precision when Create starts at zero size.
        points[:,:2] *= [1000/width, 1000/height]
    dimensions = 3 if spatial else 2
    commands = []
    for start, end in mob.get_subpath_split_indices_from_points(mob.points, n_dims=dimensions):
        start, end = int(start), int(end)
        if end-start < 4:
            continue
        commands.append("M " + " ".join(str(number(v)) for v in points[start,:dimensions]))
        for index in range(start, end-3, 4):
            commands.append("C " + " ".join(str(number(v)) for v in points[index+1:index+4,:dimensions].flat))
        if np.allclose(mob.points[start,:dimensions], mob.points[end-1,:dimensions], atol=1e-8):
            commands.append("Z")
    props = dict(x=number(left),y=number(top),width=number(width),height=number(height),opacity=1,d=" ".join(commands))
    if spatial:
        props.update(z=0,depthTest=False)
    else:
        props.update(viewBox=[0,0,1000,1000])
    return props

def layer(identifier, parent, kind, name, props, time):
    global sample_count
    if identifier not in layers:
        layers[identifier] = dict(id=identifier, parent=parent, kind=kind, name=name, frames=[])
    item = layers[identifier]
    if item["parent"] != parent:
        issue(name, "changing object parent")
    if item["kind"] != kind:
        issue(name, "changing object type")
    frames = item["frames"]
    frame = dict(time=number(time), props=props)
    if frames and (frames[-1]["time"] == frame["time"] or (len(frames)>1 and frames[-1]["props"] == props and frames[-2]["props"] == props)):
        frames[-1] = frame
    else:
        frames.append(frame)
        sample_count += 1
    if sample_count > 500000:
        raise ValueError("Editable capture exceeds 500,000 object samples. Split the scene into shorter components.")

class EditableRenderer(CairoRenderer):
    def update_frame(self, scene, *args, **kwargs):
        self.current_scene = scene

    def save_static_frame_data(self, scene, *args, **kwargs):
        self.current_scene = scene
        self.static_image = None

    def snapshot(self, scene, time):
        camera = self.camera
        spatial = isinstance(camera, ThreeDCamera)
        if type(camera).__name__ not in ("Camera", "MovingCamera", "ThreeDCamera"):
            issue("Camera", "custom camera projection")
        if spatial and camera.exponential_projection:
            issue("Camera", "exponential 3D camera projection")
        width, height = camera.pixel_width, camera.pixel_height
        stroke_unit = camera.cairo_line_width_multiple * width / camera.frame_width
        seen = set()
        draw_order = []
        def see(identifier, parent):
            seen.add(identifier)
        background = dict(x=0,y=0,width=width,height=height,opacity=1)
        if getattr(camera, "background_image", None):
            background.update(src=image_source(camera.background))
        else:
            background.update(fill=ManimColor(camera.background_color).to_hex(),fillOpacity=number(camera.background_opacity))
        layer("background", None, "image" if "src" in background else "rect", "Background", background, time)
        see("background", None)
        if spatial:
            layer("camera", None, "scene3d", "Camera", camera_props(camera), time)
            see("camera", None)
        roots = list(dict.fromkeys([*scene.mobjects, *scene.foreground_mobjects]))
        displayed = camera.get_mobjects_to_display(roots)
        ranks = {id(mob): index for index, mob in enumerate(displayed)}
        def rank(mob):
            return min((ranks.get(id(member), len(ranks)) for member in mob.get_family()), default=len(ranks)) * 3 + 1

        def paint(parent, mob, rgba, name):
            if len(rgba) == 1:
                identifier = parent + "-solid"
                layer(identifier, parent, "solidPaint", name, dict(color=color(rgba[0]),opacity=number(rgba[0][3])), time)
                see(identifier, parent)
                return
            identifier = parent + "-gradient-" + str(len(rgba))
            endpoints = camera.points_to_subpixel_coords(mob, np.asarray(mob.get_gradient_start_and_end_points()))
            projected = camera.points_to_subpixel_coords(mob, mob.points)
            left, top = projected.min(axis=0)
            box = np.maximum(projected.max(axis=0) - [left, top], 0.001)
            endpoints = (endpoints - [left, top]) / box
            props = dict(opacity=1,x1=number(endpoints[0,0]),y1=number(endpoints[0,1]),x2=number(endpoints[1,0]),y2=number(endpoints[1,1]))
            if spatial:
                props.update(gradientSpace="screen")
            layer(identifier, parent, "linearGradientPaint", name, props, time)
            see(identifier, parent)
            for index, stop in enumerate(rgba):
                stop_id = identifier + "-stop-" + str(index)
                layer(stop_id, identifier, "colorStop", name + " stop " + str(index+1),
                    dict(color=color(stop),opacity=number(stop[3]),offset=number(index/(len(rgba)-1))), time)
                see(stop_id, identifier)

        def stroke(parent, mob, name, background=False):
            identifier = parent + "-stroke"
            props = dict(width=number(mob.get_stroke_width(background=background)*stroke_unit),opacity=1,
                cap={"AUTO":"butt","BUTT":"butt","ROUND":"round","SQUARE":"square"}[mob.cap_style.name],
                join={"AUTO":"miter","MITER":"miter","ROUND":"round","BEVEL":"bevel"}[mob.joint_type.name])
            layer(identifier, parent, "stroke", name, props, time)
            see(identifier, parent)
            paint(identifier, mob, camera.get_stroke_rgbas(mob, background=background), name + " color")

        def visit(mob, parent=None):
            # Cairo deliberately ignores base Mobjects such as camera ValueTrackers.
            if not isinstance(mob, (VMobject, PMobject, AbstractImageMobject)) and not mob.submobjects:
                return
            identity = id(mob)
            if identity not in objects:
                objects[identity] = (mob, "object-" + str(len(objects)))
            identifier = objects[identity][1]
            if identifier in seen:
                return
            see(identifier, parent)
            name = str(getattr(mob, "text", None) or getattr(mob, "tex_string", None) or getattr(mob, "name", type(mob).__name__))
            render_order = rank(mob)
            layer(identifier, parent, "group", name, dict(opacity=1,renderOrder=render_order), time)
            points = mob.points
            if len(points) and isinstance(mob, VMobject):
                path_id = identifier + "-path"
                if getattr(mob, "background_image_file", None):
                    issue(name, "image-filled vector")
                props = dict(path_geometry(camera, mob), renderOrder=render_order)
                kind = "path3d" if spatial else "path"
                if mob.get_stroke_width(background=True) > 0:
                    background_id = identifier + "-background-stroke"
                    layer(background_id, identifier, kind, name + " background stroke", dict(props,renderOrder=render_order-1), time)
                    see(background_id, identifier)
                    stroke(background_id, mob, name + " background stroke", True)
                layer(path_id, identifier, kind, name + " path", props, time)
                see(path_id, identifier)
                paint(path_id, mob, camera.get_fill_rgbas(mob), name + " fill")
                stroke(path_id, mob, name + " stroke")
                draw_order.append(path_id)
            elif len(points) and isinstance(mob, AbstractImageMobject):
                pixels, opacity = image_pixels(mob)
                props = dict(src=image_source(pixels),opacity=opacity,renderOrder=render_order)
                props.update(image_transform(native_points(camera, mob, points), name))
                if spatial:
                    props.update(depthTest=False)
                image_id = identifier + "-image"
                layer(image_id, identifier, "image", name + " image", props, time)
                see(image_id, identifier)
                draw_order.append(image_id)
            elif len(points) and isinstance(mob, PMobject):
                cloud_parent = identifier
                if not spatial:
                    cloud_parent = identifier + "-camera"
                    layer(cloud_parent, identifier, "scene3d", name + " camera", dict(width=width,height=height,opacity=1), time)
                    see(cloud_parent, identifier)
                cloud_id = identifier + "-points"
                props = dict(points=[number(v) for v in native_points(camera, mob, points).flat],
                    pointColors=[number(v) for v in mob.rgbas.flat],pointSize=number(camera.adjusted_thickness(mob.stroke_width)),
                    opacity=1,renderOrder=render_order,depthTest=False)
                layer(cloud_id, cloud_parent, "pointCloud", name + " points", props, time)
                see(cloud_id, cloud_parent)
                draw_order.append(cloud_id)
            for child in sorted(mob.submobjects, key=rank):
                visit(child, identifier)

        for mob in sorted(roots, key=rank):
            visit(mob, "camera" if spatial else None)
        camera_order = [objects[id(mob)][1] + ("-path" if isinstance(mob, VMobject) else "-image" if isinstance(mob, AbstractImageMobject) else "-points") for mob in displayed
            if isinstance(mob, (VMobject, AbstractImageMobject, PMobject)) and len(mob.points)]
        if not spatial and camera_order != draw_order:
            issue("Composition", "object stacking order crosses group boundaries")
        for identifier, item in list(layers.items()):
            if identifier not in seen:
                props = dict(item["frames"][-1]["props"], opacity=0)
                layer(identifier, item["parent"], item["kind"], item["name"], props, time)

    def render(self, scene, time, moving_mobjects=None):
        self.snapshot(scene, self.time)
        self.time += 1 / self.camera.frame_rate

    def freeze_current_frame(self, duration):
        count = max(1, int(round(duration * self.camera.frame_rate)))
        self.snapshot(self.current_scene, self.time)
        if count > 1:
            self.snapshot(self.current_scene, self.time + (count-1)/self.camera.frame_rate)
        self.time += count/self.camera.frame_rate

    def scene_finished(self, scene):
        self.snapshot(scene, self.time)

with tempconfig(dict(renderer="cairo",pixel_width=1920,pixel_height=1080,frame_rate=float(fps),background_opacity=0 if transparent=="true" else 1,
    write_to_movie=False,save_last_frame=False,disable_caching=True,preview=False,media_dir=media,verbosity="ERROR")):
    sys.path.insert(0, str(Path(entry).parent))
    spec = importlib.util.spec_from_file_location("diffusion_animation_source", entry)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if config.renderer != RendererType.CAIRO:
        raise ValueError("Editable conversion supports the Cairo renderer, not OpenGL or custom renderers")
    scene_class = getattr(module, scene_name)
    if not isinstance(scene_class, type) or not issubclass(scene_class, Scene):
        raise ValueError("Registered Manim scene must extend Scene")
    # Let Scene choose its declared camera; a supplied base camera breaks MovingCameraScene.
    scene_module.CairoRenderer = EditableRenderer
    scene = scene_class()
    renderer = scene.renderer
    if not isinstance(renderer, EditableRenderer):
        raise ValueError("Editable conversion cannot capture a custom or non-Cairo renderer")
    scene.render()
    if scene.renderer is not renderer or config.renderer != RendererType.CAIRO:
        raise ValueError("The scene changed renderer during editable conversion")
    duration = max(renderer.time, 1/renderer.camera.frame_rate)
    for item in layers.values():
        if item["parent"] is None:
            del item["parent"]
        previous_source = None
        for frame in item["frames"]:
            source = frame["props"].get("src")
            if source is not None and source == previous_source:
                del frame["props"]["src"]
            elif source is not None:
                previous_source = source
    data = dict(width=renderer.camera.pixel_width,height=renderer.camera.pixel_height,duration=number(duration),
        frameRate=renderer.camera.frame_rate,layers=list(layers.values()),
        issues=[dict(layer=name,feature=feature) for name,feature in sorted(issues)])
    Path(output).write_text(json.dumps(data, separators=(",",":")))
`;
