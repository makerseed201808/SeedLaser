@echo off
setlocal
chcp 65001 >nul
title Boxes.py 客户端 - 打包

echo.
echo ==== Boxes.py 客户端 - PyInstaller 打包 ====
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

echo [1/3] 同步依赖（含 build extras）...
set "UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple"
uv sync --extra build
if errorlevel 1 goto fail
uv run python scripts\fetch_boxes_assets.py
if errorlevel 1 goto fail

echo.
echo [2/3] 清理旧产物 ...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

echo.
echo [3/3] 运行 PyInstaller ...
uv run pyinstaller --noconfirm --clean SeedLaser.spec
if errorlevel 1 goto fail

echo.
echo ==========================================
echo  [OK] 打包完成！
echo  产物位于：dist\SeedLaser.exe
echo ==========================================
goto end

:fail
echo.
echo [X] 打包失败
:end
echo.
pause
endlocal
exit /b
