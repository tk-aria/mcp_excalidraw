# Excalidraw MCP: 双方向同期 実装計画レポート

## 背景

yctimlin/mcp_excalidraw のCanvasサーバーは、AIエージェント(MCP) → ブラウザへの一方向同期のみ対応。
複数ユーザーがブラウザ上で同時に描画・削除した場合、変更が正しく伝播しない問題がある。

### 確認された問題

1. ユーザーAの変更がBに反映された後、Bの変更がAに上書きされて消える
2. 消しゴム（要素削除）が他クライアントに伝播しない
3. `getSceneElements()` が `NonDeletedExcalidrawElement[]` を返すため、削除済み要素を検出できない

---

## 案A: 自前Delta同期

### 概要

全状態同期（HTTP POST `/api/elements/sync`）を廃止し、
`onChange` で前回との差分（追加/更新/削除）を検出してWebSocketで送信する。

### アーキテクチャ

```
[Client A]                    [Server]                    [Client B]
    |                            |                            |
    | onChange fires             |                            |
    | diff(prev, current)       |                            |
    |   added: [elem5]          |                            |
    |   modified: [elem2]       |                            |
    |   deleted: ["id-3"]       |                            |
    |                            |                            |
    | WS: client_delta -------->| apply to elements Map      |
    |                            | WS: server_delta -------->|
    |                            |                    apply delta
```

### 変更箇所

#### server.ts
- `broadcastExcept(sender, msg)` 関数追加（送信元以外にbroadcast）
- `ws.on('message', ...)` ハンドラ追加
  - `client_delta` を受信 → elements Mapに適用 → 他クライアントにbroadcast

#### frontend/src/App.tsx
- `prevElementsRef: Map<string, element>` 追加（前回シーン状態）
- `suppressDeltaRef: boolean` 追加（無限ループ防止フラグ）
- `onChange` を差分検出に変更:
  - `current - prev` = added
  - `prev ∩ current (version違い)` = modified
  - `prev - current` = deleted
- `server_delta` 受信ハンドラ追加

#### types.ts
- `client_delta` / `server_delta` メッセージ型追加

### 無限ループ防止

```
サーバーからdelta受信
→ suppressDeltaRef = true
→ updateScene() → onChange発火
→ suppressDeltaRef === true → delta送信をskip
→ setTimeout(() => suppressDeltaRef = false, 0)
```

### メリット
- 外部依存なし
- 変更箇所が少ない
- 軽量（差分のみ送信）

### デメリット
- 競合解決はLast Write Wins（同時編集で片方が負ける）
- オフライン→復帰時の整合性は未対応
- ループ防止・削除伝播などの edge case を自前で全てカバーする必要がある
- テスト・デバッグコストが高い

### 工数見積
- 実装: server.ts + App.tsx + types.ts の3ファイル
- 主な作業: delta検出ロジック、ループ防止、削除伝播

---

## 案B: Yjs (CRDT) 導入

### 概要

CRDT (Conflict-free Replicated Data Types) ライブラリ Yjs を導入。
要素の同期・競合解決・削除伝播を全て Yjs に委譲する。

### Yjsとは

- 最も広く使われるJavaScript向けCRDTライブラリ
- Figma, Notion 等が同種のCRDTアルゴリズムを採用
- `Y.Map`, `Y.Array` 等の共有データ構造を提供
- 変更は自動的にdelta（update）としてエンコード・配信
- 競合解決が数学的に保証されている（commutativity, idempotency）

### アーキテクチャ

```
[Client A]                [y-websocket Server]              [Client B]
    |                            |                              |
    | Y.Doc (shared state)       | Y.Doc (authoritative)       | Y.Doc (shared state)
    | yElements.set(id, el)  --> | auto-merge & broadcast  --> | observe → updateScene
    | yElements.delete(id)   --> | auto-merge & broadcast  --> | observe → filter scene
    |                            |                              |
    |                     [MCP Server (REST API)]               |
    |                       also writes to Y.Doc                |
    |                       via y-websocket provider             |
```

### 変更箇所

#### 新規依存パッケージ
```
yjs                  - CRDTコアライブラリ
y-websocket          - WebSocket同期プロバイダ（サーバー+クライアント）
```

#### server.ts
- 既存の `elements: Map` を `Y.Doc` の `Y.Map` に置換
- 既存のREST APIエンドポイントは `yElements.set()` / `yElements.delete()` に書き換え
- `y-websocket` のサーバー機能を既存HTTPサーバーに統合
- 既存の手動 `broadcast()` は不要になる（Yjsが自動配信）
- MCP toolからの書き込みもY.Doc経由にすることで自動的にブラウザに反映

#### frontend/src/App.tsx
- `WebsocketProvider` でサーバーに接続
- `yElements.observe()` で変更監視 → Excalidrawのシーンに反映
- Excalidrawの `onChange` → `yElements.set()` / `yElements.delete()` で書き戻し
- 既存の `syncToBackend` (HTTP POST) は廃止
- 無限ループ防止: Yjs の `origin` パラメータで自己変更を判別

#### types.ts
- WebSocketメッセージ型の一部が不要に（Yjsが独自プロトコルを使用）

### 無限ループ防止（Yjs組み込み）

```typescript
// 書き込み時に origin を設定
ydoc.transact(() => {
  yElements.set(id, element)
}, 'local')

// observe で origin を判別
yElements.observe(event => {
  if (event.transaction.origin === 'remote') {
    // サーバーから来た変更のみ Excalidraw に反映
    applyToExcalidraw(event.changes)
  }
  // 'local' origin はスキップ → ループしない
})
```

### 削除の扱い

```typescript
// 消しゴムで要素削除 → onChange で検出
// prev にあって current にないID → yElements.delete(id)
// Yjs が自動で全クライアントに伝播
// observe で削除イベントを受信 → Excalidraw シーンから除去
```

### MCP/REST APIとの統合

```typescript
// MCP tool: create_element
app.post('/api/elements', (req, res) => {
  const element = processElement(req.body)
  ydoc.transact(() => {
    yElements.set(element.id, element)
  }, 'mcp')
  // → Yjs が自動で全ブラウザクライアントに配信
  res.json({ success: true, element })
})
```

### メリット
- 競合解決が数学的に保証されている
- 削除・追加・更新の伝播が全て自動
- 無限ループ防止が `origin` パラメータで簡潔
- オフライン→復帰時の自動マージ対応
- 将来的にP2P対応も可能（y-webrtc）
- 広く使われておりバトルテスト済み

### デメリット
- 依存パッケージ追加（yjs, y-websocket）
- 既存のelements Map / broadcast / sync系コードの大幅書き換え
- REST APIの全エンドポイントをY.Doc経由に修正する必要あり（24エンドポイント中、elements関連11個）
- Yjsのデータモデルへの理解が必要

### 工数見積
- 実装: server.ts の大幅改修 + App.tsx の同期ロジック書き換え
- REST APIエンドポイント 11個の書き換え
- テスト: 双方向同期 + MCP操作 + 削除伝播

---

## 比較まとめ

| 観点 | 案A: 自前Delta | 案B: Yjs |
|------|----------------|----------|
| 競合解決 | Last Write Wins | CRDT（数学的保証） |
| 削除伝播 | 自前実装（prev diff） | 自動 |
| ループ防止 | suppressフラグ（自前） | origin パラメータ（組み込み） |
| オフライン対応 | なし | 自動マージ |
| 外部依存 | なし | yjs, y-websocket |
| 変更規模 | 小〜中 | 中〜大 |
| 保守性 | edge case が増えるたびに対応 | Yjsに委譲 |
| 信頼性 | 自前テスト次第 | 広く利用されたライブラリ |

## 採用方針

**案B (Yjs)** を採用。
理由: 今後の拡張性・信頼性・保守性を考慮し、確立されたCRDTライブラリに同期ロジックを委譲する。
