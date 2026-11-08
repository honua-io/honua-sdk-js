import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../..");

export async function startCatalogComponentsServer() {
  const bundle = await build({
    entryPoints: [path.join(root, "src/catalog-components/index.ts")],
    bundle: true, write: false, format: "esm", target: "es2022",
  });
  const fixtures = JSON.parse(fs.readFileSync(path.join(directory, "catalog-mock-fixtures.json"), "utf8"));
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'");
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/components.js") return send(response, "text/javascript", bundle.outputFiles[0].text);
    if (pathname === "/catalog.css") return send(response, "text/css", fs.readFileSync(path.join(root, "src/catalog-components/catalog.css")));
    if (pathname === "/fixtures.json") return send(response, "application/json", JSON.stringify(fixtures));
    if (pathname === "/fixture.js") return send(response, "text/javascript", `
      import { defineCatalogComponents } from '/components.js';
      const fixtures = await (await fetch('/fixtures.json')).json();
      defineCatalogComponents({enabled:true});
      const items = fixtures.responses.publicAnonymous.items.map(item => ({
        ...item, detailHref: new URL(item.detailHref, location.origin).href, thumbnail:null
      }));
      const client = {
        async listCatalog(query) {
          const filtered = items.filter(item => (!query.q || item.title.toLowerCase().includes(query.q.toLowerCase())) && (!query.kind || query.kind.includes(item.kind)));
          return {...fixtures.responses.publicAnonymous, items:filtered.slice(query.offset, query.offset+query.limit), total:filtered.length, offset:query.offset, limit:query.limit};
        },
        async getCatalogItem({kind,id}) { return id === fixtures.serviceDetail.id ? {...fixtures.serviceDetail,endpoints:fixtures.serviceDetail.endpoints.map((endpoint,index)=>({...endpoint,href:index ? endpoint.href : new URL('/services/'+'roads-'.repeat(60)+'/wms?SERVICE=WMS&REQUEST=GetCapabilities',location.origin).href}))} : items.find(item => item.kind===kind && item.id===id); },
        async listCatalogAppsUsing(query) {
          const page = fixtures.responses.serviceUsedBy;
          return {...page, subject:{kind:query.kind,id:query.id}, offset:query.offset,limit:query.limit,
            items:page.items.slice(query.offset,query.offset+query.limit).map(item=>({...item,detailHref:new URL(item.detailHref,location.origin).href,thumbnail:null}))};
        }
      };
      document.querySelectorAll('honua-catalog-search,honua-service-endpoints,honua-apps-using').forEach(element=>element.client=client);
      window.fixtureReady=true;
    `);
    if (pathname === "/") return send(response, "text/html", `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Catalog components fixture</title><link rel="stylesheet" href="/catalog.css"><script type="module" src="/fixture.js"></script></head><body><main><h1>Catalog fixture preview</h1><honua-catalog-search catalog="open-data" limit="2"></honua-catalog-search><honua-service-endpoints catalog="open-data" service="park-service" copy></honua-service-endpoints><honua-apps-using catalog="open-data" service="park-service" limit="1"></honua-apps-using></main></body></html>`);
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function send(response, type, contents) {
  response.writeHead(200, { "Content-Type": type });
  response.end(contents);
}
