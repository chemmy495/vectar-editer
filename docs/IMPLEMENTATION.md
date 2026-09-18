# Vectar Editor 実装仕様書

コードとディレクトリの構造、各モジュールの責務、主要な処理の流れをまとめた文書です。
このリポジトリを読む・直す・拡張するときの地図として使ってください。

利用者向けの説明（機能、ビルド方法、キーボード操作、既知の制限）は
[README.md](../README.md) にあります。

- 対象コミット: `c917ff8` 時点
- 規模: TypeScript/CSS/HTML 合計 約 12,800 行（`src` 約 10,900 行、`test` 約 1,900 行）
- テスト: 134 件（`node --test`）

---

## 1. 技術選定

| 項目 | 選択 | 理由 |
| --- | --- | --- |
| デスクトップ基盤 | Electron 33 | Windows 向け単一 exe の配布が容易。描画に Canvas2D をそのまま使える |
| 言語 | TypeScript 5.7（`strict`） | 型で編集操作の不変条件を表現する |
| 実行 | Node 22 のネイティブ型ストリッピング | テストをビルドなしで直接実行できる |
| バンドラ | esbuild | ビルドが数十 ms で終わる。設定が小さい |
| UI | 素の DOM（フレームワークなし） | 描画のホットパスと再描画の粒度を自分で制御したい |
| 実行時依存 | **なし** | `package.json` に `dependencies` の項目自体がない。すべて `devDependencies` |

### 型ストリッピングに伴う制約

Node 22 は `.ts` を型注釈の除去だけで実行します。型以外の意味を持つ構文は使えないため、
`tsconfig.json` で `erasableSyntaxOnly: true` を有効にして機械的に禁止しています。

- **使えない**: `enum`、`namespace`（値を持つもの）、コンストラクタ引数プロパティ、`import =`
- **代わりに**: ユニオン型 + `const` オブジェクト（例: `ToolId`、`CHANNELS`）

あわせて、**相対 import には必ず `.ts` 拡張子を付けます**。
これは Node の ESM 解決・esbuild・`tsc --noEmit`（`allowImportingTsExtensions`）の
3 つすべてが同じ記述で通る唯一の書き方です。

---

## 2. ディレクトリ構造

```
vectar-editer/
├── src/
│   ├── core/                 プラットフォーム非依存。Electron も Node API も使わない
│   │   ├── geometry/         ベクトル・行列・矩形・3次ベジェの数学
│   │   ├── path/             パスのデータモデルと SVG `d` の入出力
│   │   ├── model/            色・スタイル・ノード・レイヤ・文書・問い合わせ・履歴・編集操作
│   │   ├── trace/            画像のベクター化パイプライン
│   │   ├── brush/            フリーハンド入力から輪郭パスへの変換
│   │   ├── render/           シーンの描画（Canvas2D に構造的に型付け）
│   │   └── io/               SVG / PDF / ネイティブ形式の入出力
│   │       ├── svg/
│   │       ├── pdf/
│   │       ├── xml.ts
│   │       └── vectar.ts
│   ├── main/                 Electron メインプロセス
│   └── renderer/             エディタ UI
│       ├── tools/            ツール 1 つ 1 ファイル
│       └── panels/           ツールバー・レイヤ・プロパティ・ステータスバー
├── test/                     単体テスト（node --test が直接実行）
├── scripts/build.mjs         esbuild によるバンドル
├── build/icon.png            アプリアイコン（256x256）
└── docs/                     この文書とスクリーンショット
```

### ファイル一覧（行数つき）

<details>
<summary>src/core</summary>

| ファイル | 行 | 責務 |
| --- | --- | --- |
| `geometry/vec.ts` | 48 | 2次元ベクトル演算 |
| `geometry/matrix.ts` | 155 | アフィン変換、SVG `transform` の解析 |
| `geometry/rect.ts` | 88 | 軸平行矩形 |
| `geometry/bezier.ts` | 241 | 3次ベジェ（評価・分割・厳密な境界・弧長・最近点） |
| `path/path.ts` | 274 | アンカー/ハンドルのパスモデル |
| `path/parse.ts` | 344 | SVG `d` 属性の字句解析と構文解析、円弧→3次変換 |
| `path/serialize.ts` | 46 | SVG `d` 属性の生成 |
| `path/shapes.ts` | 114 | 矩形・楕円・多角形・星・線の生成 |
| `path/build.ts` | 48 | 3次曲線列 → サブパス |
| `model/color.ts` | 139 | RGBA、CSS 色の解析と整形 |
| `model/style.ts` | 113 | Paint / Fill / Stroke / BlendMode |
| `model/node.ts` | 189 | シーンノードの型と生成・複製 |
| `model/document.ts` | 55 | 文書と単位系 |
| `model/query.ts` | 282 | 走査、ワールド変換、境界、ヒットテスト |
| `model/ops.ts` | 491 | 編集操作（すべて `Command` を返す） |
| `model/history.ts` | 149 | Undo/Redo スタックとトランザクション |
| `trace/quantize.ts` | 262 | 色量子化、前処理ブラー |
| `trace/contour.ts` | 165 | 連結成分ラベリング、輪郭追跡 |
| `trace/simplify.ts` | 175 | RDP 簡略化、コーナー検出、平滑化 |
| `trace/fit.ts` | 245 | Schneider の曲線フィッティング |
| `trace/trace.ts` | 213 | ベクター化パイプラインの統合とプリセット |
| `brush/stroke.ts` | 211 | 筆圧ストローク → 輪郭パス |
| `render/render.ts` | 227 | シーン描画 |
| `io/xml.ts` | 214 | 依存なしの XML 読み書き |
| `io/svg/import.ts` | 542 | SVG 読み込み |
| `io/svg/export.ts` | 276 | SVG 書き出し |
| `io/pdf/export.ts` | 260 | PDF 1.4 書き出し |
| `io/vectar.ts` | 277 | ネイティブ形式（JSON）の読み書き |

</details>

<details>
<summary>src/main と src/renderer</summary>

| ファイル | 行 | 責務 |
| --- | --- | --- |
| `main/main.ts` | 194 | ウィンドウ、IPC ハンドラ、ファイルダイアログ |
| `main/menu.ts` | 140 | アプリケーションメニュー |
| `main/preload.ts` | 53 | `window.vectar` ブリッジ |
| `main/ipc.ts` | 64 | チャネル名と payload 型（両プロセスが共有） |
| `renderer/main.ts` | 265 | 起動、コマンド振り分け、ショートカット |
| `renderer/editor.ts` | 402 | 中央の状態（文書・選択・履歴・ツール設定） |
| `renderer/canvas.ts` | 280 | 描画面。描画ループとポインタ入力の分配 |
| `renderer/viewport.ts` | 87 | パン・ズームの座標変換 |
| `renderer/overlay.ts` | 247 | 選択枠・ハンドル・アンカー・グリッドの描画 |
| `renderer/tool.ts` | 19 | `Tool` インタフェース |
| `renderer/tools/select.ts` | 269 | 選択・移動・拡大縮小・回転・矩形選択 |
| `renderer/tools/node.ts` | 344 | アンカーとハンドルの直接編集 |
| `renderer/tools/pen.ts` | 149 | ベジェペン |
| `renderer/tools/freehand.ts` | 144 | 鉛筆とブラシ |
| `renderer/tools/shape.ts` | 146 | 図形ツール（5 種） |
| `renderer/tools/text.ts` | 135 | テキストとその場編集 |
| `renderer/tools/utility.ts` | 116 | ズーム・スポイト・パン |
| `renderer/files.ts` | 555 | 開く・保存・インポート・エクスポート、各ダイアログ |
| `renderer/commands.ts` | 150 | 高水準の編集コマンド |
| `renderer/panels/properties.ts` | 524 | プロパティ・インスペクタ |
| `renderer/panels/layers.ts` | 202 | レイヤ/オブジェクトのツリー |
| `renderer/panels/toolbar.ts` | 48 | ツールストリップ |
| `renderer/panels/statusbar.ts` | 33 | ステータスバー |
| `renderer/dom.ts` | 147 | DOM 生成ヘルパと入力部品 |
| `renderer/dialog.ts` | 95 | モーダル・進捗・メッセージ |
| `renderer/index.html` | 26 | シェル（CSP つき） |
| `renderer/styles.css` | 534 | スタイル |

</details>

---

## 3. レイヤ構造と依存の規則

```
        ┌──────────────────────────────────────┐
        │            src/renderer              │  UI・ツール・パネル
        └───────┬──────────────────────┬───────┘
                │ import               │ import type のみ
                ▼                      ▼
        ┌──────────────┐      ┌────────────────┐
        │   src/core   │      │ src/main/ipc.ts│  チャネル名と payload 型
        └──────────────┘      └───────┬────────┘
                ▲                     │ import
                │ (なし)              ▼
                │              ┌──────────────┐
                └──────────────│   src/main   │  ウィンドウ・メニュー・ダイアログ
                   依存しない   └──────────────┘
```

実測した `core` 内部の依存（循環なし）:

```
core/geometry  →  （依存なし・最下層）
core/path      →  geometry
core/model     →  geometry, path
core/trace     →  geometry, path, model
core/brush     →  geometry, path, trace      ← 輪郭の曲線フィットに trace/fit を使う
core/render    →  geometry, path, model
core/io        →  geometry, path, model
```

### 守っている規則

1. **`core` は `main` も `renderer` も import しない。**
   Electron・Node API への参照は 0 件（実測）。これが `node --test` で
   ビルドなしにテストでき、両プロセスから同じコードを使える理由です。

2. **`core` が参照する環境依存の型は 2 ファイルに限定。**
   - `render/render.ts` — Canvas2D の型名（`CanvasGradient` など）。
     `RenderContext` として**構造的に**型付けしてあり、実行時の依存はありません。
     そのためエディタのキャンバス、エクスポート用のオフスクリーン、
     テスト用のダミーを同じコードで扱えます。
   - `trace/quantize.ts` — `Uint8ClampedArray`（Node にもある標準型）

3. **`renderer` から `main` への import は型だけ。**
   `files.ts` と `main.ts` が `main/ipc.ts` から型のみを取り込みます。
   実行時の通信は必ず `window.vectar`（preload）経由です。
   ここを型で結んでいるのは意図的で、以前レンダラ側が
   ブリッジの型を独自に手書きしていたために Electron 32 での
   `File.path` 削除を型検査が検出できなかったことがあります。

4. **ツールとパネルは 1 機能 1 ファイル。** 相互に import しません。
   連携は必ず `Editor` を経由します。

---

## 4. src/core の詳細

### 4.1 geometry — 数学の基礎

すべて不変（戻り値は新しい値）。

- **`Matrix`** は SVG / Canvas2D と同じ列順 `[a c e; b d f; 0 0 1]`。
  `multiply(n, m)` は「`m` を適用したあとに `n` を適用する」合成です。
  順序を間違えると変換が壊れるため、テストで往復を検証しています。
- **`bezier.bounds`** は制御点の凸包ではなく、**微分の根から厳密な境界**を求めます。
  選択枠の大きさが実際の見た目と一致するために必要です。
- **`bezier.length`** は 16 点 Gauss-Legendre 求積。
  当初、重み表が誤っていて直線長が 2.7 倍になるバグがありました（テストで検出）。

### 4.2 path — パスのデータモデル

```
PathData
└── subpaths: SubPath[]
    ├── closed: boolean
    └── anchors: Anchor[]
        ├── point:      Vec   絶対座標
        ├── inHandle:   Vec   point からの相対オフセット
        ├── outHandle:  Vec   point からの相対オフセット
        └── type: 'corner' | 'smooth' | 'symmetric'
```

**ハンドルを相対で持つ**のが設計の要点です。アンカーを動かすとハンドルが自然に追従し、
変換時も `applyToPoint`（点）と `applyToVector`（方向）を使い分けるだけで済みます。

セグメント `i` は `anchors[i]` から `anchors[i+1]` への 3 次曲線として導出されます
（`segmentAt`）。閉じたサブパスでは末尾から先頭への 1 本が追加されます。

`parse.ts` は SVG `d` 属性の全コマンドに対応します（円弧 `A` は最大 4 本の 3 次曲線へ変換、
`a 10 10 0 0120 0` のようにフラグが区切りなしで詰まった記法も解釈）。
不正なデータは例外を投げず、ブラウザと同様にそこで解釈を打ち切ります。

### 4.3 model — 文書とその編集

```
VectarDocument
├── format: 'vectar', version, name, width, height, unit
├── background: RGBA | null
└── layers: LayerNode[]
        └── children: SceneNode[]

SceneNode = PathNode | GroupNode | LayerNode | TextNode | ImageNode
  共通: id, name, visible, locked, opacity, blendMode, transform
  PathNode  : path, fill, stroke
  Group/Layer: children
  TextNode  : text, x, y, フォント指定, align, fill, stroke
  ImageNode : href（data URL）, x, y, width, height
```

`transform` は**親座標系への写像**です。ワールド座標は祖先の `transform` を
合成して得ます（`query.worldTransform`）。

#### 履歴: スナップショットではなくコマンド

`history.ts` は `{ label, redo, undo }` の組をスタックに積みます。

```ts
export type Command = { label: string; redo: () => void; undo: () => void };
```

文書全体のスナップショットにしなかったのは容量のためです。写真を 1 枚
ベクター化すると数百のパスと数万のアンカーが生まれ、1 ステップごとに
ディープコピーを取ると数十 MB 規模になります。各コマンドは
**自分を巻き戻すのに必要な最小限のデータだけ**を保持します
（例: `transformNodes` は変換前後の行列のみ）。

`model/ops.ts` の関数はすべて `Command` を返し、**自分では適用しません**。
適用するかどうかは呼び出し側（`Editor.run`）が決めます。
複数の操作を 1 ステップにまとめたいときは `history.transaction()` で囲みます
（本文が例外を投げた場合は収集済みのコマンドを巻き戻します）。

`transformNodes` は与えられた行列を**文書座標系のもの**として扱い、
各ノードの親変換の逆行列を挟んで補正します。これによりグループ内の
オブジェクトをドラッグしても、画面上の移動量が指定どおりになります。

### 4.4 trace — 画像のベクター化

```
ImageData8 (RGBA)
      │
      ▼  quantize.blur           任意。JPEG のリンギング対策。
      │                          乗算済みアルファで平均する（透明部の黒が滲まないため）
      ▼  quantize.quantize       中央値分割 → k-means 精緻化 → 画素ごとに最近色を割当
      │                          出力: palette[] と indices（-1 は透明）
      ▼  ─── 色インデックスごとに繰り返し ───
      │
      ├─ contour.maskFor         その色の 2 値マスク
      ├─ contour.labelComponents 8 近傍で連結成分ラベリング（面積つき）
      ├─ contour.traceLoops      画素境界（クラック）追跡で閉ループを全列挙
      │                          ループは所属成分 ID と符号付き面積を持つ
      ├─ simplify.smoothLoop     階段状のギザギザを緩和
      ├─ simplify.simplifyLoop   RDP による頂点削減
      ├─ simplify.findCorners    弧長ウィンドウで曲がり角を測りコーナーを検出
      └─ fit.fitClosedLoop       コーナー間ごとに Schneider フィッティング
      │
      ▼  成分を面積降順に並べ、PathNode を生成（大きい図形が背面）
   TraceResult { nodes, palette, shapeCount, anchorCount, elapsedMs }
```

#### 輪郭追跡が穴を自動で扱う仕組み

`traceLoops` は画素の**間**（クラック）を、常に「塗り画素が進行方向の左」に
なるように歩きます。この不変条件だけで、外周ループと穴のループの
**巻き方向が自然に逆**になります。

```
外周: 反時計回り(符号 -)     穴: 時計回り(符号 +)
```

そのため nonzero 塗りでそのまま正しく描画され、穴の検出・対応付けの
コードが一切不要になります。対角に接する画素を 1 つの図形として扱うため、
分岐時は右折を優先します（前景 8 連結 ⇔ 背景 4 連結の組み合わせ）。

#### コーナー検出はウィンドウで測る

平滑化と簡略化を通すと、直角のコーナーは 45 度 2 回の短い面取りに変わります。
隣接頂点だけを見るとどちらも閾値に届かず、曲線フィットが 2 辺を
またいでしまいます（360x50 の矩形が 364x91 に膨らむ不具合として実際に発生）。
`turnAngle(points, index, window)` は前後に弧長 `window` 分たどった点との
角度を測るため、面取りを越えて本来の曲がり角を復元します。

### 4.5 brush — フリーハンド

```
StrokePoint[] (x, y, pressure)
  → resample        近すぎる点を捨てる（手ぶれ除去）
  → smoothStroke    位置と筆圧を前後 2 方向から平滑化
  → 半幅を決定      筆圧と描画速度から
  → 左右にオフセット 法線方向へ ±半幅
  → キャップ        法線と接線から半円を組み立てる
  → fitCurve        閉じた輪郭に曲線を当て、編集可能なパスにする
```

キャップを「始点・終点の角度差」から作ると内側に巻いてしまい、
輪郭が自己交差して蝶ネクタイ状に潰れます。法線と接線から
`center + cos(t)·normal·r + sin(t)·bulge·r` として組み立てることで、
膨らむ向きが常にストロークの外側になります。

鉛筆（`pencilStrokeToPath`）は中心線を開いたパスとして返し、通常の
ストロークスタイルで描画します。ブラシ（`brushStrokeToPath`）は
閉じた輪郭を塗りで描画します。

### 4.6 render — 描画

`RenderContext` は `CanvasRenderingContext2D` の**必要な部分だけ**を
構造的に定義した型です。実装への依存がないため、同じ `renderDocument` を
エディタの表示、ラスタエクスポート、テストのいずれにも使えます。

グループの `opacity` と `blendMode` は合成結果に効く必要があるため、
子を描く前に一度だけ設定します（子ごとに掛けると重なり部分が濃くなる）。

### 4.7 io — 入出力

| モジュール | 内容 |
| --- | --- |
| `xml.ts` | 依存なしの XML リーダ/ライタ。DOM の `DOMParser` を使わないのは、SVG 読み込みを単体テストとメインプロセスでも動かすため |
| `svg/import.ts` | 図形・パス・グループ・変換・`viewBox` 適合・継承される表示属性・インライン `style`・グラデーション・テキスト・画像。未対応機能は警告として返す |
| `svg/export.ts` | 単体で開ける SVG。グラデーションは `<defs>` に集約、テキストは行ごとの `<tspan>`、id 指定で選択範囲のみ書き出し可 |
| `pdf/export.ts` | PDF 1.4 を直接生成。ラスタ化せずベクターのまま出力。フォントは標準 14 書体に対応付け、半透明は `ExtGState` に写す |
| `vectar.ts` | ネイティブ形式（文書モデルの JSON）。読み込みは**全フィールドを検証**し、壊れたオブジェクトは捨てて警告する |

SVG 読み込みで仕様を意識している点:

- `preserveAspectRatio` の既定は `xMidYMid meet`（等倍で中央寄せ）。`none` のときだけ引き伸ばす
- `gradientUnits` の既定は `objectBoundingBox`。座標は図形の境界に対する比率なので、
  図形の形状が確定したあとに実座標へ写す（`mapPaintToBounds`）
- ルート `<svg>` の表示属性も子に継承する（アイコン素材が真っ黒になるのを防ぐ）
- CSS のカスケードが存在しないので `currentColor` は黒に解決する

---

## 5. src/main — メインプロセス

```
main.ts    BrowserWindow の生成、IPC ハンドラ、ファイルダイアログ、終了時の確認
menu.ts    メニュー定義。各項目は MenuCommand をレンダラへ送るだけ
preload.ts contextBridge で window.vectar を公開
ipc.ts     チャネル名と payload 型（両プロセスが共有する単一の定義）
```

`contextIsolation: true` / `nodeIntegration: false` で、レンダラは Node API に
直接触れません。公開しているのは以下だけです。

| API | 用途 |
| --- | --- |
| `openFile(filter)` | ファイル選択。テキストは UTF-8、画像は base64 で返す |
| `readFile(path, encoding)` | ドラッグ&ドロップされたパスの読み込み |
| `saveFile(request)` | 保存。`{path}` / `{cancelled}` / `{error}` を返す |
| `setTitle(title, dirty)` | ウィンドウタイトル更新 |
| `messageBox(options)` | ネイティブダイアログ |
| `onMenuCommand(handler)` | メニューコマンドの受信 |
| `onRequestClose(handler)` | 終了要求。未保存確認の結果を返す |
| `pathForFile(file)` | `File` の実パス解決。`webUtils` は preload でしか使えない |

### 終了時のハンドシェイク

```
ユーザーがウィンドウを閉じる
  → main: 'close' を preventDefault し requestClose を送る
  → renderer: confirmDiscard()（必要なら保存）
  → renderer: confirmClose(mayClose) を返す
  → main: true なら closeApproved を立てて close() し直す
```

保存の失敗を**例外にしない**のが重要です。`saveFile` が reject すると
この待ち合わせが返らず、ウィンドウが永久に閉じられなくなります。
失敗はダイアログで通知し、`{ error }` として返します。

---

## 6. src/renderer — エディタ UI

### 6.1 状態の置き場所

`Editor`（`editor.ts`）が単一の情報源です。UI 部品は直接やり取りせず、
`Editor` を読み、必要なイベントを購読します。

```
Editor
├── document      VectarDocument
├── history       History
├── viewport      Viewport
├── selection     Set<NodeId>
├── nodeSelection { nodeId, anchors }   ノードツール用
├── activeLayerId
├── tool          ToolId
├── fill / stroke / brush / shapeDefaults   新規オブジェクトの既定値
├── showGrid / snapToGrid / gridSize
├── filePath / dirty / statusMessage
└── clipboard     SceneNode[]
```

イベントは 6 種類だけです。

| イベント | 発火する変化 | 主な購読者 |
| --- | --- | --- |
| `document` | 形状・構造の変更 | canvas, layers, properties, statusbar, title |
| `selection` | 選択の変更 | canvas, layers, properties, statusbar |
| `tool` | ツールの切り替え | canvas, toolbar, properties |
| `view` | パン・ズーム・グリッド | canvas, statusbar |
| `style` | 新規作成時の既定スタイル | canvas, properties |
| `status` | 一時メッセージ | statusbar |

#### dirty フラグは「スタックの深さ」では表せない

保存時点の**コマンドを同一性で記録**します（`history.lastCommand()`）。
深さの比較では、undo して別の編集をすると深さが元に戻るため
「未変更」と誤判定し、さらに上限 300 に達したあとは永久に機能しません。
どちらも未保存の作業を黙って失う挙動になります。

### 6.2 描画とポインタ入力

`CanvasView`（`canvas.ts`）が描画面を所有します。

```
render()
├── setTransform(dpr)                     以降は CSS ピクセル座標
├── 背景を塗る
├── drawCanvasFrame                       ページの枠と影
├── renderDocument(ctx, doc, {            シーン本体
│     viewTransform: compose(scaling(dpr), viewport.matrix())
│   })
├── setTransform(dpr)                     再設定してオーバーレイへ
├── drawGrid                              grid が有効なとき
├── outlineNode                           ホバー中のオブジェクト
├── drawNodeEditingOverlay                ノードツールのとき
└── activeTool.drawOverlay(ctx)           ツール固有のプレビュー
```

シーンは「デバイス比 × ビューポート」で、オーバーレイは
「デバイス比のみ」で描きます。こうするとハンドルやアンカーの大きさが
ズーム倍率に依存せず一定に保たれます。

再描画は `requestRender()` で `requestAnimationFrame` に 1 回だけ束ねます。

**ポインタは必ずキャプチャします。** キャプチャしないと、キャンバス外で
離したドラッグに `pointerup` が届かず、プレビュー変形が適用されたまま
履歴に積まれない状態（取り消し不能かつ未保存扱いにもならない）になります。

入力の優先順位:

```
pointerdown
├── 中ボタン、または Space + 左ボタン → パン
└── それ以外 → キャプチャして activeTool へ

keydown
├── Space            → パンモード
├── activeTool.onKeyDown(event) が true を返したら終了
├── Delete / Escape  → 選択の削除 / 解除
└── 1 文字キー       → ツール切り替え
```

### 6.3 ツール

```ts
export type Tool = {
  id: ToolId;
  cursor: string;
  onPointerDown?(event, point): void;   // point は文書座標
  onPointerMove?(event, point): void;
  onPointerUp?(event, point): void;
  onDoubleClick?(event, point): void;
  onKeyDown?(event): boolean;           // true でグローバル処理を止める
  drawOverlay?(ctx): void;              // 画面座標（CSS px）で描く
  deactivate?(): void;                  // 進行中の作業を確定または破棄
};
```

各ツールは `create*Tool(editor, canvas)` を公開する工場関数として書かれ、
進行中の操作（ジェスチャ）をクロージャ内の判別共用体で持ちます。

```ts
type Gesture =
  | { kind: 'none' }
  | { kind: 'marquee'; origin; current; additive }
  | { kind: 'move'; origin; current; command; ids }
  | { kind: 'scale'; handle; bounds; origin; current; command; ids }
  | { kind: 'rotate'; center; startAngle; current; command; ids };
```

ドラッグ中は「直前のコマンドを undo → 新しい変換を適用」を繰り返し、
離した時点で 1 個だけ履歴に積みます（`applyLive` と `commit`）。

### 6.4 パネル

いずれも `create*Panel(editor, container)` で、購読したイベントで
コンテナを作り直す単純な作りです。

**プロパティパネルには 1 つ注意点があります。** スタイルのライブ更新は
`document` イベントを発火し、このパネル自身がそれを購読しているため、
素朴に作ると**ドラッグ中のスライダーを自分で破棄**してしまいます。
そこで次の仕組みを持ちます。

```
input イベント   → beginInteraction() で再構築を保留し、ライブ適用（履歴には積まない）
change イベント  → 1 ステップとして履歴に積み、再構築を再開
pointerup（窓）  → change が来なくても必ず確定させる保険
```

ライブ値は毎回**ドラッグ開始前の値から**計算します。直前のプレビュー値から
積み上げると変化が累積してしまうためです。

---

## 7. 主要な処理の流れ

### 7.1 画像をインポートしてベクター化する

```
menu: file.importImage
  → renderer/main.ts: runCommand
  → files.importImage()
  → window.vectar.openFile('raster')      main: ダイアログ → base64
  → decodeImage()                          Image → canvas → getImageData
  → showTraceDialog()                      プリセットと各パラメータ
  → showProgress()                         進捗ダイアログ
  → core/trace/trace.traceImage(pixels, options)
  → createGroupNode(result.nodes)          1 グループにまとめる
  → editor.addNodes()                      履歴に 1 ステップとして積む
```

### 7.2 図形を描く

```
pointerdown  shape ツールが原点を記録
pointermove  Shift/Alt を見て矩形を更新 → drawOverlay でプレビュー
pointerup    core/path/shapes で PathData を生成
             → createPathNode に editor.fill / stroke を適用
             → editor.addNodes()
```

### 7.3 保存とエクスポート

```
保存        io/vectar.serializeDocument → window.vectar.saveFile（utf8）
SVG         io/svg/export.exportSvg    → saveFile（utf8）
PDF         io/pdf/export.exportPdf    → base64 → saveFile
PNG/JPEG/   オフスクリーン canvas に renderForExport
WebP        → canvas.toBlob → base64 → saveFile
BMP         PNG 経由で画素を取り出し files.encodeBmp で 24bit BMP を自前生成
            （Canvas API は BMP を出力できない）
```

---

## 8. ビルドとテスト

### ビルド

`scripts/build.mjs` が esbuild で 3 つのバンドルを作ります。

| 入口 | 出力 | 形式 | 備考 |
| --- | --- | --- | --- |
| `src/main/main.ts` | `dist/main/main.js` | cjs | `electron` は external |
| `src/main/preload.ts` | `dist/main/preload.js` | cjs | 同上 |
| `src/renderer/main.ts` | `dist/renderer/main.js` | iife | `index.html` と `styles.css` をコピー |

```
npm run build     1 回ビルド
npm run watch     変更監視
npm start         ビルドして Electron を起動
npm run dist:win  Windows 向け配布物（NSIS インストーラ + 可搬 exe）
```

### テスト

```
npm run check      型検査 → テスト
npm run typecheck  tsc --noEmit
npm test           node --test test/*.test.ts
```

| ファイル | 件数 | 対象 |
| --- | --- | --- |
| `geometry.test.ts` | 11 | 行列の合成・逆行列、ベジェの境界・分割・弧長 |
| `path.test.ts` | 22 | `d` 属性の解析と生成、図形生成、パス操作 |
| `model.test.ts` | 27 | 走査・ヒットテスト・履歴・編集操作 |
| `trace.test.ts` | 29 | 量子化・輪郭・簡略化・フィッティング・パイプライン |
| `brush.test.ts` | 11 | ストローク輪郭、キャップ、筆圧、ブラー |
| `io.test.ts` | 34 | XML、SVG 入出力、PDF 構造、ネイティブ形式 |

テストはビルドを介さず `src` の `.ts` を直接読みます。

UI とメインプロセスは単体テストの対象外です。これらは Xvfb 上で
実際にアプリを起動し、ツールバーをクリックしてポインタイベントを
合成して検証しました（描画、ベクター化、ノード編集、undo/redo、
保存と再読込、3 形式のエクスポート、キャンバス外でのドラッグ解放、
dirty フラグ、スタイルドラッグの確定、終了ハンドシェイク）。

---

## 9. 拡張するときの注意

- **新しいツールを追加する**: `tools/` に `create*Tool` を作り、`ToolId` に
  追加して `renderer/main.ts` で `canvas.registerTool` する。
  ツールバーに載せるには `panels/toolbar.ts` の `TOOL_BUTTONS` に 1 行足す。
  進行中の操作は `deactivate()` で必ず後片付けする。

- **新しい編集操作を追加する**: `model/ops.ts` に `Command` を返す関数として
  書く。自分で `redo()` を呼ばない。`undo` は完全に元へ戻すこと
  （`model.test.ts` は往復を検証している）。

- **新しいノード型を追加する**: `model/node.ts` の `SceneNode` に足すと、
  型の網羅性検査が次の箇所で効くので、型検査が直すべき場所を列挙してくれる。
  `model/node.ts` の `cloneNode`、`model/query.ts` の `localBounds`、
  `render/render.ts` の `drawNode`（内部関数）、`io/svg/export.ts` の `nodeMarkup`、
  `io/pdf/export.ts` の `emitNode`、`io/vectar.ts` の `readNode`。

- **`core` に Electron / Node API を持ち込まない**。持ち込むと単体テストが
  動かなくなり、メインプロセスとレンダラの両方から使えなくなる。

- **`Anchor` のハンドルは相対座標**。絶対座標と混同すると変換で壊れる。

- **相対 import には `.ts` を付ける**。付け忘れると `node --test` が解決に失敗する。

- **`erasableSyntaxOnly`** のため `enum` は使えない。ユニオン型を使う。
