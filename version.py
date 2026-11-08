"""SeedLaser 版本号（唯一来源之一，和 pyproject.toml 的 version 保持一致：tests/py/test_version.py 会检查）。
窗口标题、打包（SeedLaser.spec）都从这里读；GitHub 上的自动发版（.github/workflows/release.yml）读 pyproject.toml。"""
__version__ = "0.5.0"
