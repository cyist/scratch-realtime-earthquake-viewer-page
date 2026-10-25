// docs/index.js (TurboWarp Packager の出力) に含まれる scratch-render の SVGSkin / Silhouette を
// メモリ使用量が少なくなるように書き換えるスクリプト。
// 何度実行しても結果は同じになる (適用済みの場合は何もしない)。
//
// 使い方: npm run optimize-memory
//
// 主な変更点:
// - SVG コスチュームごとに保持していた <canvas> を全 SVG コスチュームで 1 つに共有し、使用後に解放する
//   (1500 個近いコスチュームが各自 canvas を保持していたため、iOS Safari の canvas メモリ上限を超えていた)
// - 当たり判定用シルエットの遅延生成で canvas を参照し続けないようにし、必要になった時だけ SVG から描画する
// - シルエットの解像度に上限を設ける
// - SVG の MIP テクスチャに合計サイズの上限を設け、しばらく使われていないものから破棄する (LRU)
// - モバイル端末では最大テクスチャサイズを 2048 に、描画解像度 (devicePixelRatio) を 2 倍までに抑える

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../docs/index.js", import.meta.url));
const MARKER = "__srevMem";

let src = readFileSync(target, "utf8");
if (src.includes(MARKER)) {
  console.log("already optimized:", target);
  process.exit(0);
}

const replace = (name, from, to) => {
  const count = src.split(from).length - 1;
  if (count !== 1) throw new Error(`${name}: expected exactly 1 match, found ${count}`);
  src = src.replace(from, () => to);
};

// モバイル端末判定 (iPadOS は Mac として振る舞うためタッチ対応で判定)
src = `const ${MARKER}Mobile=typeof navigator<"u"&&(/iPhone|iPad|iPod|Android/.test(navigator.userAgent)||navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1),${MARKER}Dpr=()=>Math.min(window.devicePixelRatio||1,${MARKER}Mobile?2:1/0);\n` + src;

// SVGSkin モジュールの先頭に共有キャンバスとテクスチャ予算管理を追加
const memHelper = `const ${MARKER}=(()=>{const mobile=${MARKER}Mobile,budget=(mobile?96:384)*1048576,minAge=2e3,skins=new Set;let cv=null,total=0;return{mobile,maxSilhouette:mobile?1024:2048,canvas(){return cv||(cv=document.createElement("canvas")),cv},release(){cv&&(cv.width=0,cv.height=0)},add(k,e,b){k._mipBytes||(k._mipBytes=[]),k._mipUsed||(k._mipUsed=[]),k._mipBytes[e]=b,k._mipUsed[e]=performance.now(),total+=b,skins.add(k),total>budget&&this.evict()},touch(k,e){k._mipUsed&&(k._mipUsed[e]=performance.now())},forget(k){if(k._mipBytes)for(const b of k._mipBytes)b&&(total-=b);k._mipBytes=[],k._mipUsed=[],skins.delete(k)},evict(){const now=performance.now(),list=[];for(const k of skins)k._mipBytes.forEach((b,e)=>{b&&now-k._mipUsed[e]>minAge&&list.push([k._mipUsed[e],k,e,b])});list.sort((a,b)=>a[0]-b[0]);for(const[,k,e,b]of list){if(total<=budget)break;const x=k._scaledMIPs[e];x&&k._renderer.gl.deleteTexture(x),delete k._scaledMIPs[e],k._mipBytes[e]=0,total-=b}}}})();`;

replace(
  "svg module header",
  `{loadSvgString:n,serializeSvgToString:a}=c(26),r=c(30);w.exports=class extends i{constructor(d,t){super(d,t),this._svgImage=`,
  `{loadSvgString:n,serializeSvgToString:a}=c(26),r=c(30);${memHelper}w.exports=class extends i{constructor(d,t){super(d,t),this._svgImage=`,
);

// コスチュームごとの canvas を作らない
replace(
  "svg constructor",
  `this._size=[0,0],this._canvas=document.createElement("canvas"),this._context=this._canvas.getContext("2d"),this._scaledMIPs=[]`,
  `this._size=[0,0],this._scaledMIPs=[]`,
);

// 共有キャンバスに描画してテクスチャを作成し、すぐにキャンバスを解放する。
// シルエットは canvas ではなく「SVG を描画する関数」を遅延データとして持つ。
replace(
  "svg createMIP",
  `createMIP(d){const t=this._largestMIPScale<d;t||this._silhouette.unlazy();const[s,e]=this._size;if(this._canvas.width=s*d,this._canvas.height=e*d,this._canvas.width<=0||this._canvas.height<=0||this._svgImage.naturalWidth<=0||this._svgImage.naturalHeight<=0)return super.getTexture();this._context.clearRect(0,0,this._canvas.width,this._canvas.height),this._context.setTransform(d,0,0,d,0,0),this._context.drawImage(this._svgImage,0,0);const l=this._canvas,p={auto:!1,wrap:this._renderer.gl.CLAMP_TO_EDGE,src:l,premultiplyAlpha:!0},y=h.createTexture(this._renderer.gl,p);return t&&(this._silhouette.update(l),this._largestMIPScale=d),y}`,
  `createMIP(d){const t=this._largestMIPScale<d,[s,e]=this._size,l=${MARKER}.canvas();if(l.width=s*d,l.height=e*d,l.width<=0||l.height<=0||this._svgImage.naturalWidth<=0||this._svgImage.naturalHeight<=0)return ${MARKER}.release(),null;const C=l.getContext("2d");C.setTransform(1,0,0,1,0,0),C.clearRect(0,0,l.width,l.height),C.setTransform(d,0,0,d,0,0),C.drawImage(this._svgImage,0,0),C.setTransform(1,0,0,1,0,0);const p={auto:!1,wrap:this._renderer.gl.CLAMP_TO_EDGE,src:l,premultiplyAlpha:!0},y=h.createTexture(this._renderer.gl,p);if(t){const m=this._svgImage,k=Math.min(1,${MARKER}.maxSilhouette/Math.max(l.width,l.height)),W=Math.max(1,Math.round(l.width*k)),H=Math.max(1,Math.round(l.height*k));this._silhouette.update({width:W,height:H,__draw:g=>{g.setTransform(d*W/l.width,0,0,d*H/l.height,0,0),g.drawImage(m,0,0),g.setTransform(1,0,0,1,0,0)}}),this._largestMIPScale=d}return ${MARKER}.release(),y}`,
);

// MIP テクスチャの使用状況を記録し、予算を超えたら古いものから破棄
replace(
  "svg getTexture",
  `return this._svgImageLoaded&&!this._scaledMIPs[e]&&(this._scaledMIPs[e]=this.createMIP(l)),this._scaledMIPs[e]||super.getTexture()}`,
  `if(this._svgImageLoaded&&!this._scaledMIPs[e]){const y=this.createMIP(l);y&&(this._scaledMIPs[e]=y,${MARKER}.add(this,e,Math.max(1,Math.floor(this._size[0]*l))*Math.max(1,Math.floor(this._size[1]*l))*4))}else this._scaledMIPs[e]&&${MARKER}.touch(this,e);return this._scaledMIPs[e]||super.getTexture()}`,
);

replace(
  "svg resetMIPs",
  `resetMIPs(){this._scaledMIPs.forEach(d=>this._renderer.gl.deleteTexture(d)),this._scaledMIPs.length=0,this._largestMIPScale=0}`,
  `resetMIPs(){this._scaledMIPs.forEach(d=>d&&this._renderer.gl.deleteTexture(d)),this._scaledMIPs.length=0,this._largestMIPScale=0,${MARKER}.forget(this)}`,
);

// シルエットの遅延データが描画関数の場合に対応し、作業用キャンバスは使用後に解放する
replace(
  "silhouette unlazy",
  `y.clearRect(0,0,e,l),y.drawImage(this._lazyData,0,0,e,l);const m=y.getImageData(0,0,e,l);this._colorData=m.data}this._lazyData=null}`,
  `y.clearRect(0,0,e,l),this._lazyData.__draw?this._lazyData.__draw(y):y.drawImage(this._lazyData,0,0,e,l);const m=y.getImageData(0,0,e,l);this._colorData=m.data,p.width=p.height=0}this._lazyData=null}`,
);

// モバイル端末では最大テクスチャサイズを抑える
replace(
  "max texture dimension",
  `n.renderer.setMaxTextureDimension&&n.renderer.setMaxTextureDimension(4096)`,
  `n.renderer.setMaxTextureDimension&&n.renderer.setMaxTextureDimension(${MARKER}Mobile?2048:4096)`,
);

// モバイル端末では描画解像度を抑える (ステージ・ペンレイヤー・コスチュームのテクスチャが小さくなる)
replace(
  "renderer resize",
  `resize(P,H){const{canvas:W}=this._gl,L=window.devicePixelRatio||1,`,
  `resize(P,H){const{canvas:W}=this._gl,L=${MARKER}Dpr(),`,
);
replace(
  "renderer overlays",
  `W=this.canvas.width/window.devicePixelRatio,L=this.canvas.height/window.devicePixelRatio;`,
  `W=this.canvas.width/${MARKER}Dpr(),L=this.canvas.height/${MARKER}Dpr();`,
);

writeFileSync(target, src);
console.log("optimized:", target);
