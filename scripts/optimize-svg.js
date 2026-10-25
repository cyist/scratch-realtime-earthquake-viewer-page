// docs/assets 内の SVG コスチュームのパスデータ (d 属性) の小数精度を落として軽量化するスクリプト。
// SVG が小さくなると、ブラウザがデコードして保持する SVG 画像のメモリも減る。
// 色・viewBox・transform などは変更しない (配色の置換が色の文字列に依存しているため)。
// 変更したファイルは新しい md5 のファイル名で保存し、project.json の参照も更新する。
//
// 使い方: npm run optimize-svg

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { optimize } from "svgo";

const assetsDir = fileURLToPath(new URL("../docs/assets/", import.meta.url));
const projectPath = assetsDir + "project.json";
// 地図は最大 8 倍程度に拡大して描画されるため、0.001 単位の誤差は描画上ほぼ影響しない
const FLOAT_PRECISION = 3;

const project = JSON.parse(readFileSync(projectPath, "utf8"));
const renamed = new Map();
let before = 0;
let after = 0;

for (const target of project.targets) {
  for (const costume of target.costumes) {
    if (costume.dataFormat !== "svg") continue;
    const oldName = costume.md5ext;
    if (!renamed.has(oldName)) {
      const original = readFileSync(assetsDir + oldName, "utf8");
      const { data } = optimize(original, {
        multipass: false,
        js2svg: { pretty: false },
        plugins: [
          {
            name: "convertPathData",
            params: {
              floatPrecision: FLOAT_PRECISION,
              applyTransforms: false,
              applyTransformsStroked: false,
              makeArcs: false,
              straightCurves: false,
              convertToQ: false,
              lineShorthands: true,
              convertToZ: false,
              curveSmoothShorthands: true,
              removeUseless: false,
              collapseRepeated: true,
              utilizeAbsolute: true,
              forceAbsolutePath: false,
            },
          },
        ],
      });
      before += Buffer.byteLength(original);
      if (data.length >= original.length) {
        renamed.set(oldName, oldName);
        after += Buffer.byteLength(original);
        continue;
      }
      after += Buffer.byteLength(data);
      const md5 = createHash("md5").update(data).digest("hex");
      const newName = `${md5}.svg`;
      writeFileSync(assetsDir + newName, data);
      renamed.set(oldName, newName);
    }
    const newName = renamed.get(oldName);
    costume.assetId = newName.slice(0, -4);
    costume.md5ext = newName;
  }
}

writeFileSync(projectPath, JSON.stringify(project));

const stillUsed = new Set(renamed.values());
for (const [oldName, newName] of renamed) {
  if (oldName !== newName && !stillUsed.has(oldName) && existsSync(assetsDir + oldName)) unlinkSync(assetsDir + oldName);
}

const mb = (n) => (n / 1048576).toFixed(2) + "MB";
console.log(`SVG: ${mb(before)} -> ${mb(after)} (${renamed.size} files)`);
