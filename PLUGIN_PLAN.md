# Excalidraw Plugin 化計画

## 目標

mcp_excalidraw の draw/setup スキルを、専用 private git repo に plugin として切り出し、
skill-forge 経由で marketplace に登録・install できるようにする。

## 方針

- **専用 plugin リポを新規作成** — MCP サーバー本体 (数十MB) を含めず、スキル定義 + 接続設定のみ (~50KB)
- mcp_excalidraw リポはソースとして維持、plugin リポはスキルの配布パッケージ

## リポ構成

```
excalidraw-plugin/                 ← 新規 private repo
├── .claude-plugin/
│   └── plugin.json                ← name: "excalidraw", v1.0.2
├── .mcp.json                      ← HTTP transport: ${EXCALIDRAW_URL}/mcp
├── skills/
│   ├── draw/
│   │   └── SKILL.md               ← mcp_excalidraw/skills/draw/ からコピー
│   └── setup/
│       └── SKILL.md               ← mcp_excalidraw/skills/setup/ からコピー
└── marketplace.json               ← source: "." (self-referencing)
```

## 実行ステップ

### Phase 1: リポ作成 + ファイル配置
- [x] `gh repo create tk-aria/excalidraw-plugin --private` で新規リポ作成
- [x] リポを clone
- [x] `.claude-plugin/plugin.json` を作成 (mcp_excalidraw のものをベース)
- [x] `.mcp.json` をコピー (HTTP transport 設定)
- [x] `skills/draw/SKILL.md` をコピー
- [x] `skills/setup/SKILL.md` をコピー
- [x] `marketplace.json` を作成 (source: ".")
- [x] commit & push

### Phase 2: marketplace 登録 + install
- [x] marketplace として登録: `~/.claude/plugins/marketplaces/excalidraw-plugin/` に sparse clone
- [x] plugin cache に配置: `~/.claude/plugins/cache/excalidraw-plugin/excalidraw/1.0.2/`
- [x] `known_marketplaces.json` 更新
- [x] `installed_plugins.json` 更新
- [x] settings の `enabledPlugins` に `"excalidraw@excalidraw-plugin": true` 追加
- [x] install scope: **user** (全プロジェクト共通)

### Phase 3: 検証
- [x] `~/.claude/plugins/cache/excalidraw-plugin/excalidraw/1.0.2/skills/` に draw/ setup/ が存在することを確認
- [x] `installed_plugins.json` に `excalidraw@excalidraw-plugin` エントリが存在することを確認
- [x] `settings.json` の `enabledPlugins` に `"excalidraw@excalidraw-plugin": true` があることを確認

## 参考: skill-forge パラメータ

```
skill-forge(
  intent: "mcp_excalidraw の既存スキル(draw, setup)を plugin 化",
  repo: "tk-aria/excalidraw-plugin",
  repo_mode: "new",
  scope: "user",
  plugin_name: "excalidraw",
  version: "1.0.2",
  skip_cleanup: true
)
```

## 注意点

- draw スキルの SKILL.md 内で EXPRESS_SERVER_URL のデフォルトが localhost:3000 になっている → .mcp.json の EXCALIDRAW_URL と整合性を確認
- plugin install 後、既存の stdio MCP 設定 (`/Users/ariatk/workspace/.mcp.json`) との競合に注意
- marketplace.json の形式は skill-forge の zundamon-video 型構成に準拠
