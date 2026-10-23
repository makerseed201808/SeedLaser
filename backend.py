"""JS↔Python 桥接 API."""
from __future__ import annotations

import base64
import functools
import gettext
import mimetypes
import os
import re
import subprocess
import sys
import threading
import traceback
from collections import OrderedDict
from typing import Any

import webview

import boxes
import boxes.edges as boxes_edges
import boxes.generators as gen_module

import model3d


# 边缘字符 (e/f/F/...) → 描述（如 "Straight Edge"），由 boxes 提供
_EDGE_DESCRIPTIONS = boxes_edges.getDescriptions()


_MD_LINK_RE = re.compile(r"\s*\[([^\]]*)\]\([^)]+\)")


def strip_md_links(text: str) -> str:
    """去掉 boxes 参数 help 中的 markdown 链接，只留文字。"""
    if not text:
        return text
    def repl(m: re.Match) -> str:
        label = m.group(1).strip()
        if len(label) <= 2:
            return ""
        return label
    return _MD_LINK_RE.sub(repl, text).strip()


# --------------------------------------------------------------------- 资源定位

_PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))


def _boxes_root() -> str:
    """boxes 项目根目录（含 locale/、static/）。
    冻结模式下从 sys._MEIPASS 取，源码模式下从 boxes 包位置推断。"""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return sys._MEIPASS  # PyInstaller 解压目录
    return os.path.dirname(os.path.dirname(os.path.abspath(boxes.__file__)))


def _find_asset_dir(kind: str) -> str:
    """查找 boxes 的资源目录（kind = "static" 或 "locale"），找不到返回 ""。

    boxes 通过 git URL 安装到 site-packages 时，static/ 不会被安装，
    locale/ 的 .mo 被装到 <venv>/share/locale。查找顺序：
      ① 打包后 sys._MEIPASS/<kind>
      ② 本仓库 boxes_assets/<kind>（scripts/fetch_boxes_assets.py 下载）
      ③ boxes 包上一级（editable / path 安装时就是 boxes 源码根）
      ④ locale 专用：<sys.prefix>/share/locale
    """
    candidates = []
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        candidates.append(os.path.join(sys._MEIPASS, kind))
    else:
        candidates.append(os.path.join(_PROJECT_DIR, "boxes_assets", kind))
        candidates.append(os.path.join(_boxes_root(), kind))
        if kind == "locale":
            candidates.append(os.path.join(sys.prefix, "share", "locale"))
    for path in candidates:
        if os.path.isdir(path):
            return path
    return ""


# --------------------------------------------------------------------- i18n

def _parse_po(path: str) -> dict[str, str]:
    """极简 .po 解析器：返回 {msgid: msgstr}，跳过 fuzzy、空翻译、带 msgctxt 和复数条目。
    只用标准库，不依赖 msgfmt / babel。"""
    import ast

    entries: dict[str, str] = {}
    cur: dict[str, str] = {}
    key: str | None = None
    fuzzy = False

    def flush() -> None:
        nonlocal cur, fuzzy
        msgid, msgstr = cur.get("msgid"), cur.get("msgstr")
        if msgid and msgstr and not fuzzy and "msgctxt" not in cur and "msgid_plural" not in cur:
            entries[msgid] = msgstr
        cur, fuzzy = {}, False

    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line:
                if cur:
                    flush()
                continue
            if line.startswith("#,") and "fuzzy" in line:
                if cur:
                    flush()
                fuzzy = True
                continue
            if line.startswith("#"):
                continue
            m = re.match(r'(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+(".*")$', line)
            if m:
                kw = m.group(1)
                if kw == "msgid" and "msgstr" in cur:
                    flush()
                key = "msgstr" if kw.startswith("msgstr") else kw
                if key == "msgstr" and kw != "msgstr" and "msgstr" in cur:
                    key = None  # 只取复数的第一种形式（反正复数条目会被跳过）
                    continue
                cur[key] = ast.literal_eval(m.group(2))
            elif line.startswith('"') and key:
                cur[key] = cur.get(key, "") + ast.literal_eval(line)
    if cur:
        flush()
    return entries


class _PoTranslations(gettext.NullTranslations):
    """用 .po 字典做主翻译，查不到时回退到 fallback（boxes 自带 .mo）."""

    def __init__(self, catalog: dict[str, str]) -> None:
        super().__init__()
        self._catalog = catalog

    def gettext(self, message: str) -> str:
        out = self._catalog.get(message)
        if out:
            return out
        return self._fallback.gettext(message) if self._fallback else message


def _i18n_dir() -> str:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return os.path.join(sys._MEIPASS, "i18n")
    return os.path.join(_PROJECT_DIR, "i18n")


def _load_translation(lang: str = "zh_CN") -> gettext.NullTranslations:
    """翻译来源（优先级从高到低）：
    ① 本仓库 i18n/<lang>.po（上游 master 较新的翻译，见 i18n/README.md）
    ② boxes 自带的 locale/<lang>/LC_MESSAGES/boxes.py.mo"""
    mo: gettext.NullTranslations = gettext.NullTranslations()
    locale_dir = _find_asset_dir("locale")
    if locale_dir:
        try:
            mo = gettext.translation("boxes.py", localedir=locale_dir, languages=[lang])
        except FileNotFoundError:
            pass
    po_path = os.path.join(_i18n_dir(), f"{lang}.po")
    if os.path.isfile(po_path):
        try:
            primary = _PoTranslations(_parse_po(po_path))
            primary.add_fallback(mo)
            return primary
        except Exception:
            pass  # .po 损坏时不影响启动，退回 .mo
    return mo


_TRANS = _load_translation("zh_CN")
_ = _TRANS.gettext
_HAS_ZH = hasattr(_TRANS, "_catalog")


# 仅在 boxesserver 模板出现、未进入 .po 的字符串 + 修正上游误译
_EXTRA_TR = {
    "Boxes": "盒子",
    "Boxes with flex": "可弯曲盒子",
    "Trays and Drawer Inserts": "托盘与抽屉分隔",
    "Shelves": "架子",
    "WallMounted": "壁挂",
    "Hole patterns": "孔洞图案",
    "Parts and Samples": "零件与示例",
    "Misc": "其他",
    "Unstable": "实验性",
    "Generators are still untested or need manual adjustment to be useful.":
        "实验中的生成器，可能需要手动调整才能使用。",
    "Length of handle in multiples of thickness": "手柄长度（厚度倍数）",
    "Clearance of handle in multiples of thickness": "手柄间隙（厚度倍数）",
    "size of latch in multiples of thickness": "锁扣尺寸（厚度倍数）",
    "name of resulting file": "输出文件名",
    "spacing around parts (multiples of thickness [: extra space in mm])":
        "零件之间的间距（厚度倍数 [: 额外空间(mm)]）",
    "play when sliding the lid on (if applicable)": "盖子滑动余量（如适用）",
    "None": "无", "none": "无",
    "hbar": "横条", "vbar": "竖条",
    "rectangular": "矩形", "round": "圆形", "circular": "圆形",
    "square": "方形", "triangle": "三角形", "hexagon": "六边形",
    "auto": "自动",
    "left": "左", "right": "右", "top": "上", "bottom": "下",
    "center": "居中", "horizontal": "水平", "vertical": "垂直",
    "front": "前", "back": "后", "inside": "内", "outside": "外",
}

_MULT_RE = re.compile(r"\s*\(?in multiples of thickness\)?\s*")


@functools.lru_cache(maxsize=4096)
def tr(text: str) -> str:
    """多级翻译：客户端字典 → gettext → 剥离 markdown → 剥离修饰短语。
    输出已不含 markdown 链接。带 lru_cache，避免重复计算。"""
    if not text:
        return text
    if text in _EXTRA_TR:
        return _EXTRA_TR[text]
    out = _(text)
    if out != text:
        return strip_md_links(out)
    stripped = strip_md_links(text)
    if stripped != text:
        if stripped in _EXTRA_TR:
            return _EXTRA_TR[stripped]
        out2 = _(stripped)
        if out2 != stripped:
            return strip_md_links(out2)
    base = stripped if stripped != text else text
    if _MULT_RE.search(base):
        simplified = re.sub(r"\s+", " ", _MULT_RE.sub(" ", base)).strip()
        if simplified and simplified != base:
            if simplified in _EXTRA_TR:
                return _EXTRA_TR[simplified] + "（厚度倍数）"
            stem_tr = _(simplified)
            if stem_tr != simplified:
                return strip_md_links(stem_tr) + "（厚度倍数）"
    return base


# --------------------------------------------------------------------- generators

_INIT_LOCK = threading.Lock()
_INITIALIZED = False
_GENERATORS: dict[str, type[boxes.Boxes]] = {}
_FAILED_GENERATORS: list[tuple[str, str]] = []  # 加载失败的（name, reason）


def _init_generators() -> None:
    """发现所有生成器并注册到 UI groups。
    单生成器导入失败不影响整体；按双检查模式减少锁开销。"""
    global _INITIALIZED
    if _INITIALIZED:  # 锁外快路径
        return
    with _INIT_LOCK:
        if _INITIALIZED:
            return
        try:
            all_gens = gen_module.getAllBoxGenerators()
        except Exception as exc:
            # 整体发现失败 — 留空，后续调用会显示"无生成器"
            _FAILED_GENERATORS.append(("__discover__", f"{type(exc).__name__}: {exc}"))
            _INITIALIZED = True
            return
        for full_name, cls in all_gens.items():
            try:
                if not getattr(cls, "webinterface", True):
                    continue
                # 必须在 __init__ 前设类属性：boxes 生成器的 add_argument 会读
                # self.UI == "web" 决定暴露 label_text 还是 label_file。
                # 这与上游 boxesserver 的做法一致（boxes/scripts/boxesserver.py:133）。
                cls.UI = "web"
                _GENERATORS[cls.__name__] = cls
                group_name = getattr(cls, "ui_group", "Misc")
                group = gen_module.ui_groups_by_name.get(
                    group_name, gen_module.ui_groups_by_name["Misc"]
                )
                group.add(cls)
            except Exception as exc:
                _FAILED_GENERATORS.append((full_name, f"{type(exc).__name__}: {exc}"))
        _INITIALIZED = True


# get_model 结果缓存（手动摆放校验用）
import itertools as _itertools
_MODEL_CACHE: "OrderedDict[str, tuple]" = OrderedDict()
_MODEL_SEQ = _itertools.count(1)


def _project_has_content(project: dict[str, Any] | None) -> bool:
    if not project:
        return False
    return bool(project.get("disabled")) or any((project.get("edits") or {}).values())


def _coerce(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    return str(value)


def _new_instance(cls: type[boxes.Boxes]) -> boxes.Boxes:
    """实例化生成器（UI=web 已在 _init_generators 时设到类上）。"""
    instance = cls()
    instance.translations = _TRANS
    return instance


def _close_quietly(instance: boxes.Boxes) -> None:
    """忽略异常地清理 surface/ctx，避免渲染失败累积资源。"""
    try:
        if getattr(instance, "ctx", None) is not None:
            instance.close()
    except Exception:
        pass


# --------------------------------------------------------------------- images

_SAMPLES_DIR = os.path.join(_find_asset_dir("static") or os.path.join(_boxes_root(), "static"), "samples")


def _read_image_b64(filename: str) -> str | None:
    path = os.path.join(_SAMPLES_DIR, filename)
    if not os.path.isfile(path):
        return None
    mime, _enc = mimetypes.guess_type(path)
    if not mime:
        mime = "image/jpeg"
    with open(path, "rb") as f:
        data = f.read()
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


# 自渲染缩略图 LRU 缓存（避免长会话内存无限增长）
_RENDER_CACHE_MAX = 64
_RENDER_CACHE: OrderedDict[str, str] = OrderedDict()
_RENDER_LOCK = threading.Lock()


def _cache_get(name: str) -> str | None:
    with _RENDER_LOCK:
        if name in _RENDER_CACHE:
            _RENDER_CACHE.move_to_end(name)
            return _RENDER_CACHE[name]
    return None


def _cache_put(name: str, uri: str) -> None:
    with _RENDER_LOCK:
        _RENDER_CACHE[name] = uri
        _RENDER_CACHE.move_to_end(name)
        while len(_RENDER_CACHE) > _RENDER_CACHE_MAX:
            _RENDER_CACHE.popitem(last=False)


class _ArgparseError(ValueError):
    """argparse.error 的可捕获异常版本。"""


def _swallow_argparse_error(msg: str) -> None:
    raise _ArgparseError(msg)


def _render_fallback_svg(name: str) -> str | None:
    """没有官方样图时，用默认参数自渲染一张 SVG 当缩略图。"""
    cached = _cache_get(name)
    if cached is not None:
        return cached
    cls = _GENERATORS.get(name)
    if cls is None:
        return None
    instance = None
    try:
        instance = _new_instance(cls)
        # 用 ValueError 子类替换 SystemExit，避免被 BaseException 路径吞掉进程
        instance.argparser.error = _swallow_argparse_error  # type: ignore[method-assign]
        try:
            instance.parseArgs(["--format", "svg"])
        except _ArgparseError:
            return None
        instance.metadata["url"] = ""
        instance.metadata["url_short"] = ""
        instance.qr_code = False
        instance.open()
        instance.render()
        data = instance.close()
        if data is None:
            return None
        svg_bytes = data.getvalue() if hasattr(data, "getvalue") else bytes(data)
        uri = "data:image/svg+xml;base64," + base64.b64encode(svg_bytes).decode("ascii")
        _cache_put(name, uri)
        return uri
    except Exception:
        return None
    finally:
        if instance is not None:
            _close_quietly(instance)


# --------------------------------------------------------------------- API

class Api:
    def __init__(self) -> None:
        self._window: webview.Window | None = None
        self._render_lock = threading.Lock()

    def set_window(self, window: webview.Window) -> None:
        self._window = window

    # --------------------------------------------------------- meta / formats

    def ping(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "boxes_version": getattr(boxes, "__version__", "1.2"),
            "lang": "zh_CN" if _HAS_ZH else "en",
            "frozen": bool(getattr(sys, "frozen", False)),
            "failed_generators": list(_FAILED_GENERATORS),
        }

    def list_formats(self) -> dict[str, Any]:
        from boxes.formats import Formats
        fm = Formats()
        labels = {
            "svg": "SVG", "svg_Ponoko": "SVG (Ponoko)",
            "ps": "PostScript", "lbrn2": "Lightburn (lbrn2)",
            "dxf": "DXF", "gcode": "G-Code",
            "plt": "HPGL/PLT", "pdf": "PDF",
        }
        # 实际可用：base 格式总有；pstoedit 系列要 pstoedit；pdf 要 ps2pdf
        available = list(fm._BASE_FORMATS)
        if fm.pstoedit:
            available += ["dxf", "gcode", "plt"]
        if fm.ps2pdf:
            available += ["pdf"]
        formats = [{"value": fmt, "label": labels.get(fmt, fmt)} for fmt in available]
        return {
            "formats": formats,
            "pstoedit": bool(fm.pstoedit),
            "ps2pdf": bool(fm.ps2pdf),
        }

    # --------------------------------------------------------- listing

    def list_groups(self) -> list[dict[str, Any]]:
        _init_generators()
        groups = []
        for ui_group in gen_module.ui_groups:
            entries = []
            for cls in ui_group.generators:
                doc_first = (cls.__doc__ or "").strip().split("\n")[0]
                entries.append({
                    "name": cls.__name__,
                    "description": tr(doc_first) if doc_first else "",
                })
            thumbnail = ui_group.thumbnail or ""
            image = ui_group.image or ""
            if not thumbnail and entries:
                thumbnail = f"{entries[0]['name']}-thumb.jpg"
                image = entries[0]['name']
            groups.append({
                "name": ui_group.name,
                "title": tr(ui_group.title),
                "description": tr(ui_group.description),
                "thumbnail": thumbnail,
                "image": image,
                "generators": entries,
            })
        return groups

    def get_generator(self, name: str) -> dict[str, Any]:
        _init_generators()
        cls = _GENERATORS.get(name)
        if cls is None:
            return {"error": f"生成器 '{name}' 不存在"}
        try:
            instance = _new_instance(cls)
            HIDDEN = {"help", "format", "output"}
            groups: list[dict[str, Any]] = []
            for arg_group in instance.argparser._action_groups:
                params = []
                for action in arg_group._group_actions:
                    if action.dest in HIDDEN:
                        continue
                    params.append(self._describe_action(action))
                if params:
                    groups.append({
                        "title": tr(arg_group.title or ""),
                        "description": tr(arg_group.description or ""),
                        "params": params,
                    })
            doc = (cls.__doc__ or "").strip()
            return {
                "name": cls.__name__,
                "description": tr(doc) if doc else "",
                "ui_group": getattr(cls, "ui_group", "Misc"),
                "groups": groups,
            }
        except Exception as exc:
            return {"error": f"加载生成器失败：{exc}"}

    @staticmethod
    def _describe_action(action: Any) -> dict[str, Any]:
        choices = list(action.choices) if action.choices else None
        default = action.default
        type_name = "str"
        if isinstance(default, bool) or action.type is bool:
            type_name = "bool"
        elif (isinstance(default, int) and not isinstance(default, bool)) or action.type is int:
            type_name = "int"
        elif isinstance(default, float) or action.type is float:
            type_name = "float"
        if choices:
            type_name = "choice"
            tr_choices = []
            for c in choices:
                val = str(c)
                if val in _EDGE_DESCRIPTIONS:
                    label = tr(_EDGE_DESCRIPTIONS[val])
                else:
                    label = tr(val)
                tr_choices.append({"value": val, "label": label})
        else:
            tr_choices = None
        return {
            "name": action.dest,
            "type": type_name,
            "default": "" if default is None else str(default),
            "help": tr(action.help) if action.help else "",
            "choices": tr_choices,
        }

    # --------------------------------------------------------- images

    def get_thumbnail(self, name: str) -> dict[str, Any]:
        uri = _read_image_b64(f"{name}-thumb.jpg")
        if uri:
            return {"data": uri, "kind": "photo"}
        _init_generators()
        rendered = _render_fallback_svg(name)
        if rendered:
            return {"data": rendered, "kind": "rendered"}
        return {"data": "", "kind": "none"}

    def get_image(self, name: str) -> dict[str, Any]:
        uri = _read_image_b64(f"{name}.jpg")
        if uri:
            return {"data": uri, "kind": "photo"}
        _init_generators()
        rendered = _render_fallback_svg(name)
        if rendered:
            return {"data": rendered, "kind": "rendered"}
        return {"data": "", "kind": "none"}

    # --------------------------------------------------------- render

    def preview(self, name: str, params: dict[str, Any],
                project: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._render(name, params, fmt="svg", to_file=None, project=project)

    # --------------------------------------------------------- 3D / 局部修改

    def get_model(self, name: str, params: dict[str, Any]) -> dict[str, Any]:
        """每块零件的精确轮廓（名义坐标系）+ 3D 摆放矩阵.
        返回的 token 供 check_pose 复用几何（避免前端回传大量轮廓点）。"""
        result = self._render(name, params, fmt="svg", to_file=None, model=True)
        if "parts" in result:
            import copy
            token = f"m{next(_MODEL_SEQ)}"
            _MODEL_CACHE[token] = (copy.deepcopy(result["parts"]), result["thickness"])
            while len(_MODEL_CACHE) > 6:
                _MODEL_CACHE.popitem(last=False)
            result["token"] = token
        return result

    def check_pose(self, token: str, poses: dict[str, list[float]],
                   ids: list[str] | None = None) -> dict[str, Any]:
        """手动摆放后的实时校准：每块板与哪些板穿透 / 咬合."""
        cached = _MODEL_CACHE.get(token)
        if cached is None:
            return {"error": "模型已过期，请重新生成 3D 模型"}
        parts, t = cached
        try:
            return {"report": model3d.pose_report(parts, t, poses or {}, ids)}
        except Exception as exc:
            return {"error": f"校验失败：{exc}"}

    def edit_shapes(self, edits: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """把编辑（圆/方/圆角矩形/文字）转成多边形（「从外面看」坐标系）."""
        out = []
        for e in edits or []:
            try:
                polys, missing = model3d.edit_polygons(e)
                out.append({"id": e.get("id"), "polys": [[[round(x, 3), round(y, 3)] for x, y in p] for p in polys],
                            "missing": missing})
            except Exception as exc:
                out.append({"id": e.get("id"), "polys": [], "missing": [], "error": f"{exc}"})
        return out

    def list_fonts(self) -> list[dict[str, Any]]:
        try:
            return model3d.list_fonts()
        except Exception:
            return []

    def save_project(self, project: dict[str, Any]) -> dict[str, Any]:
        import json
        if self._window is None:
            return {"error": "窗口未初始化"}
        try:
            _fd = getattr(webview, "FileDialog", None)
            picked = self._window.create_file_dialog(
                _fd.SAVE if _fd else webview.SAVE_DIALOG,
                save_filename=f"{project.get('generator', 'project')}.seedbox.json",
                file_types=("SeedBoxes 项目 (*.json)", "All files (*.*)"),
            )
        except Exception as exc:
            return {"error": f"保存对话框失败: {exc}"}
        if not picked:
            return {"cancelled": True}
        if isinstance(picked, (list, tuple)):
            picked = picked[0]
        try:
            with open(picked, "w", encoding="utf-8") as f:
                json.dump(project, f, ensure_ascii=False, indent=2)
        except Exception as exc:
            return {"error": f"保存失败：{exc}"}
        return {"path": picked}

    def open_project(self) -> dict[str, Any]:
        import json
        if self._window is None:
            return {"error": "窗口未初始化"}
        try:
            _fd = getattr(webview, "FileDialog", None)
            picked = self._window.create_file_dialog(
                _fd.OPEN if _fd else webview.OPEN_DIALOG,
                file_types=("SeedBoxes 项目 (*.json)", "All files (*.*)"),
            )
        except Exception as exc:
            return {"error": f"打开对话框失败: {exc}"}
        if not picked:
            return {"cancelled": True}
        if isinstance(picked, (list, tuple)):
            picked = picked[0]
        try:
            with open(picked, encoding="utf-8") as f:
                data = json.load(f)
        except Exception as exc:
            return {"error": f"无法读取项目文件：{exc}"}
        if not isinstance(data, dict) or data.get("app") != "SeedBoxes":
            return {"error": "这不是 SeedBoxes 项目文件"}
        _init_generators()
        if data.get("generator") not in _GENERATORS:
            return {"error": f"项目使用的生成器「{data.get('generator')}」不存在"}
        return {"project": data, "path": picked}

    def save(self, name: str, params: dict[str, Any], fmt: str,
             project: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._window is None:
            return {"error": "窗口未初始化"}
        ext_map = {
            "svg": "svg", "svg_Ponoko": "svg", "ps": "ps",
            "pdf": "pdf", "dxf": "dxf", "gcode": "nc",
            "plt": "plt", "lbrn2": "lbrn2",
        }
        ext = ext_map.get(fmt, fmt)
        try:
            file_types = (f"{fmt.upper()} (*.{ext})", "All files (*.*)")
            # pywebview 5.x+ 推荐 FileDialog.SAVE，旧常量 SAVE_DIALOG 作兜底
            _file_dialog = getattr(webview, "FileDialog", None)
            save_mode = _file_dialog.SAVE if _file_dialog else webview.SAVE_DIALOG
            picked = self._window.create_file_dialog(
                save_mode,
                save_filename=f"{name}.{ext}",
                file_types=file_types,
            )
        except Exception as exc:
            return {"error": f"保存对话框失败: {exc}"}
        if not picked:
            return {"cancelled": True}
        if isinstance(picked, (list, tuple)):
            picked = picked[0]
        result = self._render(name, params, fmt=fmt, to_file=picked, project=project)
        if "error" in result:
            return result
        return {"path": picked, "notes": result.get("notes", [])}

    def open_folder(self, path: str) -> dict[str, Any]:
        if not path or not os.path.exists(path):
            return {"error": "路径不存在"}
        target = path if os.path.isdir(path) else os.path.dirname(path)
        try:
            if sys.platform == "win32":
                os.startfile(target)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                # 文件：在访达中定位并选中；目录：直接打开
                if os.path.isdir(path):
                    subprocess.Popen(["open", path])
                else:
                    subprocess.Popen(["open", "-R", path])
            else:
                subprocess.Popen(["xdg-open", target])
            return {"ok": True}
        except Exception as exc:
            return {"error": f"无法打开文件夹: {exc}"}

    # --------------------------------------------------------- helper

    def _render(self, name: str, params: dict[str, Any], fmt: str, to_file: str | None,
                project: dict[str, Any] | None = None, model: bool = False) -> dict[str, Any]:
        _init_generators()
        cls = _GENERATORS.get(name)
        if cls is None:
            return {"error": f"生成器 '{name}' 不存在"}
        with self._render_lock:
            instance = None
            try:
                instance = _new_instance(cls)
                if model:
                    # 3D 用精确名义尺寸，不加激光补偿
                    params = dict(params or {}, burn="0")
                args = self._params_to_args(instance, params, fmt)
                _captured: list[str] = []
                _orig_error = instance.argparser.error
                def _capture(msg: str) -> None:
                    _captured.append(msg)
                    raise _ArgparseError(msg)
                instance.argparser.error = _capture  # type: ignore[method-assign]
                try:
                    instance.parseArgs(args)
                except _ArgparseError:
                    msg = _captured[0] if _captured else "未知错误"
                    return {"error": f"参数无效: {msg}"}
                finally:
                    instance.argparser.error = _orig_error  # type: ignore[method-assign]
                instance.metadata["url"] = ""
                instance.metadata["url_short"] = ""
                instance.qr_code = False
                instance.open()
                need_rec = model or _project_has_content(project)
                rec = model3d.Recorder(instance) if need_rec else None
                instance.render()
                notes: list[str] = []
                if model and rec is not None:
                    parts = rec.extract()
                    summary = model3d.assemble(name, instance, parts)
                    rec.detach()
                    for p in parts:
                        p.pop("index", None)
                    return {**summary, "parts": parts}
                if rec is not None:
                    notes = model3d.apply_project(name, instance, rec, project)
                    rec.detach()
                data = instance.close()
                instance = None  # close 已成功，关闭善后
                if data is None:
                    return {"error": "渲染失败：无输出"}
                raw = data.getvalue() if hasattr(data, "getvalue") else bytes(data)
                if to_file:
                    with open(to_file, "wb") as f:
                        f.write(raw)
                    return {"ok": True, "bytes": len(raw), "notes": notes}
                if fmt in ("svg", "svg_Ponoko"):
                    return {"svg": raw.decode("utf-8"), "notes": notes}
                return {"ok": True, "bytes": len(raw), "notes": notes}
            except Exception as exc:
                # 用户友好错误，不向前端透露 trace
                return {"error": f"渲染失败：{exc}"}
            finally:
                # close 失败、render 失败、转换失败时都要清理 surface/ctx
                if instance is not None:
                    _close_quietly(instance)

    @staticmethod
    def _params_to_args(instance: boxes.Boxes, params: dict[str, Any], fmt: str) -> list[str]:
        args: list[str] = []
        skip = {"format", "output"}
        # dest → 命令行选项：大多数同名，但也有例外（TypeTray 的 gh → --gripheight）
        option_of = {}
        int_dests = set()
        for a in instance.argparser._actions:
            longs = [o for o in a.option_strings if o.startswith("--")]
            if longs:
                option_of[a.dest] = longs[0]
            if a.type is int:
                int_dests.add(a.dest)
        for key, value in (params or {}).items():
            if key in skip or key not in option_of:
                continue
            if value is None or value == "":
                continue
            text = _coerce(value)
            if key in int_dests:
                # 表单里整数默认值可能显示成 "100.0"（Keypad 的 h），argparse 的 int 不接受
                try:
                    f = float(text)
                    if f.is_integer():
                        text = str(int(f))
                except ValueError:
                    pass
            args.extend([option_of[key], text])
        args.extend(["--format", fmt])
        return args
