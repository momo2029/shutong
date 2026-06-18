# Fusion 360 脚本：书童设备外壳 V3
# 用法：Fusion 360 -> Utilities -> Scripts and Add-Ins -> Scripts -> ShuTongEnclosure -> Run
#
# 设计目标：
# - 58 x 48 x 35 mm 主体，外形做大圆角，不再是直角工程盒。
# - 背壳托盘 + 前盖两件式打印后组装。
# - 主板四孔由上盖内侧 4 根短支撑柱承托；下盒保持空腔。
# - 相机区域做圆角凸台，给镜头突出高度留空间。
# - 背面元件预留约 10mm 空间；电池使用浅槽 + 泡棉/双面胶固定。
# - 背面预留两个 10x2mm 薄圆磁铁胶粘槽，支持磁吸支架。

import adsk.core
import adsk.fusion
import math
import traceback


def value_mm(v):
    return adsk.core.ValueInput.createByString(f'{v} mm')


def p(x, y, z=0):
    # Fusion API 的 Point3D 使用 cm。
    return adsk.core.Point3D.create(x / 10.0, y / 10.0, z / 10.0)


def plane_at(component, z_mm):
    planes = component.constructionPlanes
    plane_input = planes.createInput()
    plane_input.setByOffset(component.xYConstructionPlane, value_mm(z_mm))
    return planes.add(plane_input)


def draw_round_rect(sketch, x, y, w, d, r):
    r = min(r, w / 2.0 - 0.01, d / 2.0 - 0.01)
    lines = sketch.sketchCurves.sketchLines
    arcs = sketch.sketchCurves.sketchArcs

    lines.addByTwoPoints(p(x + r, y), p(x + w - r, y))
    arcs.addByCenterStartSweep(p(x + w - r, y + r), p(x + w - r, y), math.pi / 2.0)
    lines.addByTwoPoints(p(x + w, y + r), p(x + w, y + d - r))
    arcs.addByCenterStartSweep(p(x + w - r, y + d - r), p(x + w, y + d - r), math.pi / 2.0)
    lines.addByTwoPoints(p(x + w - r, y + d), p(x + r, y + d))
    arcs.addByCenterStartSweep(p(x + r, y + d - r), p(x + r, y + d), math.pi / 2.0)
    lines.addByTwoPoints(p(x, y + d - r), p(x, y + r))
    arcs.addByCenterStartSweep(p(x + r, y + r), p(x, y + r), math.pi / 2.0)


def profile_with_largest_area(sketch):
    profiles = [sketch.profiles.item(i) for i in range(sketch.profiles.count)]
    return max(profiles, key=lambda profile: profile.areaProperties().area)


def extrude_round_rect(component, name, x, y, w, d, r, z, h, operation, target_body=None):
    sketch = component.sketches.add(plane_at(component, z))
    draw_round_rect(sketch, x, y, w, d, r)
    profile = profile_with_largest_area(sketch)

    ext_input = component.features.extrudeFeatures.createInput(profile, operation)
    ext_input.setDistanceExtent(False, value_mm(h))
    if target_body:
        ext_input.participantBodies = [target_body]
    feature = component.features.extrudeFeatures.add(ext_input)
    body = feature.bodies.item(0)
    body.name = name
    return body


def cut_round_rect(component, target_body, x, y, w, d, r, z, h):
    sketch = component.sketches.add(plane_at(component, z))
    draw_round_rect(sketch, x, y, w, d, r)
    profile = profile_with_largest_area(sketch)

    ext_input = component.features.extrudeFeatures.createInput(
        profile,
        adsk.fusion.FeatureOperations.CutFeatureOperation,
    )
    ext_input.setDistanceExtent(False, value_mm(h))
    ext_input.participantBodies = [target_body]
    component.features.extrudeFeatures.add(ext_input)


def extrude_circle(component, name, cx, cy, diameter, z, h, operation, target_body=None):
    sketch = component.sketches.add(plane_at(component, z))
    sketch.sketchCurves.sketchCircles.addByCenterRadius(p(cx, cy), diameter / 20.0)
    profile = profile_with_largest_area(sketch)

    ext_input = component.features.extrudeFeatures.createInput(profile, operation)
    ext_input.setDistanceExtent(False, value_mm(h))
    if target_body:
        ext_input.participantBodies = [target_body]
    feature = component.features.extrudeFeatures.add(ext_input)
    body = feature.bodies.item(0)
    body.name = name
    return body


def cut_circle(component, target_body, cx, cy, diameter, z, h):
    sketch = component.sketches.add(plane_at(component, z))
    sketch.sketchCurves.sketchCircles.addByCenterRadius(p(cx, cy), diameter / 20.0)
    profile = profile_with_largest_area(sketch)

    ext_input = component.features.extrudeFeatures.createInput(
        profile,
        adsk.fusion.FeatureOperations.CutFeatureOperation,
    )
    ext_input.setDistanceExtent(False, value_mm(h))
    ext_input.participantBodies = [target_body]
    component.features.extrudeFeatures.add(ext_input)


def join_round_rect(component, target_body, name, x, y, w, d, r, z, h):
    return extrude_round_rect(
        component,
        name,
        x,
        y,
        w,
        d,
        r,
        z,
        h,
        adsk.fusion.FeatureOperations.JoinFeatureOperation,
        target_body,
    )


def join_circle(component, target_body, name, cx, cy, diameter, z, h):
    return extrude_circle(
        component,
        name,
        cx,
        cy,
        diameter,
        z,
        h,
        adsk.fusion.FeatureOperations.JoinFeatureOperation,
        target_body,
    )


def add_locator_post(component, base_body, cx, cy, board_z, lid_inner_top_z):
    # 两段式短柱：粗肩托住 PCB，细柱进入安装孔定位；上方细颈连接到上盖内顶面，避免形成浮动实体。
    join_circle(component, base_body, 'pcb_support_shoulder', cx, cy, 3.0, board_z, 2.0)
    join_circle(component, base_body, 'pcb_locator_pin', cx, cy, 1.6, board_z + 2.0, 1.5)
    connector_z = board_z + 3.5
    connector_h = lid_inner_top_z - connector_z + 0.2
    if connector_h > 0.3:
        join_circle(component, base_body, 'pcb_post_neck_to_lid', cx, cy, 1.6, connector_z, connector_h)


def add_lid_press_post(component, lid_body, cx, cy, board_top_z, lid_inner_top_z):
    # 盖内压柱抵住 PCB 安装孔附近的非元件区，和底部定位柱配合限制晃动。
    clearance = 0.35
    z = board_top_z + clearance
    h = lid_inner_top_z - z
    if h > 1.0:
        join_circle(component, lid_body, 'lid_press_post', cx, cy, 4.2, z, h)


def add_body_fillet(component, body, radius):
    edges = adsk.core.ObjectCollection.create()
    for edge in body.edges:
        edges.add(edge)
    fillet_input = component.features.filletFeatures.createInput()
    fillet_input.addConstantRadiusEdgeSet(edges, value_mm(radius), True)
    try:
        component.features.filletFeatures.add(fillet_input)
    except Exception:
        pass


def add_text(component, text, x, y, z, size):
    sketch = component.sketches.add(plane_at(component, z))
    text_input = sketch.sketchTexts.createInput(text, size / 10.0, p(x, y))
    text_input.setAsMultiLine(
        p(x, y),
        p(x + 28, y - 5),
        adsk.core.HorizontalAlignments.CenterHorizontalAlignment,
        adsk.core.VerticalAlignments.MiddleVerticalAlignment,
        0,
    )
    sketch.sketchTexts.add(text_input)


def run(context):
    ui = None
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface
        design = adsk.fusion.Design.cast(app.activeProduct)
        if not design and app.activeDocument:
            design = adsk.fusion.Design.cast(
                app.activeDocument.products.itemByProductType('DesignProductType')
            )
        if not design:
            ui.messageBox('请先打开或新建一个 Fusion 设计文件。')
            return

        component = design.rootComponent

        # ===== 外壳与装配参数 =====
        case_w = 58.0
        case_d = 48.0
        case_h = 35.0
        outer_r = 8.0
        wall = 0.8
        floor = 2.8
        overlap = 2.0
        base_h = 15.0
        lid_z = base_h
        lid_h = case_h - lid_z
        skirt_z = base_h - overlap
        skirt_t = 0.8
        skirt_clearance = 0.35
        snap_w = 1.2
        snap_len = 6.0
        snap_h = 1.1

        board_w = 42.0
        board_d = 42.0
        board_x = (case_w - board_w) / 2.0
        board_y = 3.0
        board_z = case_h - 7.0
        board_thickness = 1.6

        battery_w = 50.0
        battery_d = 35.0
        battery_h = 12.0
        battery_x = (case_w - battery_w) / 2.0
        battery_y = 6.5

        magnet_d = 10.4
        magnet_depth = 2.2
        magnet_y = case_d / 2.0
        magnet_spacing = 22.0
        magnet_left_x = case_w / 2.0 - magnet_spacing / 2.0
        magnet_right_x = case_w / 2.0 + magnet_spacing / 2.0

        # 根据背面功能图估算：Type-C 中心约在主板左边缘 15mm。
        # 口开在主板底边对应的盒子侧边，给插头外壳留较大余量。
        usb_offset_x = 15.0
        usb_opening_w = 9.8
        usb_opening_h = 5.8
        usb_x = board_x + usb_offset_x - usb_opening_w / 2.0
        usb_z = 5.0

        # 根据带标尺照片估算：镜头中心约在主板左边缘 20.0mm、下边缘 28.5mm。
        # 图片存在透视误差，实物装配前建议用卡尺复核。
        camera_offset_x = 20.0
        camera_offset_y = 28.5
        camera_cx = board_x + camera_offset_x
        camera_cy = board_y + camera_offset_y

        # ===== 背壳：圆角托盘 =====
        base = extrude_round_rect(
            component,
            'shutong_base_shell',
            0,
            0,
            case_w,
            case_d,
            outer_r,
            0,
            base_h,
            adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
        )
        cut_round_rect(
            component,
            base,
            wall,
            wall,
            case_w - 2 * wall,
            case_d - 2 * wall,
            outer_r - wall,
            floor,
            base_h - floor + 0.8,
        )

        # 下盒保持空盒结构，方便放电池、Type-C 充电板和走线。

        # Type-C 只在下盒开半豁口，留一点余量便于插线。
        cut_round_rect(component, base, usb_x, -0.4, usb_opening_w, 2.8, 0.9, usb_z, usb_opening_h)

        # 卡扣窗：下盒左右侧各两个浅卡窗，配合上盖内裙边上的小卡舌。
        for snap_y in [14.0, 30.0]:
            cut_round_rect(component, base, 0.05, snap_y, 1.2, snap_len, 0.3, skirt_z + 0.55, snap_h + 0.35)
            cut_round_rect(component, base, case_w - 1.25, snap_y, 1.2, snap_len, 0.3, skirt_z + 0.55, snap_h + 0.35)

        # 背面磁铁槽：适配常见 10x2mm 圆形钕磁铁，0.4mm 直径余量、0.2mm 胶水深度余量。
        # 槽从外侧背面切入，磁铁可用 AB 胶/环氧胶固定并尽量做到与外表面齐平。
        cut_circle(component, base, magnet_left_x, magnet_y, magnet_d, -0.05, magnet_depth + 0.1)
        cut_circle(component, base, magnet_right_x, magnet_y, magnet_d, -0.05, magnet_depth + 0.1)

        # 主板孔位。柱子放在上盖内侧，下盒不放主板支撑柱。
        inset = 3.6
        hole_points = [
            (board_x + inset, board_y + inset),
            (board_x + board_w - inset, board_y + inset),
            (board_x + inset, board_y + board_d - inset),
            (board_x + board_w - inset, board_y + board_d - inset),
        ]
        # 内部参考体：打印前隐藏。
        board_ref = extrude_round_rect(
            component,
            'reference_board_42x42_hide_before_export',
            board_x,
            board_y,
            board_w,
            board_d,
            2.0,
            board_z,
            board_thickness,
            adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
        )
        battery_ref = extrude_round_rect(
            component,
            'reference_battery_50x35_hide_before_export',
            battery_x,
            battery_y,
            battery_w,
            battery_d,
            2.0,
            floor,
            battery_h,
            adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
        )

        # ===== 前盖：带圆角相机岛和内裙边 =====
        lid = extrude_round_rect(
            component,
            'shutong_lid_shell',
            0,
            0,
            case_w,
            case_d,
            outer_r,
            lid_z,
            lid_h,
            adsk.fusion.FeatureOperations.NewBodyFeatureOperation,
        )
        lid_inner_top_z = case_h - 2.0
        cut_round_rect(
            component,
            lid,
            wall + 0.35,
            wall + 0.35,
            case_w - 2 * (wall + 0.35),
            case_d - 2 * (wall + 0.35),
            outer_r - wall - 0.35,
            lid_z,
            lid_h - 2.0,
        )

        # 上盖内裙边：插入下盒内侧，提供装配定位。
        skirt_inset = wall + skirt_clearance
        skirt_span_x = case_w - 2 * skirt_inset
        skirt_span_y = case_d - 2 * skirt_inset
        join_round_rect(component, lid, 'lid_left_skirt', skirt_inset, skirt_inset, skirt_t, skirt_span_y, 0.25, skirt_z, overlap)
        join_round_rect(component, lid, 'lid_right_skirt', case_w - skirt_inset - skirt_t, skirt_inset, skirt_t, skirt_span_y, 0.25, skirt_z, overlap)
        join_round_rect(component, lid, 'lid_front_skirt', skirt_inset, skirt_inset, skirt_span_x, skirt_t, 0.25, skirt_z, overlap)
        join_round_rect(component, lid, 'lid_back_skirt', skirt_inset, case_d - skirt_inset - skirt_t, skirt_span_x, skirt_t, 0.25, skirt_z, overlap)

        # 低矮卡舌：只负责卡住和定位，后续可加少量胶防松。
        for snap_y in [14.0, 30.0]:
            join_round_rect(component, lid, 'left_snap_tab', 0.55, snap_y, snap_w, snap_len, 0.3, skirt_z + 0.65, snap_h)
            join_round_rect(component, lid, 'right_snap_tab', case_w - 1.75, snap_y, snap_w, snap_len, 0.3, skirt_z + 0.65, snap_h)

        # 相机岛：外部轻微凸起，尺寸和高度都比上一版减小。
        join_round_rect(component, lid, 'camera_island', camera_cx - 11.0, camera_cy - 8.0, 22.0, 16.0, 4.0, case_h, 1.1)
        cut_circle(component, lid, camera_cx, camera_cy, 10.5, lid_inner_top_z - 0.2, 4.8)

        # 四个闪光灯只留小孔，方便透光，不再开大圆孔。
        for x, y in [
            (board_x + 6.0, board_y + 27.0),
            (board_x + 36.0, board_y + 27.0),
            (board_x + 6.0, board_y + 17.0),
            (board_x + 36.0, board_y + 17.0),
        ]:
            cut_circle(component, lid, x, y, 3.0, lid_inner_top_z - 0.2, 4.8)

        # 左下麦克风/指示灯留小孔，便于收音和观察。
        cut_circle(component, lid, board_x + 6.5, board_y + 10.5, 1.8, lid_inner_top_z - 0.2, 4.8)
        cut_circle(component, lid, board_x + 9.0, board_y + 7.5, 1.8, lid_inner_top_z - 0.2, 4.8)

        # 当前版把四个短支撑柱放在上盖内侧；下盒保持空盒。
        for x, y in hole_points:
            add_locator_post(component, lid, x, y, board_z, lid_inner_top_z)

        # 侧边浅纹理，增加握持感，也让外观不那么方。
        for i in range(3):
            cut_round_rect(component, lid, 6 + i * 8, case_d - 1.4, 5.0, 1.6, 0.8, 22.0, 5.0)
            cut_round_rect(component, lid, 6 + i * 8, -0.2, 5.0, 1.6, 0.8, 22.0, 5.0)

        add_text(component, 'ShuTong', 7.5, 9.0, case_h + 2.25, 2.6)

        for body in [base, lid]:
            add_body_fillet(component, body, 0.7)

        try:
            appearance = design.appearances.itemByName('Plastic - Translucent Matte (Gray)')
            if appearance:
                board_ref.appearance = appearance
                battery_ref.appearance = appearance
        except Exception:
            pass

        ui.messageBox(
            '书童外壳 V3 已生成。打印前隐藏 reference_* 占位体；安装孔、镜头中心、USB 口需按实物复量微调。'
        )

    except Exception:
        if ui:
            ui.messageBox('生成失败:\n{}'.format(traceback.format_exc()))
