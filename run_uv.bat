@echo off
setlocal
chcp 65001 >nul
title Boxes.py 客户端 (开发模式)

echo.
echo ==== Boxes.py 客户端 (开发模式) ====
echo.

cd /d "%~dp0"

rem ---- 检查 uv ----
where uv >nul 2>&1
if errorlevel 1 (
    if exist "..\boxes-1.2\uv-bin\uv.exe" (
        set "PATH=%~dp0..\boxes-1.2\uv-bin;%PATH%"
        echo [*] 使用 boxes-1.2\uv-bin 中的 uv
    ) else (
        echo [X] 未找到 uv，请先安装：winget install --id=astral-sh.uv -e
        goto end
    )
)

echo [1/2] 同步依赖 (uv sync) ...
set "UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple"
uv sync
if errorlevel 1 (
    echo [X] uv sync 失败
    goto end
)

echo [*] 准备 boxes 资源（作品照片 + 中文翻译，首次需联网）...
uv run python scripts\fetch_boxes_assets.py
if errorlevel 1 goto end

echo.
echo [2/2] 启动客户端 ...
uv run python app.py

:end
echo.
pause
endlocal
exit /b