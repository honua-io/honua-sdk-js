import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,chmod,rm} from 'node:fs/promises';
const keepAlive=setInterval(()=>{},1000);
const root='/home/mike/honua-io/wt-sdkjs-query-1985-1986';
const work=await mkdtemp('/tmp/honua-sdk1952-');
const prefix='honua-sdk1952-'+randomBytes(5).toString('hex');
const image='ghcr.io/honua-io/honua-server@sha256:785de2ae7f72e6277ce62aa1ece4f08ee0425970b71c47f9f4843c0baae2c8db';
const serverSha='93cad86ec4fb28fba3ff0b9358059d86aa55dde5';
const password='Honua!Aa1'+randomBytes(24).toString('hex'), master=randomBytes(32).toString('base64'), salt=randomBytes(16).toString('base64'), certPassword=randomBytes(16).toString('hex');
const secrets=[password,master,salt,certPassword];
const redact=x=>secrets.reduce((s,v)=>s.replaceAll(v,'[redacted]'),String(x??''));
function command(bin,args,options={}) { const x=spawnSync(bin,args,{encoding:'utf8',timeout:180000,...options}); assert.equal(x.status,0,redact(`${bin} failed: ${x.stderr??''}`).slice(-2000)); return x.stdout.trim(); }
const docker=(args,options)=>command('docker',args,options);
const pg=prefix+'-pg', redis=prefix+'-redis', server=prefix+'-server';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const seed=await readFile(root+'/test/integration/seed/places-roads-v1.sql','utf8');
try {
 command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=honua-sdk1952','-keyout',work+'/key.pem','-out',work+'/cert.pem']);
 command('openssl',['pkcs12','-export','-in',work+'/cert.pem','-inkey',work+'/key.pem','-out',work+'/keyring.p12','-passout','pass:'+certPassword]);
 await chmod(work+'/keyring.p12',0o644);
 docker(['network','create',prefix]);
 docker(['run','-d','--name',pg,'--network',prefix,'-e','POSTGRES_DB=honua','-e','POSTGRES_PASSWORD='+password,'-e','POSTGIS_GDAL_ENABLED_DRIVERS=ENABLE_ALL','postgis/postgis:16-3.4']);
 docker(['run','-d','--name',redis,'--network',prefix,'redis:7-alpine','redis-server','--appendonly','no']);
 let pgReady=false;
 for(let i=0;i<60;i++){ if(spawnSync('docker',['exec',pg,'pg_isready','-h','127.0.0.1','-U','postgres'],{stdio:'ignore'}).status===0){pgReady=true;break;} await sleep(1000); }
 assert.ok(pgReady,'PostgreSQL readiness');
 const sql=input=>docker(['exec','-i',pg,'psql','-U','postgres','-d','honua','-v','ON_ERROR_STOP=1'],{input});
 sql('CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS postgis_raster;');
 const conn=`Server=${pg};Port=5432;Database=honua;User Id=postgres;Password=${password};`;
 const env=['ASPNETCORE_ENVIRONMENT=Production','ASPNETCORE_URLS=http://+:8080','Kestrel__Endpoints__Http__Protocols=Http1AndHttp2','HONUA_ADMIN_PASSWORD='+password,'ConnectionStrings__DefaultConnection='+conn,'ConnectionStrings__honua='+conn,'ConnectionStrings__Redis='+redis+':6379','Security__ConnectionEncryption__MasterKey='+master,'Security__ConnectionEncryption__Salt='+salt,'Operations__SecretChannel__KeyRingCertificatePath=/keyring.p12','Operations__SecretChannel__KeyRingCertificatePassword='+certPassword,'HostValidation__AllowedHosts__0=127.0.0.1','Licensing__Mode=Disabled'];
 docker(['run','-d','--name',server,'--network',prefix,'-p','127.0.0.1::8080','-v',work+'/keyring.p12:/keyring.p12:ro',...env.flatMap(v=>['-e',v]),image]);
 const imageId=docker(['image','inspect',image,'--format','{{.Id}}']);
 assert.equal(docker(['inspect',server,'--format','{{.Image}}']),imageId);
 assert.equal(docker(['image','inspect',image,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}']),serverSha);
 let baseUrl='http://'+docker(['port',server,'8080/tcp']);
 async function waitReady(){for(let i=0;i<90;i++){assert.equal(docker(['inspect',server,'--format','{{.State.Running}}']),'true','server exited before readiness');if(spawnSync('curl',['--max-time','3','--fail','--silent',baseUrl+'/healthz/ready'],{stdio:'ignore',timeout:5000}).status===0)return;await sleep(1000);}throw new Error('server readiness timed out');}
 await waitReady();
 sql(seed);
 const extension=`INSERT INTO features(layer_id,geometry,attributes) SELECT 0, geometry, jsonb_set(attributes,'{name}',to_jsonb('stream-row-' || n)) FROM (SELECT geometry,attributes FROM features WHERE layer_id=0 ORDER BY objectid LIMIT 1) exemplar CROSS JOIN generate_series(1,2500) n;`;
 sql(extension);
 docker(['restart',server]); baseUrl='http://'+docker(['port',server,'8080/tcp']); await waitReady();
 const sourceSha=command('git',['rev-parse','HEAD'],{cwd:root});
 const result=spawnSync('npm',['run','test:integration','--','test/integration/surfaces/grpc.integration.ts'],{cwd:root,encoding:'utf8',timeout:300000,env:{...process.env,HONUA_INTEGRATION_BASE_URL:baseUrl,HONUA_INTEGRATION_API_KEY:password,HONUA_INTEGRATION_SERVICE_ID:'test_service',HONUA_INTEGRATION_LAYER_ID:'0',HONUA_INTEGRATION_COLLECTION_ID:'0',HONUA_INTEGRATION_SERVER_COMMIT:serverSha,HONUA_INTEGRATION_SERVER_IMAGE:image,HONUA_CANDIDATE_CUT_AT:'2026-10-11T02:00:00Z',HONUA_DEPLOYMENT_TARGET:'local-docker',HONUA_DEPLOYMENT_TARGET_OVERRIDE:'local-docker'}});
 await writeFile(work+'/integration.log',redact((result.stdout??'')+'\n'+(result.stderr??'')));
 await writeFile(work+'/diagnostic.json',JSON.stringify({scope:'source-built SDK diagnostic; not installed release certification',sourceSha,builtSourceSha:'9a28ecafa',releaseManifestCommit:'e0a5bb8a',generatedOnlyFollowups:['80200be0c','7b6ad4daa'],serverSha,image,imageId,seedSha256:createHash('sha256').update(seed).digest('hex'),extension,command:'npm run test:integration -- test/integration/surfaces/grpc.integration.ts',exitCode:result.status,log:work+'/integration.log'},null,2));
 console.log(JSON.stringify({work,exitCode:result.status}));
 assert.equal(result.status,0,'gRPC exact candidate integration failed; inspect redacted log');
} catch(error){const logs=spawnSync('docker',['logs',server],{encoding:'utf8'});await writeFile(work+'/startup.log',redact((logs.stdout??'')+'\n'+(logs.stderr??'')));console.error(redact(error.stack));console.error('Diagnostic directory: '+work);process.exitCode=1;} finally {for(const name of [server,redis,pg])spawnSync('docker',['rm','-f',name],{stdio:'ignore'});spawnSync('docker',['network','rm',prefix],{stdio:'ignore'});await rm(work+'/keyring.p12',{force:true});await rm(work+'/key.pem',{force:true});await rm(work+'/cert.pem',{force:true});clearInterval(keepAlive);}
