"""JS↔Python 桥接 API."""
from __future__ import annotations

import base64
import functools
import gettext
import json
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
import freedesign


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


# --------------------------------------------------------------- SketchForge
# 3D 编辑器是 SketchForge-3D（AGPL-3.0）的改版静态构建，放在 web_sketchforge/。
# 它的资源路径都是绝对路径（/_next、/occt…），所以单独起一个本地静态服务器，
# 在 3D 视图里用 iframe 嵌入。端口固定（浏览器存储按端口区分），被占用时退到随机端口。

SKETCHFORGE_PORT = 47321
_SF_LOCK = threading.Lock()
_SF_URL: str | None = None


def _sketchforge_dir() -> str:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        path = os.path.join(sys._MEIPASS, "web_sketchforge")
    else:
        path = os.path.join(_PROJECT_DIR, "web_sketchforge")
    return path if os.path.isfile(os.path.join(path, "index.html")) else ""


def _start_sketchforge_server() -> str:
    """启动（只启动一次）SketchForge 静态服务器，返回根 URL；找不到构建时抛错."""
    global _SF_URL
    with _SF_LOCK:
        if _SF_URL:
            return _SF_URL
        root = _sketchforge_dir()
        if not root:
            raise FileNotFoundError("找不到 3D 编辑器文件（web_sketchforge/），请先运行 sketchforge/build.sh")
        import http.server
        import socketserver

        class Handler(http.server.SimpleHTTPRequestHandler):
            extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                              ".wasm": "application/wasm", ".js": "text/javascript",
                              ".mjs": "text/javascript", ".json": "application/json",
                              ".svg": "image/svg+xml", ".txt": "text/plain"}

            def __init__(self, *a, **kw):
                super().__init__(*a, directory=root, **kw)

            def log_message(self, *a):   # 静默
                pass

            def end_headers(self):
                self.send_header("Cache-Control", "no-cache")
                super().end_headers()

        class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        try:
            httpd = Server(("127.0.0.1", SKETCHFORGE_PORT), Handler)
        except OSError:
            httpd = Server(("127.0.0.1", 0), Handler)
        threading.Thread(target=httpd.serve_forever, name="sketchforge-http", daemon=True).start()
        _SF_URL = f"http://127.0.0.1:{httpd.server_address[1]}/"
        return _SF_URL


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
    # 术语统一（见 CLAUDE.md 术语表）：finger joint = 卡榫，不叫「榫卯结构」
    "Finger Joint": "指接卡榫",
    "Settings for Finger Joints": "指接卡榫的设置",
    "finger joints": "指接卡榫",
    "add current date etching to each piece": "在每块板件上雕刻当前日期",
    "add identifier etching to each piece": "在每块板件上雕刻编号",
    "Misc": "其他",
    "Unstable": "实验性",
    "Generators are still untested or need manual adjustment to be useful.":
        "实验中的生成器，可能需要手动调整才能使用。",
    "Length of handle in multiples of thickness": "手柄长度（厚度倍数）",
    "Clearance of handle in multiples of thickness": "手柄间隙（厚度倍数）",
    "size of latch in multiples of thickness": "锁扣尺寸（厚度倍数）",
    "name of resulting file": "输出文件名",
    "spacing around parts (multiples of thickness [: extra space in mm])":
        "板件之间的间距（厚度倍数 [: 额外空间(mm)]）",
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
        # 自由设计：不进分组列表，由首页入口打开
        freedesign.FreeDesign.UI = "web"
        _GENERATORS["FreeDesign"] = freedesign.FreeDesign
        _INITIALIZED = True


# get_model 结果缓存（手动摆放校验用）
import itertools as _itertools
_MODEL_CACHE: "OrderedDict[str, tuple]" = OrderedDict()
_MODEL_SEQ = _itertools.count(1)


def _project_has_content(project: dict[str, Any] | None) -> bool:
    if not project:
        return False
    return (bool(project.get("disabled")) or any((project.get("edits") or {}).values())
            or any(v and v.get("items") for v in (project.get("sketches") or {}).values()))


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
        svg_bytes = _as_bytes(data)
        uri = "data:image/svg+xml;base64," + base64.b64encode(svg_bytes).decode("ascii")
        _cache_put(name, uri)
        return uri
    except Exception:
        return None
    finally:
        if instance is not None:
            _close_quietly(instance)


# --------------------------------------------------------------------- API

def _write_laser_sheet(path: str, name: str, params: dict[str, Any], laser: dict[str, Any], info: list[str]) -> str:
    """在图纸旁边写一份加工参数说明（纯文本，UTF-8）."""
    import datetime
    stem, _ext = os.path.splitext(path)
    out = stem + "_加工参数.txt"
    rows = [("切割（外轮廓）", "黑色 #000000", laser["cut"]), ("切割（内孔）", "蓝色 #0000FF", laser["cut"]),
            ("雕刻（填充）", "绿色 #00FF00", laser.get("engrave") or {}), ("描线", "品红 #FF00FF", laser.get("score") or {})]
    lines = [f"SeedLaser 加工参数 — {'自由设计' if name == 'FreeDesign' else name}",
             f"图纸：{os.path.basename(path)}    生成时间：{datetime.datetime.now():%Y-%m-%d %H:%M}",
             f"材料厚度：{params.get('thickness', '3')} mm    激光补偿 burn：{params.get('burn', '0.1')} mm"
             + (f"    参考：{laser.get('preset')}" if laser.get("preset") else ""), ""]
    lines.append(f"{'图层':<12}{'颜色':<16}{'速度 mm/s':>10}{'功率 %':>8}{'遍数':>6}")
    for title, color, v in rows:
        lines.append(f"{title:<12}{color:<16}{v.get('speed', ''):>10}{v.get('power', ''):>8}{v.get('passes', ''):>6}")
    lines += ["", "红色 #FF0000 是标注（尺寸、说明），不要加工。",
              "建议加工顺序：雕刻 → 描线 → 内孔切割 → 外轮廓切割（外轮廓最后切，板件不会提前掉落移位）。",
              "参考值按 40～60W CO₂ 激光机估计；第一次请先在边角料上试切再调整。"]
    if info:
        lines += [""] + [f"· {x}" for x in info]
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return out


# ---------------------------------------------------------------- 界面偏好（新手引导看过没、折叠的面板、导出方式……）
# 网页里的 localStorage 每次启动都会清空（pywebview 默认隐私模式，而且本地服务器端口每次不同），
# 所以前端把 seedboxes.* / seedlaser.* 偏好同时存一份到 ~/.seedlaser/prefs.json，启动时再放回去。

_PREF_KEY_RE = re.compile(r"^(seedboxes|seedlaser)\.[\w.\-]{1,80}$")


def _prefs_file() -> str | None:
    """偏好文件。测试 / 调试（设了 SEEDLASER_PROJECT_DIR）时不读写用户的偏好，除非另外指定 SEEDLASER_PREFS_FILE——
    否则一个测试改的设置会带到下一个测试里。"""
    if os.environ.get("SEEDLASER_PREFS_FILE"):
        return os.environ["SEEDLASER_PREFS_FILE"]
    if os.environ.get("SEEDLASER_PROJECT_DIR"):
        return None
    return os.path.join(os.path.expanduser("~"), ".seedlaser", "prefs.json")


def load_prefs() -> dict[str, str]:
    path = _prefs_file()
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return {k: v for k, v in data.items() if isinstance(k, str) and _PREF_KEY_RE.match(k) and isinstance(v, str)} if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_pref(key: str, value: str | None) -> bool:
    if not isinstance(key, str) or not _PREF_KEY_RE.match(key):
        return False
    if value is not None and (not isinstance(value, str) or len(value) > 20000):
        return False
    path = _prefs_file()
    if not path:
        return False
    prefs = load_prefs()
    if value is None:
        prefs.pop(key, None)
    else:
        prefs[key] = value
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(prefs, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
        return True
    except Exception:
        return False                         # 存不下偏好不影响使用


# ---------------------------------------------------------------- 最近项目（主页用）
# 存在用户目录下（~/.seedlaser/recent.json），最多 12 条

_RECENT_MAX = 12


def _recent_file() -> str:
    return os.path.join(os.path.expanduser("~"), ".seedlaser", "recent.json")


def _load_recent() -> list[dict[str, Any]]:
    import json
    try:
        with open(_recent_file(), encoding="utf-8") as f:
            data = json.load(f)
        return [r for r in data if isinstance(r, dict) and r.get("path")] if isinstance(data, list) else []
    except Exception:
        return []


def _save_recent(items: list[dict[str, Any]]) -> None:
    import json
    try:
        os.makedirs(os.path.dirname(_recent_file()), exist_ok=True)
        with open(_recent_file(), "w", encoding="utf-8") as f:
            json.dump(items[:_RECENT_MAX], f, ensure_ascii=False, indent=1)
    except Exception:
        pass   # 记不住最近项目不影响使用


# ---- 项目文件版本 ----
# 1：SeedBoxes / v0.2.0 时期（没写 version 的也当 1）
# 2：补齐所有字段（disabled / edits / poses / sketches / params / format；自由设计的 free.parts / sheet / loose），app 统一为 SeedLaser
PROJECT_VERSION = 2


def _migrate_project(data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """把旧版本的项目数据升级到当前版本（不改原文件；保存时才写新版本）。返回 (新数据, 提示)。"""
    import copy
    d = copy.deepcopy(data)
    notes: list[str] = []
    try:
        v = int(d.get("version") or 1)
    except (TypeError, ValueError):
        v = 1
    if v > PROJECT_VERSION:
        notes.append(f"这个项目是用更新版本的 SeedLaser 保存的（文件版本 {v}），有些内容可能显示不全")
        return d, notes
    if v < 2:
        for k, empty in (("params", {}), ("disabled", []), ("edits", {}), ("poses", {}), ("sketches", {})):
            if not isinstance(d.get(k), type(empty)):
                d[k] = copy.deepcopy(empty)
        d.setdefault("format", "svg")
        if d.get("generator") == "FreeDesign":
            free = d.get("free") if isinstance(d.get("free"), dict) else {}
            free.setdefault("parts", [])
            sheet = free.get("sheet") if isinstance(free.get("sheet"), dict) else {}
            sheet.setdefault("w", 400)
            sheet.setdefault("h", 300)
            free["sheet"] = sheet
            if not isinstance(free.get("loose"), list):
                free["loose"] = []
            d["free"] = free
        elif "free" not in d:
            d["free"] = None
        d["app"] = "SeedLaser"
        d["version"] = 2
    return d, notes


PROJECT_EXT = ".seedlaser"     # 项目文件扩展名（内容是 JSON）；旧版的 .seedbox.json 照样能打开
_EXT_RE = re.compile(r"\.seedlaser$|\.seedbox\.json$|\.json$", re.I)
_OPEN_TYPES = ("SeedLaser 项目 (*.seedlaser;*.json)", "All files (*.*)")
_SAVE_TYPES = ("SeedLaser 项目 (*.seedlaser)",)


def project_stem(path_or_name: str) -> str:
    """文件名去掉项目扩展名（.seedlaser / 旧版 .seedbox.json / .json）."""
    return _EXT_RE.sub("", os.path.basename(str(path_or_name)))


def project_dir() -> str:
    """默认的项目文件夹：「文稿/SeedLaser」（测试时用 SEEDLASER_PROJECT_DIR）."""
    return os.environ.get("SEEDLASER_PROJECT_DIR") or os.path.join(os.path.expanduser("~"), "Documents", "SeedLaser")


LIB_EXT = ".seedlaser-shape"


def library_dir() -> str:
    """「我的图库」：项目文件夹下的「图库」，每个图形一个 .seedlaser-shape（JSON）。"""
    return os.path.join(project_dir(), "图库")


def _lib_safe_name(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", str(name or "").strip()).strip(". ")
    return name[:60] or "未命名图形"


def launch_file_from_argv(argv: list[str]) -> str | None:
    """命令行 / 双击项目文件启动时带进来的项目路径（.seedlaser，旧版 .seedbox.json）。"""
    for a in argv[1:]:
        if isinstance(a, str) and _EXT_RE.search(a) and os.path.isfile(a):
            return os.path.abspath(a)
    return None


def _remember_recent(path: str, project: dict[str, Any]) -> None:
    import time
    path = os.path.abspath(path)
    gen = project.get("generator") or ""
    free = project.get("free") or {}
    n = len(free.get("parts") or []) if gen == "FreeDesign" else None
    item = {"path": path, "name": project_stem(path),
            "generator": gen, "parts": n, "time": int(time.time())}
    _save_recent([item] + [r for r in _load_recent() if os.path.abspath(r.get("path", "")) != path])


def _forget_recent(path: str) -> None:
    path = os.path.abspath(path)
    _save_recent([r for r in _load_recent() if os.path.abspath(r.get("path", "")) != path])



def _as_bytes(data):
    """Boxes 的 close() 可能返回 BytesIO、文件对象（DXF 等经 pstoedit 转换的格式）或 bytes。"""
    if hasattr(data, "getvalue"):
        return data.getvalue()
    if hasattr(data, "read"):
        try:
            return data.read()
        finally:
            try:
                data.close()
            except Exception:
                pass
    return bytes(data)

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
        available = list(fm._BASE_FORMATS) + ["dxf"]      # DXF 内置转换（dxfout.py），总是可用
        if fm.pstoedit:
            available += ["gcode", "plt"]
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
            only = {"thickness", "burn", "reference", "sheet_w", "sheet_h", "part_gap", "common_line"} if name == "FreeDesign" else None
            groups: list[dict[str, Any]] = []
            for arg_group in instance.argparser._action_groups:
                params = []
                for action in arg_group._group_actions:
                    if action.dest in HIDDEN or (only is not None and action.dest not in only):
                        continue
                    params.append(self._describe_action(action))
                if params:
                    title = arg_group.title or ""
                    groups.append({
                        "title": "排版（材料尺寸）" if title == "FreeDesign Settings" else tr(title),
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

    def get_model(self, name: str, params: dict[str, Any], project: dict[str, Any] | None = None) -> dict[str, Any]:
        """每块零件的精确轮廓（名义坐标系）+ 3D 摆放矩阵.
        返回的 token 供 check_pose 复用几何（避免前端回传大量轮廓点）。
        自由设计（FreeDesign）的板件来自 project。"""
        result = self._render(name, params, fmt="svg", to_file=None, model=True, project=project)
        if "parts" in result:
            import copy
            token = f"m{next(_MODEL_SEQ)}"
            _MODEL_CACHE[token] = (copy.deepcopy(result["parts"]), result["thickness"])
            while len(_MODEL_CACHE) > 6:
                _MODEL_CACHE.popitem(last=False)
            result["token"] = token
        return result

    def check_pose(self, token: str, poses: dict[str, list[float]],
                   ids: list[str] | None = None, sketches: dict[str, Any] | None = None) -> dict[str, Any]:
        """手动摆放后的实时校准：每块板与哪些板穿透 / 咬合（有二维草图的板用草图轮廓）."""
        cached = _MODEL_CACHE.get(token)
        if cached is None:
            return {"error": "模型已过期，请重新生成 3D 模型"}
        parts, t = cached
        try:
            parts = model3d.parts_with_sketches(parts, sketches)
            return {"report": model3d.pose_report(parts, t, poses or {}, ids)}
        except Exception as exc:
            return {"error": f"校验失败：{exc}"}

    def sketchforge_url(self) -> dict[str, Any]:
        """3D 编辑器（SketchForge）地址；首次调用时启动本地静态服务器."""
        try:
            return {"url": _start_sketchforge_server() + "?editor=1&embed=seedboxes"}
        except Exception as exc:
            return {"error": f"3D 编辑器启动失败：{exc}"}

    def nest_rects(self, rects: list, sheet_w: float, sheet_h: float, gap: float = 2.0) -> dict[str, Any]:
        """二维画板「自动排版」：rects = [{id, w, h}] → {placed: [{id, sheet, x, y, rot}], sheets, too_big: [id]}（和加工作业的排料同一个算法）."""
        try:
            items = [(str(r["id"]), float(r["w"]), float(r["h"])) for r in rects]
            placed, n, too_big = freedesign.nest_rects(items, float(sheet_w), float(sheet_h), max(0.0, float(gap)))
        except Exception as exc:
            return {"error": f"排版失败：{exc}"}
        return {"placed": [{"id": k, "sheet": si, "x": x, "y": y, "rot": bool(rot)} for k, si, x, y, rot in placed],
                "sheets": n, "too_big": list(too_big)}

    def code_paths(self, kind: str, text: str, size: float, height: float | None = None, ec: str = "M") -> dict[str, Any]:
        """二维画板：二维码（kind='qr'，size = 边长）/ Code 128 条形码（kind='bar'，size = 宽度）→ 轮廓（mm，以原点为中心）."""
        try:
            import codes2d
            return codes2d.code_paths(kind, str(text or ""), float(size), float(height) if height else None, ec or "M")
        except ValueError as exc:
            return {"error": str(exc)}
        except Exception as exc:
            return {"error": f"生成失败：{exc}"}

    def lib_list(self) -> dict[str, Any]:
        """「我的图库」里的图形：[{name, file, items}]，按修改时间新的在前."""
        d = library_dir()
        out = []
        try:
            files = [f for f in os.listdir(d) if f.endswith(LIB_EXT)]
        except OSError:
            files = []
        for f in files:
            fp = os.path.join(d, f)
            try:
                with open(fp, encoding="utf-8") as fh:
                    data = json.load(fh)
                out.append({"name": data.get("name") or f[: -len(LIB_EXT)], "file": f, "items": data.get("items") or [],
                            "mtime": os.path.getmtime(fp)})
            except (OSError, ValueError) as exc:
                print(f"图库文件读不了 {fp}：{exc}", file=sys.stderr)
        out.sort(key=lambda x: -x["mtime"])
        return {"dir": d, "items": out}

    def lib_save(self, name: str, items: list) -> dict[str, Any]:
        """把选中的图形存进「我的图库」；重名时自动加 (2)、(3)…，不覆盖."""
        if not items:
            return {"error": "没有可保存的图形"}
        d = library_dir()
        try:
            os.makedirs(d, exist_ok=True)
            base = _lib_safe_name(name)
            nm, i = base, 2
            while os.path.exists(os.path.join(d, nm + LIB_EXT)):
                nm, i = f"{base} ({i})", i + 1
            with open(os.path.join(d, nm + LIB_EXT), "w", encoding="utf-8") as fh:
                json.dump({"format": "seedlaser-shape", "version": 1, "name": nm, "items": items}, fh, ensure_ascii=False)
            return {"ok": True, "name": nm, "file": nm + LIB_EXT}
        except OSError as exc:
            return {"error": f"保存失败：{exc}"}

    def lib_delete(self, file: str) -> dict[str, Any]:
        """删除「我的图库」里的一个图形（只能删图库文件夹里的 .seedlaser-shape）."""
        f = os.path.basename(str(file or ""))
        if not f.endswith(LIB_EXT):
            return {"error": "不是图库文件"}
        try:
            os.remove(os.path.join(library_dir(), f))
            return {"ok": True}
        except OSError as exc:
            return {"error": f"删除失败：{exc}"}

    def sketch_offset(self, paths: list[dict[str, Any]], distance: float, join: str = "round") -> dict[str, Any]:
        """二维草图：轮廓偏移（外扩 / 内缩）."""
        try:
            import sketch2d
            return {"rings": sketch2d.offset(paths, float(distance), join)}
        except Exception as exc:
            return {"error": f"偏移失败：{exc}"}

    def trace_rects(self, rects: list, w: int, h: int, smooth: float = 1.0, min_area: float = 4.0,
                    width_mm: float = 50.0) -> dict[str, Any]:
        """二维草图：位图描摹（前端已二值化成矩形）→ 矢量多边形."""
        try:
            import sketch2d
            return sketch2d.trace_rects(rects, int(w), int(h), float(smooth), float(min_area), float(width_mm))
        except Exception as exc:
            return {"error": f"描摹失败：{exc}"}

    def text_layout(self, opts: dict[str, Any]) -> dict[str, Any]:
        """二维草图：文字排版（多行、字距、圆弧、沿路径、焊接）→ 轮廓."""
        try:
            import sketch2d
            o = opts or {}
            return sketch2d.text_layout(str(o.get("text", "")), o.get("font") or "", float(o.get("size", 10)),
                                        float(o.get("spacing", 0) or 0), float(o.get("lineHeight", 1.25) or 1.25),
                                        o.get("align") or "center", float(o.get("arc", 0) or 0), o.get("path"),
                                        bool(o.get("weld")), bool(o.get("bold")), bool(o.get("italic")), bool(o.get("vertical")))
        except Exception as exc:
            return {"error": f"文字排版失败：{exc}"}

    def text_outline(self, text: str, font: str, size: float) -> dict[str, Any]:
        """二维草图：文字转轮廓（以文字中心为原点，y 向上）."""
        try:
            polys, missing = model3d.text_polygons(str(text), font or "", float(size))
            return {"polys": [[[round(x, 3), round(y, 3)] for x, y in p] for p in polys], "missing": missing}
        except Exception as exc:
            return {"error": f"文字转轮廓失败：{exc}"}

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

    # ---- 文件对话框（统一入口；浏览器调试 / 自动测试时没有窗口，用 dev_set_pick 预先给出路径）----
    def set_launch_file(self, path: str | None) -> None:
        self._launch_file = path

    def launch_file(self) -> dict[str, Any]:
        """前端启动时取一次：双击项目文件打开 SeedLaser 时要打开的文件（取过就清掉）."""
        path = getattr(self, "_launch_file", None)
        self._launch_file = None
        return {"path": path}

    def dev_set_pick(self, path: str | None) -> dict[str, Any]:
        """只在没有窗口（调试服务器）时有效：下一次文件对话框直接返回这个路径（None = 取消）."""
        if self._window is not None:
            return {"error": "只能在调试模式使用"}
        self._test_pick = [path]
        return {"ok": True}

    def _pick(self, save: bool, filename: str = "", file_types: tuple = (), directory: str = "") -> Any:
        if self._window is None:
            q = getattr(self, "_test_pick", None)
            if q:
                return q.pop(0)
            raise RuntimeError("窗口未初始化")
        _fd = getattr(webview, "FileDialog", None)
        if save:
            mode = _fd.SAVE if _fd else webview.SAVE_DIALOG
            picked = self._window.create_file_dialog(mode, directory=directory, save_filename=filename, file_types=file_types)
        else:
            mode = _fd.OPEN if _fd else webview.OPEN_DIALOG
            picked = self._window.create_file_dialog(mode, directory=directory, file_types=file_types)
        if isinstance(picked, (list, tuple)):
            picked = picked[0] if picked else None
        return picked

    def save_project(self, project: dict[str, Any], path: str | None = None, name: str | None = None) -> dict[str, Any]:
        """保存项目。给了 path（「保存」，已经有文件）就直接写；否则弹另存为对话框，name 是建议的文件名."""
        import json
        picked = path
        if not picked:
            base = (name or project.get("name") or ("我的设计" if project.get("generator") == "FreeDesign" else project.get("generator", "project")))
            base = project_stem(base)
            try:
                folder = project_dir()
                os.makedirs(folder, exist_ok=True)
                picked = self._pick(True, f"{base}{PROJECT_EXT}", _SAVE_TYPES, folder)
            except Exception as exc:
                return {"error": f"保存对话框失败: {exc}"}
            if not picked:
                return {"cancelled": True}
            picked = str(picked)
            # 另存为一律用新扩展名（对话框里留着旧的 .json 也换掉）
            picked = os.path.join(os.path.dirname(picked), project_stem(picked) + PROJECT_EXT)
        try:
            with open(picked, "w", encoding="utf-8") as f:
                json.dump(project, f, ensure_ascii=False, indent=2)
        except Exception as exc:
            return {"error": f"保存失败：{exc}"}
        _remember_recent(picked, project)
        return {"path": picked}

    def save_project_named(self, project: dict[str, Any], name: str, current: str | None = None) -> dict[str, Any]:
        """在标题上直接输入名字保存：
        还没有文件 → 存到「文稿/SeedLaser」（或 SEEDLASER_PROJECT_DIR）；已经有文件 → 在同一文件夹里改名并保存。
        已有同名文件时不覆盖，返回 {exists: True}。"""
        import json
        name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", str(name or "")).strip().strip(".")
        name = project_stem(name).strip()
        if not name:
            return {"error": "名字不能为空，也不能只有 / \\ : * ? \" < > | 这些符号"}
        if len(name) > 80:
            name = name[:80]
        if current and os.path.isdir(os.path.dirname(current)):
            folder = os.path.dirname(os.path.abspath(current))
        else:
            folder = project_dir()
        target = os.path.join(folder, f"{name}{PROJECT_EXT}")
        same = bool(current) and os.path.abspath(current) == os.path.abspath(target)
        if not same and os.path.exists(target):
            return {"exists": True, "path": target, "error": f"「{name}」已经有了（{folder}），换个名字，或用「文件 → 另存为」"}
        try:
            os.makedirs(folder, exist_ok=True)
            tmp = target + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(project, f, ensure_ascii=False, indent=2)
            os.replace(tmp, target)
        except Exception as exc:
            return {"error": f"保存失败：{exc}"}
        renamed = bool(current) and not same and os.path.exists(current)
        if renamed:          # 改名：新文件写好后再删旧文件
            try:
                os.remove(current)
            except Exception:
                pass
            _forget_recent(current)
        _remember_recent(target, project)
        return {"path": target, "folder": folder, "renamed": renamed}

    def open_project(self) -> dict[str, Any]:
        try:
            folder = project_dir()
            picked = self._pick(False, "", _OPEN_TYPES, folder if os.path.isdir(folder) else "")
        except Exception as exc:
            return {"error": f"打开对话框失败: {exc}"}
        if not picked:
            return {"cancelled": True}
        return self.open_project_path(picked)

    def open_project_path(self, path: str) -> dict[str, Any]:
        """按路径打开项目（主页「最近项目」用）。SeedBoxes 时期保存的项目照样能打开。"""
        import json
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            _forget_recent(path)
            return {"error": "文件不在了（可能被移动或删除），已从最近项目里去掉"}
        except Exception as exc:
            return {"error": f"无法读取项目文件：{exc}"}
        if not isinstance(data, dict) or data.get("app") not in ("SeedLaser", "SeedBoxes"):
            return {"error": "这不是 SeedLaser 项目文件"}
        _init_generators()
        if data.get("generator") not in _GENERATORS:
            return {"error": f"项目使用的生成器「{data.get('generator')}」不存在"}
        old_v = data.get("version") or 1
        data, notes = _migrate_project(data)
        _remember_recent(path, data)
        out: dict[str, Any] = {"project": data, "path": path}
        if old_v != data.get("version"):
            out["migrated_from"] = old_v
        if notes:
            out["warning"] = "；".join(notes)
        return out

    def get_prefs(self) -> dict[str, str]:
        """界面偏好（启动时放回 localStorage）."""
        return load_prefs()

    def set_pref(self, key: str, value: str | None = None) -> dict[str, Any]:
        """存一条界面偏好；value = None 删除."""
        return {"ok": save_pref(key, value)}

    def recent_projects(self) -> list[dict[str, Any]]:
        """主页「最近项目」：最近打开 / 保存过的项目，最新的在前。"""
        out = []
        for r in _load_recent():
            p = r.get("path", "")
            out.append({**r, "exists": bool(p) and os.path.exists(p)})
        return out

    def save(self, name: str, params: dict[str, Any], fmt: str,
             project: dict[str, Any] | None = None, laser: dict[str, Any] | None = None,
             filename: str | None = None) -> dict[str, Any]:
        """导出图纸（SVG / DXF / PDF / LBRN2 …）。filename = 建议的文件名（不含扩展名）."""
        ext_map = {
            "svg": "svg", "svg_Ponoko": "svg", "ps": "ps",
            "pdf": "pdf", "dxf": "dxf", "gcode": "nc",
            "plt": "plt", "lbrn2": "lbrn2",
        }
        ext = ext_map.get(fmt, fmt)
        try:
            file_types = (f"{fmt.upper()} (*.{ext})", "All files (*.*)")
            picked = self._pick(True, f"{filename or name}.{ext}", file_types)
        except Exception as exc:
            return {"error": f"保存对话框失败: {exc}"}
        if not picked:
            return {"cancelled": True}
        if fmt == "dxf":
            # DXF 用内置转换（SVG → DXF R12，按切割 / 雕刻 / 描线分图层，单位 mm），不依赖 pstoedit
            result = self._render(name, params, fmt="svg", to_file=None, project=project, clean=True)
            if "error" in result:
                return result
            try:
                import dxfout
                with open(picked, "wb") as f:
                    f.write(dxfout.svg_to_dxf_bytes(result["svg"]))
            except Exception as exc:
                return {"error": f"DXF 导出失败：{exc}"}
        else:
            result = self._render(name, params, fmt=fmt, to_file=picked, project=project, clean=True)
        if "error" in result:
            return result
        out = {"path": picked, "notes": result.get("notes", []) + result.get("warnings", []), "info": result.get("info", [])}
        if laser and laser.get("cut"):
            try:
                out["sidecar"] = _write_laser_sheet(picked, name, params, laser, result.get("info") or [])
            except Exception as exc:
                out["notes"] = out["notes"] + [f"加工参数说明没写成：{exc}"]
        return out

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
                project: dict[str, Any] | None = None, model: bool = False, clean: bool = False) -> dict[str, Any]:
        """clean = 导出给激光机：自由设计只输出画的图形（不要校准尺、材料边框和标注文字）."""
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
                if name == "FreeDesign" and clean:
                    instance.reference = 0          # 不画 100 mm 校准尺
                    instance.clean = True           # 不画材料边框、材料标注
                if name == "FreeDesign":
                    if model:
                        parts = freedesign.model_parts(project)
                        return {"assembled": False, "dims": None, "bounds": None, "free": True,
                                "thickness": float(instance.thickness), "parts": parts}
                    instance.design = project or {}
                    instance.open()
                    instance.render()
                    info = list(instance.notes)
                    warn = list(getattr(instance, "warnings", []))      # 需要用户注意的（导出时在提示里显示）
                    data = instance.close()
                    instance = None
                    if data is None:
                        return {"error": "渲染失败：无输出"}
                    raw = _as_bytes(data)
                    if to_file:
                        with open(to_file, "wb") as f:
                            f.write(raw)
                        return {"ok": True, "bytes": len(raw), "notes": [], "warnings": warn, "info": info}
                    if fmt in ("svg", "svg_Ponoko"):
                        return {"svg": raw.decode("utf-8"), "notes": [], "warnings": warn, "info": info}
                    return {"ok": True, "bytes": len(raw), "notes": [], "warnings": warn, "info": info}
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
                raw = _as_bytes(data)
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
