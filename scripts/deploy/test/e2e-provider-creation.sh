#!/usr/bin/env bash
# Two backend Node processes against a disposable, explicitly owned PostgreSQL fixture.
set -euo pipefail
PROJECT=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) PROJECT=${2:-}; shift 2 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[ "$PROJECT" = me-e2e ] || { printf '%s\n' '--project me-e2e is required' >&2; exit 2; }
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
OWNER=$(node -e 'process.stdout.write(require("crypto").randomUUID())')
NAME="$PROJECT-provider-${OWNER:0:8}"
LABEL=com.mailexpert.e2e.provider-creation
CID=''
owned() {
  [ -n "$CID" ] && [ "$(docker inspect --format "{{index .Config.Labels \"$LABEL\"}}" "$CID")" = "$OWNER" ] &&
    [ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$CID")" = "$PROJECT" ]
}
cleanup() {
  status=$?
  if [ -n "$CID" ]; then
    if owned; then docker rm -fv "$CID" >/dev/null; else printf '%s\n' 'refusing cleanup: ownership changed' >&2; status=1; fi
  fi
  exit "$status"
}
trap cleanup EXIT
docker info >/dev/null
if docker container inspect "$NAME" >/dev/null 2>&1; then printf '%s\n' 'fixture name already exists' >&2; exit 1; fi
CID=$(docker run -d --name "$NAME" --label "$LABEL=$OWNER" --label "com.docker.compose.project=$PROJECT" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=provider_race -e POSTGRES_USER=provider_race \
  -p 127.0.0.1::5432 postgres:16-alpine)
owned || { printf '%s\n' 'fixture ownership check failed' >&2; exit 1; }
for _ in $(seq 60); do
  if docker exec "$CID" pg_isready -U provider_race -d provider_race >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$CID" pg_isready -U provider_race -d provider_race >/dev/null
BINDING=$(docker port "$CID" 5432/tcp)
[[ $BINDING =~ ^127\.0\.0\.1:([0-9]+)$ ]] || { printf '%s\n' 'fixture must bind only loopback' >&2; exit 1; }
export DB_HOST=127.0.0.1 DB_PORT=${BASH_REMATCH[1]} DB_NAME=provider_race DB_USER=provider_race
unset DB_PASSWORD
export ENCRYPTION_KEY=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
if command -v cygpath >/dev/null 2>&1; then ROOT=$(cygpath -m "$ROOT"); fi
owned || exit 1
node --input-type=module - "$ROOT" <<'NODE'
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const moduleUrl = path => pathToFileURL(`${root}/backend/src/${path}`).href;
const { pool, query } = await import(moduleUrl('services/db.js'));
const { runMigrations } = await import(moduleUrl('services/migrations.js'));
const { withAccountAddressLock } = await import(moduleUrl('services/accounts/connection.js'));
const workerSource = `
  import {pathToFileURL} from 'node:url';
  import {randomUUID} from 'node:crypto';
  import {mock} from 'node:test';
  const root=process.argv[1], kind=process.argv[2], email=process.argv[3];
  const url=p=>pathToFileURL(root+'/backend/src/'+p).href;
  // Public Node test mocking replaces only MailExpert's network probe boundary.
  // Database connections, locks, request ledger, encryption and INSERT are real.
  mock.module(url('services/accounts/connectionProbe.js'),{namedExports:{probeConnection:async c=>({imapLogin:c.auth_user,smtpLogin:c.smtp_auth_user||c.auth_user})}});
  const {pool,withTransaction}=await import(url('services/db.js'));
  const {createVerifiedAccount}=await import(url('services/accounts/accountCreation.js'));
  const {parseManualCreate,parseProviderCreate}=await import(url('services/accounts/createRequest.js'));
  const {withAccountAddressLock}=await import(url('services/accounts/connection.js'));
  const {createManualAccount,persistManualAccount}=await import(url('services/accounts/manualAccounts.js'));
  const {auditWritesSettled}=await import(url('services/auditLog.js'));
  const candidate={name:'Race',email_address:email,imap_host:'203.0.113.10',imap_port:993,smtp_host:'203.0.113.10',smtp_port:587,smtp_tls:'STARTTLS',auth_user:'race@example.com',auth_pass:'fixture-password'};
  const actor={via:'cli'};
  process.send('ready');
  await new Promise(resolve=>process.once('message',resolve));
  try {
    const parsed=kind==='verified-preset' ? parseProviderCreate({provider:'yahoo',email,appPassword:'fixture-password'}) : parseManualCreate(candidate);
    const result=kind.startsWith('verified-') ? await createVerifiedAccount(parsed.candidate,{userId:'70000000-0000-4000-8000-000000000001'},{provider:parsed.provider,mode:parsed.mode,requestId:randomUUID()}) : kind==='manual' ? await createManualAccount(candidate,actor,{trustedLegacy:true}) :
      await withTransaction(client=>withAccountAddressLock(email,async()=>{
        const existing=await client.query('SELECT id FROM email_accounts WHERE lower(btrim(email_address))=lower(btrim($1))',[email]);
        if(existing.rows.length)return {error:'already_connected'};
        return persistManualAccount(candidate,actor,{client,provider:'gmail',mode:'managed',imapTlsMode:'implicit'});
      },{client}));
    await auditWritesSettled();
    process.send({outcome:result.account?'created':result.error});
  } finally {await pool.end();process.disconnect();}
`;
const workers = new Set();
function worker(kind, email) {
  const child=spawn(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',workerSource,root,kind,email],{stdio:['ignore','ignore','pipe','ipc'],env:process.env,windowsHide:true});
  workers.add(child);
  let outcome, stderr='';
  child.stderr.on('data', data=>{stderr+=data;});
  const ready=new Promise((resolve,reject)=>{child.once('error',reject);child.once('message',resolve);});
  const done=new Promise((resolve,reject)=>{
    child.on('message',message=>{if(message?.outcome)outcome=message.outcome;});
    child.once('error',reject);
    child.once('exit',code=>{workers.delete(child);if(code===0&&outcome)resolve(outcome);else reject(new Error(`worker failed (exit ${code}): ${stderr}`));});
  });
  return {child,ready,done};
}
let timer;
try {
  await runMigrations();
  await query("INSERT INTO users (id,username) VALUES ('70000000-0000-4000-8000-000000000001','race-employee')");
  const fixture=await query('SELECT current_database() AS db, current_user AS actor');
  assert.deepEqual(fixture.rows,[{db:'provider_race',actor:'provider_race'}]);
  await Promise.race([(async()=>{
    for (const kinds of [['verified-manual','verified-preset'],['verified-preset','transaction'],['manual','verified-manual'],['manual','manual'],['manual','transaction'],['transaction','manual']]) {
      await query('DELETE FROM email_accounts');
      const left=worker(kinds[0],' Race@Example.com '),right=worker(kinds[1],'race@example.com');
      await Promise.all([left.ready,right.ready]);
      await withAccountAddressLock('RACE@example.com',async()=>{
        left.child.send('go');right.child.send('go');
        // Both real processes must be held by the parent session lock, including xact callers.
        await new Promise(resolve=>setTimeout(resolve,350));
        assert.equal((await query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n,0);
      });
      assert.deepEqual((await Promise.all([left.done,right.done])).sort(),['already_connected','created']);
      assert.equal((await query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n,1);
      console.log(`[provider-race] PASS ${kinds.join('/')} canonical address: one inserted row`);
    }
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('race fixture timed out')),30000);})]);
} finally {
  clearTimeout(timer);
  for(const child of workers)child.kill();
  await pool.end();
}
NODE
printf '%s\n' '[provider-race] PASS owned PostgreSQL fixture; cleanup verified'
