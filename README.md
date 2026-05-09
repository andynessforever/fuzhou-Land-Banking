# 左海置地资产清单看板

HTML 单文件资产看板，包含项目数据、KPI 看板、ECharts 图表及筛选功能。

## 数据说明

- 数据截止日期见页面表头标注
- 每月初更新上月数据
- 原始数据来源：左海置地运营管理部

## 本地预览

```bash
cd /path/to/this/repo
python3 -m http.server 8899
# 浏览器打开 http://localhost:8899/asset_list.html
```

## 推送说明

本仓库已配置 `post-commit` 钩子，每次 `git commit` 后自动推送到 GitHub。
