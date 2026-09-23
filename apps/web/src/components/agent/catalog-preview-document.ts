/** Keep published compositions in an opaque iframe, separate from the editor. */
export function catalogPreviewDocument(html: string, play: boolean) {
  const source = JSON.stringify(html).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#171717}hyperframes-player{display:block;width:100%;height:100%}</style></head><body>
<script src="https://cdn.jsdelivr.net/npm/@hyperframes/player@0.8.59/dist/hyperframes-player.global.js"></script>
<script>
const player=document.createElement('hyperframes-player');
player.setAttribute('sandbox-origin','opaque');
player.setAttribute('muted','');
${play ? "player.setAttribute('controls','');player.setAttribute('loop','');" : ""}
player.addEventListener('ready',()=>{
  ${play ? "player.play();" : "player.seek(player.duration*.45);player.pause();"}
  parent.postMessage({type:'catalog-preview-ready'},'*');
});
player.addEventListener('error',()=>parent.postMessage({type:'catalog-preview-error'},'*'));
player.setAttribute('srcdoc',${source});
document.body.append(player);
</script></body></html>`;
}
