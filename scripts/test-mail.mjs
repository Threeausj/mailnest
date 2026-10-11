#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'mailnest-tls-'));
const container = `mailnest-test-${randomUUID().slice(0, 8)}`;
let started = false;
async function command(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, ...options });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${binary} failed (${code}): ${output}`)));
  });
}
async function ready(port) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const connected = await new Promise(resolve => {
      const socket = connect({host:'127.0.0.1', port});
      socket.setTimeout(500);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('GreenMail TLS fixture did not start.');
}
try {
  await command('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',join(temporary,'key.pem'),'-out',join(temporary,'cert.pem'),'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
  await command('openssl', ['pkcs12','-export','-inkey',join(temporary,'key.pem'),'-in',join(temporary,'cert.pem'),'-out',join(temporary,'greenmail.p12'),'-passout','pass:MailnestTestKeystore2026']);
  await chmod(temporary,0o755);
  await chmod(join(temporary,'greenmail.p12'),0o644);
  console.log('Starting isolated GreenMail TLS fixture (first run downloads the image)…');
  await command('docker', ['run','-d','--name',container,'-p','127.0.0.1::3993','-p','127.0.0.1::3465','-v',`${temporary}/greenmail.p12:/home/greenmail/greenmail.p12:ro`,'-e','GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=alpha:MailnestWirePassword2026@mailnest.test,beta:MailnestWirePassword2026@mailnest.test -Dgreenmail.users.login=email -Dgreenmail.tls.keystore.file=/home/greenmail/greenmail.p12 -Dgreenmail.tls.keystore.password=MailnestTestKeystore2026','greenmail/standalone:2.1.14']);
  started = true;
  const port = async protocol => Number((await command('docker',['port',container,protocol])).split(':').at(-1));
  const imapPort = await port('3993/tcp'), smtpPort = await port('3465/tcp');
  await ready(imapPort);
  await ready(smtpPort);
  await command(process.execPath,['--import','tsx','--test','tests/mail.integration.ts'],{
    stdio:'inherit',
    env:{...process.env,MAIL_TEST_ENABLED:'true',MAIL_TEST_HOST:'localhost',MAIL_TEST_IMAP_PORT:String(imapPort),MAIL_TEST_SMTP_PORT:String(smtpPort),NODE_EXTRA_CA_CERTS:join(temporary,'cert.pem')},
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (started) await command('docker',['rm','-f',container]).catch(() => {});
  await rm(temporary,{recursive:true,force:true});
}
