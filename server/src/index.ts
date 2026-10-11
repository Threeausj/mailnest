import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { loadConfig, repoRoot } from './config.js';
import { buildApp } from './app.js';

dotenv.config({path:resolve(repoRoot,'.env'),quiet:true});
try {
  const config=loadConfig();
  const {app}=await buildApp(config);
  let shuttingDown=false;
  const shutdown=async()=>{if(shuttingDown)return;shuttingDown=true;await app.close();};
  process.once('SIGINT',()=>{void shutdown();});process.once('SIGTERM',()=>{void shutdown();});
  await app.listen({port:config.port,host:config.host});
  console.log(`MailNest API listening at ${config.host}:${config.port}`);
}catch(error){console.error(error instanceof Error?error.message:'MailNest startup failed.');process.exitCode=1;}
