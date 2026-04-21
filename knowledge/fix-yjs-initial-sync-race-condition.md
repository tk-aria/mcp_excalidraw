# Yjs 初回同期のレースコンディション修正

## 問題

複数の Web クライアント間で Excalidraw の図が同期されない。
新規の変更はリアルタイムで反映されるが、既存の要素が他のクライアントに表示されない。

## 根本原因

Yjs の初回同期と `excalidrawAPI` の初期化にレースコンディションがあった。

### 発生メカニズム

```
コンポーネントマウント
  │
  ├── useEffect([]) → Yjs 初期化
  │     ├── WebsocketProvider 接続
  │     ├── サーバから全要素受信 (初回同期)
  │     └── yElements.observe() 発火
  │           └── excalidrawAPIRef.current === null ← API 未初期化
  │               └── return (全要素が無視される)
  │
  ├── Excalidraw コンポーネントレンダリング
  │     └── excalidrawAPI コールバック発火
  │           └── setExcalidrawAPI(api) ← ここで初めて API が使える
  │                 └── 以降の新規変更は正常に同期
  │                     しかし初回同期分は既に失われている
```

`useEffect([], [])` は Excalidraw コンポーネントの `excalidrawAPI` コールバックより先に実行される。
Yjs の WebSocket 同期は非常に高速なため、API 初期化前に初回同期が完了してしまう。

## 修正内容

`excalidrawAPI` が設定されたタイミングで、Yjs の Y.Map に既に存在する全要素をシーンに適用。

### 変更箇所

`frontend/src/App.tsx` — `useEffect([excalidrawAPI])` 内:

```typescript
useEffect(() => {
  excalidrawAPIRef.current = excalidrawAPI

  // API 準備完了時に、Yjs に既に届いている要素を適用
  if (excalidrawAPI && yElementsRef.current) {
    const yElements = yElementsRef.current
    if (yElements.size > 0) {
      suppressYjsSyncRef.current = true
      const currentMap = new Map()
      yElements.forEach((val, key) => {
        currentMap.set(key, cleanElementForExcalidraw(val))
      })
      const merged = Array.from(currentMap.values())
      const converted = convertElementsPreservingImageProps(merged)
      applySceneUpdateWithoutAutoSync(excalidrawAPI, {
        elements: converted,
        captureUpdate: CaptureUpdateAction.NEVER
      })
      // nonce tracking 更新
      const newPrev = new Map()
      excalidrawAPI.getSceneElements().forEach(el => {
        newPrev.set(el.id, el.versionNonce)
      })
      prevElementNoncesRef.current = newPrev
      setTimeout(() => { suppressYjsSyncRef.current = false }, 0)
    }
  }
}, [excalidrawAPI])
```

## 調査過程

1. サーバ側の Yjs WebSocket (`/yjs`) は正常に動作 — Node.js クライアント2台間で同期テスト成功
2. `y-websocket`, `yjs`, `y-protocols` は `dependencies` に含まれ、vite バンドルにも含まれていた
3. `loadExistingElements()` (REST API) はどこからも呼ばれていない — Yjs に完全に委譲された設計
4. 問題は `yElements.observe()` コールバック内の `if (!api) return` ガード — 初回同期時に API が null

## 影響範囲

- `frontend/src/App.tsx` のみ変更
- サーバ側 (`server.ts`, `yjs-sync.ts`) は変更なし
- 既存の onChange → handleYjsSync フローには影響なし

## 日付

2026-04-21
