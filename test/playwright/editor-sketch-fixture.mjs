import { createServer } from "node:http";
import { build } from "esbuild";

/** Real component and renderer; only persistence is an explicit isolated double. */
export async function startEditorSketchFixture() {
  const sdkRoot = process.env.HONUA_EDITOR_CONTROL_PACKAGE_ROOT;
  const source = sdkRoot ? `${sdkRoot}/dist/src` : './src';
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { Map } from 'maplibre-gl';
        import { createFeatureEditorWorkflow } from ${JSON.stringify(`${source}/web-components/feature-editor-workflow.${sdkRoot ? 'js' : 'ts'}`)};
        import { createTerraDrawEditorSketch } from ${JSON.stringify(`${source}/web-components/feature-editor-sketch.${sdkRoot ? 'js' : 'ts'}`)};
        import { defineHonuaFeatureEditor } from ${JSON.stringify(`${source}/web-components/feature-editor.${sdkRoot ? 'js' : 'ts'}`)};
        const map = new Map({container:'map',style:{version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#e0e0e0'}}]},center:[0,0],zoom:12});
        await new Promise(resolve=>map.on('load',resolve));
        defineHonuaFeatureEditor();
        const capabilities = new Set(['query','applyEdits']);
        const calls = [];
        const source = {descriptor:{id:'owned-control',protocol:'geoservices-feature-service',locator:{url:'https://control.invalid/FeatureServer/0'},capabilities,schema:{fields:[{name:'label',type:'esriFieldTypeString'}],primaryKey:'OBJECTID'}},capabilities,
          applyEdits:async envelope=>{calls.push(envelope);return {added:envelope.adds?.length?[{id:7,success:true}]:[],updated:envelope.updates?.length?[{id:7,success:true}]:[],deleted:[]};}};
        const workflow = createFeatureEditorWorkflow({source});
        const editor = document.querySelector('honua-feature-editor');
        editor.workflow = workflow;
        const adapter = await createTerraDrawEditorSketch(map,{workflow,modes:['point','select']});
        workflow.cancel();
        editor.addEventListener('honua-feature-edit-commit',event=>{
          if(event.detail.commit.status==='committed') {
            const geometry=workflow.snapshot().sketch.geometry;
            workflow.setSelection({id:7,attributes:{label:'owned'},geometry});
          }
        });
        window.editorSketchObservation=()=>({snapshot:workflow.snapshot(),calls:calls.length});
        window.addEventListener('pagehide',()=>{adapter.stop();map.remove();});
        document.body.dataset.ready='true';
      `,
    },
    bundle: true, write: false, format: "esm", platform: "browser", external: ["pmtiles"], nodePaths: [`${process.cwd()}/node_modules`],
  });
  const server = createServer((request, response) => {
    response.setHeader("content-type", request.url === "/fixture.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/fixture.js" ? bundle.outputFiles[0].text : `<!doctype html><style>body{margin:0}#map{position:absolute;left:0;top:0;width:700px;height:700px}honua-feature-editor{position:absolute;left:710px;top:0;width:350px}.maplibregl-canvas{position:absolute;left:0;top:0}</style><div id="map"></div><honua-feature-editor></honua-feature-editor><script type="module" src="/fixture.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
