# Fusion 360 脚本：导出书童外壳 STL
# 用法：在已生成外壳模型的 Fusion 文档中运行。

import adsk.core
import adsk.fusion
import os
import traceback


OUTPUT_DIR = '/Users/jf/code/esp32/shutong/cad/stl'


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
            ui.messageBox('请先打开已生成外壳的 Fusion 设计文件。')
            return

        os.makedirs(OUTPUT_DIR, exist_ok=True)
        root = design.rootComponent
        export_manager = design.exportManager

        real_bodies = [
            body for body in root.bRepBodies
            if not body.name.startswith('reference_')
        ]

        if len(real_bodies) < 2:
            names = ', '.join([body.name for body in root.bRepBodies])
            ui.messageBox('没有找到两个可导出的真实实体。当前实体：\n' + names)
            return

        # 按实体包围盒尺寸和高度分类，避免独立小柱/小特征被误认为上盖。
        targets = {}
        for body in real_bodies:
            bbox = body.boundingBox
            center_z_mm = (bbox.minPoint.z + bbox.maxPoint.z) * 5.0
            size_x_mm = (bbox.maxPoint.x - bbox.minPoint.x) * 10.0
            size_y_mm = (bbox.maxPoint.y - bbox.minPoint.y) * 10.0
            if size_x_mm < 40.0 or size_y_mm < 35.0:
                continue
            filename = 'shutong_lid.stl' if center_z_mm > 15.0 else 'shutong_base.stl'
            targets[filename] = body

        if 'shutong_base.stl' not in targets or 'shutong_lid.stl' not in targets:
            detail = '\n'.join([
                (
                    f'{body.name}: '
                    f'x={(body.boundingBox.maxPoint.x - body.boundingBox.minPoint.x) * 10:.1f}mm, '
                    f'y={(body.boundingBox.maxPoint.y - body.boundingBox.minPoint.y) * 10:.1f}mm, '
                    f'z={body.boundingBox.minPoint.z * 10:.1f}-{body.boundingBox.maxPoint.z * 10:.1f}mm'
                )
                for body in real_bodies
            ])
            ui.messageBox('无法按尺寸区分上下盖：\n' + detail)
            return

        exported = []
        for filename, body in targets.items():
            path = os.path.join(OUTPUT_DIR, filename)
            options = export_manager.createSTLExportOptions(body, path)
            options.isBinaryFormat = True
            try:
                options.meshRefinement = adsk.fusion.MeshRefinementSettings.MeshRefinementHigh
            except Exception:
                pass
            export_manager.execute(options)
            exported.append(path)

        ui.messageBox('STL 已导出：\n' + '\n'.join(exported))

    except Exception:
        if ui:
            ui.messageBox('导出失败:\n{}'.format(traceback.format_exc()))
