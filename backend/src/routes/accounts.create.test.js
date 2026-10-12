import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createRealSchemaDb } from '../services/testing/realSchema.js';
const state = vi.hoisted(() => ({db: null}));
vi.mock('../services/db.js', () => ({query:(s,p)=>state.db.query(s,p), pool:{connect:async()=>({query:(s,p)=>state.db.query(s,p),release(){}})}}));
vi.mock('../index.js', () => ({imapManager:{connectAccount:vi.fn(async()=>true)}}));
vi.mock('../services/accounts/connectionProbe.js', () => ({probeConnection:vi.fn(async c=>({imapLogin:c.auth_user,smtpLogin:c.smtp_auth_user}))}));
vi.mock('../services/encryption.js', () => ({encrypt:v=>v ? 'enc:'+v:null,decrypt:v=>v}));
vi.mock('../services/redis.js', () => ({redisClient:{incr:async()=>{throw new Error('offline');},del:async()=>{}}}));
vi.mock('../services/auditLog.js', () => ({recordAudit:vi.fn()}));
vi.mock('../plugins/registry.js',()=>({pluginRegistry:{collectHook:vi.fn(async()=>[])}}));
import accountRoutes from './accounts.js';
import providerRoutes from './accountProviders.js';
import {createIdentityGate} from '../middleware/identityGate.js';
import {requireCsrfHeader} from '../middleware/csrf.js';
import {probeConnection} from '../services/accounts/connectionProbe.js';
import {reset} from '../services/rateLimiter.js';
import {imapManager} from '../index.js';
import {recordAudit} from '../services/auditLog.js';
const USER='70000000-0000-4000-8000-000000000001';
const BODY={provider:'yahoo',email_address:' Team@Example.com ',imap_host:'imap.example.com',smtp_host:'smtp.example.com',auth_pass:'secret'};
let server, base;
beforeAll(async()=>{
 state.db=await createRealSchemaDb();
 await state.db.query("INSERT INTO users (id,username,email,is_admin) VALUES ($1,'employee','employee@example.com',false)",[USER]);
 const app=express();app.use(express.json());
 app.use((req,_res,next)=>{req.session={userId:req.get('x-test-user'),authMethod:'google',destroy:fn=>fn()};next();});
 app.use(createIdentityGate({getSettings:()=>({mode:'google'})}));
 app.use(requireCsrfHeader);
 app.use('/api/accounts/provider',providerRoutes);app.use('/api/accounts',accountRoutes);
 server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s));});base=`http://127.0.0.1:${server.address().port}`;
});
afterAll(async()=>{await new Promise(resolve=>server.close(resolve));await state.db.close();});
beforeEach(async()=>{
 vi.clearAllMocks();await reset(`account-create:${USER}`);
 await state.db.exec('DELETE FROM account_creation_requests; DELETE FROM email_accounts');
 probeConnection.mockImplementation(async c=>({imapLogin:c.auth_user,smtpLogin:c.smtp_auth_user}));
});
const post=(body=BODY,{path='/api/accounts',user=USER,csrf=true,key=randomUUID()}={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,...(user?{'x-test-user':user}:{}),...(csrf?{'X-Requested-With':'MailExpert'}:{})},body:JSON.stringify(body)});
it('approved_employee_creates_manual_mailbox',async()=>{
 const res=await post();expect(res.status).toBe(200);
 const account=await res.json();expect(account).toMatchObject({email_address:'team@example.com',mail_provider:'yahoo',connection_mode:'manual',imap_tls_mode:'implicit'});
 expect(account).not.toHaveProperty('auth_pass');expect(account).not.toHaveProperty('oauth_access_token');
 expect((await state.db.query('SELECT count(*)::int AS n FROM email_accounts')).rows).toEqual([{n:1}]);
 expect(imapManager.connectAccount).toHaveBeenCalledOnce();
 expect((await state.db.query('SELECT thread_mode FROM email_accounts')).rows[0].thread_mode).toBe('rfc');
});
it.each([null,'70000000-0000-4000-8000-000000000099'])('unapproved_and_anonymous_cannot_create (%s)',async user=>{
 expect((await post(BODY,{user})).status).toBe(401);expect(probeConnection).not.toHaveBeenCalled();
});
it('requires CSRF before connecting',async()=>{expect((await post(BODY,{csrf:false})).status).toBe(403);expect(probeConnection).not.toHaveBeenCalled();});
it.each(['mail_provider','connection_mode','mail_node','oauth_provider','oauth_access_token','proton_user_id'])('server_only_fields_refused_before_connect: %s',async field=>{
 expect((await post({...BODY,[field]:'forged'})).status).toBe(400);expect(probeConnection).not.toHaveBeenCalled();
 expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({action:'mailbox.connection_failed'}));
});
it('smtp_failure_has_no_insert',async()=>{
 probeConnection.mockRejectedValueOnce(Object.assign(new Error('raw secret'),{code:'smtp_auth_failed'}));
 const res=await post();expect(res.status).toBe(400);expect(await res.json()).toEqual({error:'smtp_auth_failed',code:'smtp_auth_failed'});
 expect((await state.db.query('SELECT count(*)::int AS n FROM email_accounts')).rows[0].n).toBe(0);
});
it('advanced_preset_uses_manual_policy and cross-route duplicate is refused',async()=>{
 expect((await post()).status).toBe(200);
 const res=await post({provider:'yahoo',email:'TEAM@example.com',appPassword:'secret'},{path:'/api/accounts/provider'});
 expect(res.status).toBe(409);expect((await res.json()).code).toBe('already_connected');expect(probeConnection).toHaveBeenCalledOnce();
});
it('the sixth attempt across both routes is refused before probing',async()=>{
 probeConnection.mockRejectedValue(Object.assign(new Error('refused'),{code:'smtp_auth_failed'}));
 for(let i=0;i<5;i++) expect((await post()).status).toBe(400);
 expect((await post({provider:'yahoo',email:'team@example.com',appPassword:'secret'},{path:'/api/accounts/provider'})).status).toBe(429);
 expect(probeConnection).toHaveBeenCalledTimes(5);
});
it('replays the safe result without reconnecting or probing again',async()=>{
 const key=randomUUID();const first=await(await post(BODY,{key})).json();const second=await(await post(BODY,{key})).json();
 expect(second.id).toBe(first.id);expect(probeConnection).toHaveBeenCalledOnce();expect(imapManager.connectAccount).toHaveBeenCalledOnce();
});
it.each(['yahoo','yandex','mailru','icloud'])('connects fixed provider %s',async provider=>{
 const res=await post({provider,email:'team@example.com',appPassword:'secret'},{path:'/api/accounts/provider'});
 expect(res.status).toBe(200);expect(await res.json()).toMatchObject({mail_provider:provider,connection_mode:'preset'});
});
it.each([{imap_host:'127.0.0.1'},{provider:'proton'},{login:'bad\r\nBcc: victim@example.com'}])('refuses invalid fixed-provider input before connect: %j',async patch=>{
 expect((await post({provider:'yahoo',email:'team@example.com',appPassword:'secret',...patch},{path:'/api/accounts/provider'})).status).toBe(400);
 expect(probeConnection).not.toHaveBeenCalled();
});

it('durable same-key replays do not consume password attempts', async () => {
 const key=randomUUID();const first=await(await post(BODY,{key})).json();
 for(let i=0;i<6;i++) {
  const res=await post(BODY,{key});expect(res.status).toBe(200);expect((await res.json()).id).toBe(first.id);
 }
 expect(probeConnection).toHaveBeenCalledOnce();
});
